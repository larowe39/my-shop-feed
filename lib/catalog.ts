export type CatalogStatus = "active" | "discontinued" | "upcoming" | "unknown";

export type CatalogAttributes = Record<string, unknown>;

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

export type CatalogProduct = {
  id: string;
  brand_id: string;
  family_id: string | null;
  subcategory_id: string | null;
  slug: string;
  name: string;
  model_number: string | null;
  release_year: number | null;
  description: string | null;
  upc: string | null;
  gtin: string | null;
  mpn: string | null;
  status: CatalogStatus;
  attributes: CatalogAttributes;
  created_at: string;
  updated_at: string;
};

export type CatalogProductVariant = {
  id: string;
  product_id: string;
  slug: string;
  name: string;
  sku: string | null;
  upc: string | null;
  gtin: string | null;
  color: string | null;
  size: string | null;
  attributes: CatalogAttributes;
  created_at: string;
};

export type CatalogVariantCandidate = {
  variant: CatalogProductVariant;
  aliases?: string[];
};

export type CatalogMatchCandidate = {
  product: CatalogProduct;
  brandName: string;
  categoryName?: string | null;
  aliases?: string[];
  variants?: CatalogVariantCandidate[];
};

export type CatalogMatchInput = {
  title: string;
  brand?: string | null;
  category?: string | null;
};

export type CatalogMatch = {
  productId: string;
  confidence: number;
  reason: string;
};

export type ResolvedCatalogMatch = {
  match: CatalogMatch;
  productName: string;
  variantId: string | null;
  variantName: string | null;
};

export const CATALOG_CONFIDENCE_THRESHOLDS = {
  high: 0.9,
  possible: 0.7,
} as const;

export function normalizeCatalogText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  return normalizeCatalogText(value).split(" ").filter(Boolean);
}

