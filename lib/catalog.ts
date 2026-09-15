// Pure scoring logic lives in ./catalogMatching so it can also be imported
// directly by scripts/backfill-catalog-matches.js without any bundler.
export {
  CATALOG_CONFIDENCE_THRESHOLDS,
  normalizeCatalogText,
  findCatalogMatches,
  hasAmbiguousHighConfidenceMatch,
  addVariantMatch,
} from "./catalogMatching";
export type {
  CatalogStatus,
  CatalogAttributes,
  CatalogProduct,
  CatalogProductVariant,
  CatalogVariantCandidate,
  CatalogMatchCandidate,
  CatalogMatchInput,
  CatalogMatch,
  ResolvedCatalogMatch,
} from "./catalogMatching";
import {
  CATALOG_CONFIDENCE_THRESHOLDS,
  normalizeCatalogText,
  findCatalogMatches,
  hasAmbiguousHighConfidenceMatch,
  addVariantMatch,
} from "./catalogMatching";
import type {
  CatalogProduct,
  CatalogProductVariant,
  CatalogVariantCandidate,
  CatalogMatchCandidate,
  CatalogMatchInput,
  ResolvedCatalogMatch,
} from "./catalogMatching";

export type CatalogCategory = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  sort_order: number;
  created_at: string;
};

export type CatalogSubcategory = {
  id: string;
  category_id: string;
  parent_subcategory_id: string | null;
  slug: string;
  name: string;
  description: string | null;
  sort_order: number;
  created_at: string;
};

export type CatalogBrand = {
  id: string;
  slug: string;
  name: string;
  website_url: string | null;
  logo_url: string | null;
  description: string | null;
  created_at: string;
};

export type CatalogProductFamily = {
  id: string;
  brand_id: string;
  subcategory_id: string | null;
  slug: string;
  name: string;
  description: string | null;
  created_at: string;
};

function asRows<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : []) as T[];
}

export async function findCatalogMatch(
  input: CatalogMatchInput
): Promise<ResolvedCatalogMatch | null> {
  const { supabase } = await import("./supabase");
  const normalizedBrand = normalizeCatalogText(input.brand);
  const normalizedCategory = normalizeCatalogText(input.category);
  if (!normalizedBrand || !normalizeCatalogText(input.title)) return null;

  const { data: brandRows, error: brandError } = await supabase
    .from("catalog_brands")
    .select("id, name")
    .or(`name.ilike.%${normalizedBrand}%,slug.eq.${normalizedBrand}`)
    .limit(10);
  if (brandError) throw brandError;

  const brands = asRows<{ id: string; name: string }>(brandRows);
  const { data: brandAliasRows, error: brandAliasError } = await supabase
    .from("catalog_aliases")
    .select("entity_id")
    .eq("entity_type", "brand")
    .eq("normalized_alias", normalizedBrand)
    .limit(10);
  if (brandAliasError) throw brandAliasError;

  const brandIds = Array.from(
    new Set([
      ...brands.map((brand) => brand.id),
      ...asRows<{ entity_id: string }>(brandAliasRows).map((row) => row.entity_id),
    ])
  );
  if (!brandIds.length) return null;

  let subcategoryIds: string[] | null = null;
  let categoryNames = new Map<string, string>();
  if (normalizedCategory) {
    const { data: categoryRows, error: categoryError } = await supabase
      .from("catalog_categories")
      .select("id, slug, name");
    if (categoryError) throw categoryError;
    const categoryIds = asRows<{ id: string; slug: string; name: string }>(categoryRows)
      .filter(
        (category) =>
          normalizeCatalogText(category.slug) === normalizedCategory ||
          normalizeCatalogText(category.name) === normalizedCategory
      )
      .map((category) => category.id);
    if (categoryIds.length) {
      const { data: subcategoryRows, error: subcategoryError } = await supabase
        .from("catalog_subcategories")
        .select("id, category_id, name")
        .in("category_id", categoryIds);
      if (subcategoryError) throw subcategoryError;
      const subcategories = asRows<{ id: string; category_id: string; name: string }>(subcategoryRows);
      subcategoryIds = subcategories.map((subcategory) => subcategory.id);
      categoryNames = new Map(subcategories.map((subcategory) => [subcategory.id, normalizedCategory]));
    }
  }

  let productQuery = supabase
    .from("catalog_products")
    .select("*")
    .in("brand_id", brandIds)
    .eq("status", "active")
    .limit(100);
  if (subcategoryIds?.length) productQuery = productQuery.in("subcategory_id", subcategoryIds);
  const { data: productRows, error: productError } = await productQuery;
  if (productError) throw productError;
  const products = asRows<CatalogProduct>(productRows);
  if (!products.length) return null;

  const productIds = products.map((product) => product.id);
  const { data: productAliasRows, error: productAliasError } = await supabase
    .from("catalog_aliases")
    .select("entity_id, alias")
    .eq("entity_type", "product")
    .in("entity_id", productIds);
  if (productAliasError) throw productAliasError;

  const { data: variantRows, error: variantError } = await supabase
    .from("catalog_product_variants")
    .select("*")
    .in("product_id", productIds)
    .limit(300);
  if (variantError) throw variantError;

  const variants = asRows<CatalogProductVariant>(variantRows);
  const variantIds = variants.map((variant) => variant.id);
  const { data: variantAliasRows, error: variantAliasError } = variantIds.length
    ? await supabase
        .from("catalog_aliases")
        .select("entity_id, alias")
        .eq("entity_type", "variant")
        .in("entity_id", variantIds)
    : { data: [], error: null };
  if (variantAliasError) throw variantAliasError;

  const aliasByEntity = new Map<string, string[]>();
  for (const row of [
    ...asRows<{ entity_id: string; alias: string }>(productAliasRows),
    ...asRows<{ entity_id: string; alias: string }>(variantAliasRows),
  ]) {
    aliasByEntity.set(row.entity_id, [...(aliasByEntity.get(row.entity_id) ?? []), row.alias]);
  }

  const brandById = new Map(brands.map((brand) => [brand.id, brand.name]));
  const variantsByProduct = new Map<string, CatalogVariantCandidate[]>();
  for (const variant of variants) {
    variantsByProduct.set(variant.product_id, [
      ...(variantsByProduct.get(variant.product_id) ?? []),
      { variant, aliases: aliasByEntity.get(variant.id) ?? [] },
    ]);
  }

  const candidates: CatalogMatchCandidate[] = products.map((product) => ({
    product,
    brandName: brandById.get(product.brand_id) ?? input.brand ?? "",
    categoryName: categoryNames.get(product.subcategory_id ?? "") ?? input.category,
    aliases: aliasByEntity.get(product.id) ?? [],
    variants: variantsByProduct.get(product.id) ?? [],
  }));
  const matches = findCatalogMatches(input, candidates);
  if (hasAmbiguousHighConfidenceMatch(matches)) return null;
  const best = matches[0];
  if (!best) return null;
  const candidate = candidates.find((item) => item.product.id === best.productId);
  return candidate ? addVariantMatch(input, candidate, best) : null;
}