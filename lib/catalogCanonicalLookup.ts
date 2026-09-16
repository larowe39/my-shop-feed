// lib/catalogCanonicalLookup.ts
//
// Read-only loader that turns the real canonical catalog (catalog_brands /
// catalog_subcategories / catalog_product_families / catalog_products /
// catalog_aliases) into the CanonicalCatalogEntry[] shape that
// classifyCandidate() compares acquisition candidates against.
//
// This closes the acquisition deduplication bug found in the PR #21
// production smoke test: previously every CLI acquisition run classified
// candidates against a hardcoded `[]` canonical catalog, so nothing could
// ever be recognized as already-canonical no matter how good the matching
// logic was. resolveCanonicalCatalogEntries() is the single chokepoint for
// loading this data and fails closed (throws) rather than silently
// classifying against an empty list when Supabase is the selected/default
// backend and no credentials are available at all.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import type { CanonicalCatalogEntry } from "./catalogStagingTypes.ts";

const CANONICAL_CATALOG_READ_PAGE_SIZE = 1000;

async function fetchAllRows<T>(client: SupabaseClient, table: string, select: string, filter?: (query: any) => any): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    let query = client.from(table).select(select).range(from, from + CANONICAL_CATALOG_READ_PAGE_SIZE - 1);
    if (filter) query = filter(query);
    const { data, error } = await query;
    if (error) throw new Error(`Failed to read canonical ${table}: ${error.message}`);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < CANONICAL_CATALOG_READ_PAGE_SIZE) break;
    from += CANONICAL_CATALOG_READ_PAGE_SIZE;
  }
  return rows;
}

type BrandRow = { id: string; name: string };
type SubcategoryRow = { id: string; name: string };
type FamilyRow = { id: string; name: string };
type ProductRow = {
  id: string;
  brand_id: string;
  family_id: string | null;
  subcategory_id: string | null;
  name: string;
  model_number: string | null;
  upc: string | null;
  gtin: string | null;
  mpn: string | null;
};
type AliasRow = { entity_id: string; alias: string };

/** Reads the entire canonical catalog (paginated, read-only) and maps it into CanonicalCatalogEntry[] for classifyCandidate(). */
export async function loadCanonicalCatalogEntries(client: SupabaseClient): Promise<CanonicalCatalogEntry[]> {
  const [brands, subcategories, families, products, aliases] = await Promise.all([
    fetchAllRows<BrandRow>(client, "catalog_brands", "id, name"),
    fetchAllRows<SubcategoryRow>(client, "catalog_subcategories", "id, name"),
    fetchAllRows<FamilyRow>(client, "catalog_product_families", "id, name"),
    fetchAllRows<ProductRow>(client, "catalog_products", "id, brand_id, family_id, subcategory_id, name, model_number, upc, gtin, mpn"),
    fetchAllRows<AliasRow>(client, "catalog_aliases", "entity_id, alias", (query) => query.eq("entity_type", "product")),
  ]);

  const brandNameById = new Map(brands.map((row) => [row.id, row.name]));
  const subcategoryNameById = new Map(subcategories.map((row) => [row.id, row.name]));
  const familyNameById = new Map(families.map((row) => [row.id, row.name]));
  const aliasesByProductId = new Map<string, string[]>();
  for (const row of aliases) {
    aliasesByProductId.set(row.entity_id, [...(aliasesByProductId.get(row.entity_id) ?? []), row.alias]);
  }

  return products.map((product) => ({
    brand: brandNameById.get(product.brand_id) ?? "",
    productName: product.name,
    modelNumber: product.model_number,
    family: product.family_id ? familyNameById.get(product.family_id) ?? null : null,
    subcategory: product.subcategory_id ? subcategoryNameById.get(product.subcategory_id) ?? null : null,
    aliases: aliasesByProductId.get(product.id) ?? [],
    upc: product.upc,
    gtin: product.gtin,
    mpn: product.mpn,
  }));
}

export type ResolveCanonicalCatalogOptions = {
  /** "local" returns an empty catalog (tests/dev only, explicit opt-in). Omitted/"supabase" reads the real canonical catalog. */
  backend?: "local" | "supabase";
};

/**
 * Single chokepoint for loading the canonical catalog for acquisition
 * classification. Canonical catalog tables are publicly readable (see
 * 20260913_add_canonical_product_catalog.sql grants), so the anon key is
 * sufficient here -- no service-role key required for this read. Fails
 * closed (throws) if Supabase is the selected/default backend and no
 * credentials at all are available, rather than silently classifying every
 * candidate as NEW against an empty list (the exact bug this closes).
 */
export async function resolveCanonicalCatalogEntries(options: ResolveCanonicalCatalogOptions = {}): Promise<CanonicalCatalogEntry[]> {
  const backend = options.backend ?? "supabase";
  if (backend === "local") return [];

  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !key) {
    throw new Error(
      "Cannot classify acquisition candidates: Supabase credentials are missing, and silently classifying " +
        "against an empty canonical catalog is exactly the deduplication bug this must avoid. Set " +
        "EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY), or explicitly " +
        "pass --backend=local for tests/dev runs against an intentionally empty canonical catalog."
    );
  }
  const client = createClient(supabaseUrl, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return loadCanonicalCatalogEntries(client);
}