function tokenOverlap(left: string, right: string): number {
  const leftTokens = new Set(tokens(left));
  const rightTokens = new Set(tokens(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return shared / Math.max(leftTokens.size, rightTokens.size);
}

function compact(value: string): string {
  return normalizeCatalogText(value).replace(/\s+/g, "");
}

function catalogTextMatches(left: string, right: string): boolean {
  return normalizeCatalogText(left) === normalizeCatalogText(right) || compact(left) === compact(right);
}

function scoreCandidate(input: CatalogMatchInput, candidate: CatalogMatchCandidate): CatalogMatch {
  const title = normalizeCatalogText(input.title);
  const brand = normalizeCatalogText(input.brand);
  const category = normalizeCatalogText(input.category);
  const productName = normalizeCatalogText(candidate.product.name);
  const modelNumber = normalizeCatalogText(candidate.product.model_number);
  const brandName = normalizeCatalogText(candidate.brandName);
  const categoryName = normalizeCatalogText(candidate.categoryName);
  const aliases = (candidate.aliases ?? []).map(normalizeCatalogText).filter(Boolean);
  const brandMatches = Boolean(brand && brandName && brand === brandName);
  const categoryMatches = Boolean(category && categoryName && category === categoryName);
  const titleWithoutBrand = brandMatches && title.startsWith(`${brandName} `)
    ? title.slice(brandName.length + 1)
    : title;
  const titleForms = [title, titleWithoutBrand];
  const exactProductMatch = titleForms.some(
    (titleForm) => catalogTextMatches(titleForm, productName) || (modelNumber && catalogTextMatches(titleForm, modelNumber))
  );
  const exactAliasMatch = titleForms.some((titleForm) => aliases.some((alias) => catalogTextMatches(titleForm, alias)));
  const exactVariantMatch = (candidate.variants ?? []).some(
    (variant) => scoreVariant(input, candidate, variant) >= CATALOG_CONFIDENCE_THRESHOLDS.high
  );

  if (brandMatches && exactVariantMatch) {
    return {
      productId: candidate.product.id,
      confidence: 0.98,
      reason: "Exact brand + product variant",
    };
  }

  if (brandMatches && exactProductMatch) {
    return {
      productId: candidate.product.id,
      confidence: 0.98,
      reason: modelNumber && titleForms.some((titleForm) => catalogTextMatches(titleForm, modelNumber))
        ? "Exact brand + model number"
        : "Exact brand + product name",
    };
  }

  if (exactAliasMatch) {
    return {
      productId: candidate.product.id,
      confidence: brandMatches ? 0.95 : 0.86,
      reason: brandMatches ? "Exact brand + alias" : "Exact alias",
    };
  }

  if (exactProductMatch) {
    return {
      productId: candidate.product.id,
      confidence: categoryMatches ? 0.93 : 0.9,
      reason: modelNumber && titleForms.some((titleForm) => catalogTextMatches(titleForm, modelNumber))
        ? "Exact model number"
        : "Exact product name",
    };
  }

  const comparableNames = [productName, modelNumber, ...aliases].filter(Boolean);
  const bestOverlap = Math.max(0, ...comparableNames.map((name) => tokenOverlap(title, name)));
  const startsWithMatch = comparableNames.some((name) => name.startsWith(title) || title.startsWith(name));
  const substringMatch = comparableNames.some((name) => name.includes(title) || title.includes(name));
  const confidence = brandMatches && bestOverlap >= 0.5
    ? 0.78
    : startsWithMatch
      ? 0.74
      : bestOverlap >= 0.5
        ? 0.7
        : substringMatch
          ? 0.62
          : Math.min(0.59, bestOverlap * 0.59);

  return {
    productId: candidate.product.id,
    confidence: Number(confidence.toFixed(2)),
    reason: brandMatches && bestOverlap >= 0.5
      ? "Brand + product token overlap"
      : startsWithMatch
        ? "Starts-with product match"
        : bestOverlap >= 0.5
          ? "Product token overlap"
          : substringMatch
            ? "Product substring match"
            : "Weak catalog similarity",
  };
}

export function findCatalogMatches(
  input: CatalogMatchInput,
  candidates: CatalogMatchCandidate[]
): CatalogMatch[] {
  return candidates
    .map((candidate) => scoreCandidate(input, candidate))
    .sort((left, right) => right.confidence - left.confidence || left.productId.localeCompare(right.productId));
}

function scoreVariant(
  input: CatalogMatchInput,
  candidate: CatalogMatchCandidate,
  variant: CatalogVariantCandidate
): number {
  const title = normalizeCatalogText(input.title);
  const brandName = normalizeCatalogText(candidate.brandName);
  const productName = normalizeCatalogText(candidate.product.name);
  const variantName = normalizeCatalogText(variant.variant.name);
  const aliases = (variant.aliases ?? []).map(normalizeCatalogText).filter(Boolean);
  const exactNames = [
    `${brandName} ${productName} ${variantName}`,
    `${productName} ${variantName}`,
    ...aliases,
  ].filter(Boolean);

  if (exactNames.some((name) => catalogTextMatches(title, name))) return 0.98;

  const variantValue = normalizeCatalogText(
    [variant.variant.color, variant.variant.size].filter(Boolean).join(" ")
  );
  if (variantValue && catalogTextMatches(title, `${productName} ${variantValue}`)) return 0.94;
  return 0;
}

function addVariantMatch(
  input: CatalogMatchInput,
  candidate: CatalogMatchCandidate,
  match: CatalogMatch
): ResolvedCatalogMatch {
  const bestVariant = (candidate.variants ?? [])
    .map((variant) => ({ variant, confidence: scoreVariant(input, candidate, variant) }))
    .filter((item) => item.confidence >= CATALOG_CONFIDENCE_THRESHOLDS.high)
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.variant.variant.id.localeCompare(right.variant.variant.id)
    )[0]?.variant;

  return {
    match,
    productName: candidate.product.name,
    variantId: bestVariant?.variant.id ?? null,
    variantName: bestVariant?.variant.name ?? null,
  };
}

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
  const best = findCatalogMatches(input, candidates)[0];
  if (!best) return null;
  const candidate = candidates.find((item) => item.product.id === best.productId);
  return candidate ? addVariantMatch(input, candidate, best) : null;
}