// scripts/backfill-catalog-matches.js
/**
 * PENCHANT Canonical Catalog Backfill
 *
 * Automatic catalog matching (lib/catalog.ts) only runs at upload time, so any
 * product listing created before that feature shipped has catalog_product_id
 * and catalog_variant_id stuck at null forever - it will never show the
 * "Verified product" indicator. This script runs the SAME matcher
 * (lib/catalogMatching.ts, the pure scoring module shared with the app)
 * against existing listings and backfills catalog_product_id where we can be
 * confident about it.
 *
 * Rules (enforced below, do not change without re-reading this comment):
 *   - Only rows where catalog_product_id IS NULL are ever considered. A
 *     product that's already linked is left completely alone, forever
 *     (idempotent + never overwrites an existing match).
 *   - Only confidence >= 0.90 ("high") is auto-assigned. Anything in the
 *     0.70-0.89 "possible" band, or below, is left null and reported
 *     separately so a human can review it - this script never guesses.
 *   - If more than one distinct catalog product scores >= 0.90 for the same
 *     listing, that's "ambiguous" and is skipped rather than picking one.
 *   - Only catalog_product_id / catalog_variant_id are ever written. Every
 *     other column (user_id, moderation, likes, saves, etc.) is untouched
 *     because we only ever .update({...}).eq("id", productId).
 *
 * REQUIRES the Supabase SERVICE ROLE key (writes across all sellers' rows
 * bypass per-user RLS). Put it in a local, gitignored `.env.local`:
 *   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
 *
 * Usage:
 *   node scripts/backfill-catalog-matches.js --dry-run   report only, no writes (default)
 *   node scripts/backfill-catalog-matches.js --apply     perform the backfill
 *
 * Safe to rerun: rows that already have catalog_product_id are always
 * skipped, so re-running --apply after new listings are added only affects
 * the newly-unmatched rows.
 */

const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
// Local-only overrides (gitignored) — this is where SUPABASE_SERVICE_ROLE_KEY lives.
require("dotenv").config({ path: ".env.local", override: true });

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  console.error("Missing EXPO_PUBLIC_SUPABASE_URL in .env");
  process.exit(1);
}

if (!serviceRoleKey) {
  console.error(
    "\nMissing SUPABASE_SERVICE_ROLE_KEY.\n" +
      "This script updates listings owned by many different users, which requires\n" +
      "bypassing RLS, so it must not run with the anon key. Add it to a local,\n" +
      "gitignored `.env.local` file:\n\n" +
      "  SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here\n\n" +
      "Find it in Supabase Dashboard -> Project Settings -> API -> service_role.\n" +
      "Never commit this key or use an EXPO_PUBLIC_ prefix for it.\n"
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const HIGH_CONFIDENCE = 0.9;

async function loadCatalogMatching() {
  // Native Node TS type-stripping (no bundler) — must stay dependency-free (see lib/catalogMatching.ts).
  const mod = await import("../lib/catalogMatching.ts");
  return mod;
}

function asRows(value) {
  return Array.isArray(value) ? value : [];
}

async function loadCatalogSnapshot() {
  const [
    { data: brandRows, error: brandError },
    { data: categoryRows, error: categoryError },
    { data: subcategoryRows, error: subcategoryError },
    { data: productRows, error: productError },
    { data: variantRows, error: variantError },
    { data: aliasRows, error: aliasError },
  ] = await Promise.all([
    supabase.from("catalog_brands").select("id, name"),
    supabase.from("catalog_categories").select("id, slug, name"),
    supabase.from("catalog_subcategories").select("id, category_id, name"),
    supabase.from("catalog_products").select("*").eq("status", "active"),
    supabase.from("catalog_product_variants").select("*"),
    supabase.from("catalog_aliases").select("entity_type, entity_id, alias, normalized_alias"),
  ]);
  for (const error of [brandError, categoryError, subcategoryError, productError, variantError, aliasError]) {
    if (error) throw error;
  }

  const aliasByEntity = new Map();
  for (const row of asRows(aliasRows)) {
    aliasByEntity.set(row.entity_id, [...(aliasByEntity.get(row.entity_id) ?? []), row.alias]);
  }
  const brandAliasesByNormalized = new Map();
  for (const row of asRows(aliasRows)) {
    if (row.entity_type !== "brand") continue;
    brandAliasesByNormalized.set(row.normalized_alias, [
      ...(brandAliasesByNormalized.get(row.normalized_alias) ?? []),
      row.entity_id,
    ]);
  }

  const variantsByProduct = new Map();
  for (const variant of asRows(variantRows)) {
    variantsByProduct.set(variant.product_id, [
      ...(variantsByProduct.get(variant.product_id) ?? []),
      { variant, aliases: aliasByEntity.get(variant.id) ?? [] },
    ]);
  }

  const subcategoryById = new Map(asRows(subcategoryRows).map((s) => [s.id, s]));

  return {
    brands: asRows(brandRows),
    categories: asRows(categoryRows),
    brandAliasesByNormalized,
    products: asRows(productRows),
    aliasByEntity,
    variantsByProduct,
    subcategoryById,
  };
}

// Mirrors the candidate-building in lib/catalog.ts's findCatalogMatch, but
// works off an in-memory snapshot so we can score every unmatched listing
// without one round-trip per product.
function buildCandidates(snapshot, normalizeCatalogText, input) {
  const normalizedBrand = normalizeCatalogText(input.brand);
  const normalizedCategory = normalizeCatalogText(input.category);
  if (!normalizedBrand || !normalizeCatalogText(input.title)) return [];

  const matchingBrands = snapshot.brands.filter(
    (brand) => normalizeCatalogText(brand.name).includes(normalizedBrand) || normalizeCatalogText(brand.name) === normalizedBrand
  );
  const aliasBrandIds = snapshot.brandAliasesByNormalized.get(normalizedBrand) ?? [];
  const brandIds = Array.from(new Set([...matchingBrands.map((b) => b.id), ...aliasBrandIds]));
  if (!brandIds.length) return [];
  const brandById = new Map(snapshot.brands.map((b) => [b.id, b.name]));

  let subcategoryIds = null;
  if (normalizedCategory) {
    const category = snapshot.categories.find(
      (c) => normalizeCatalogText(c.slug) === normalizedCategory || normalizeCatalogText(c.name) === normalizedCategory
    );
    if (category) {
      subcategoryIds = Array.from(snapshot.subcategoryById.values())
        .filter((s) => s.category_id === category.id)
        .map((s) => s.id);
    }
  }

  return snapshot.products
    .filter((product) => brandIds.includes(product.brand_id))
    .filter((product) => !subcategoryIds?.length || subcategoryIds.includes(product.subcategory_id))
    .map((product) => ({
      product,
      brandName: brandById.get(product.brand_id) ?? input.brand ?? "",
      categoryName: normalizedCategory,
      aliases: snapshot.aliasByEntity.get(product.id) ?? [],
      variants: snapshot.variantsByProduct.get(product.id) ?? [],
    }));
}

async function main() {
  const apply = process.argv.includes("--apply");
  const dryRun = !apply;

  const { normalizeCatalogText, findCatalogMatches, hasAmbiguousHighConfidenceMatch, addVariantMatch } = await loadCatalogMatching();

  const { data: productRows, error: productsError } = await supabase
    .from("products")
    .select("id, title, brand, category, catalog_product_id")
    .is("catalog_product_id", null);
  if (productsError) throw productsError;

  const unmatchedProducts = asRows(productRows);
  console.log(
    `\nMode: ${dryRun ? "DRY RUN (no writes)" : "APPLY (writing to database)"}\n` +
      `Existing listings without catalog_product_id: ${unmatchedProducts.length}\n`
  );

  const snapshot = await loadCatalogSnapshot();

  const results = { matched: [], ambiguous: [], unmatched: [] };

  for (const product of unmatchedProducts) {
    const input = { title: product.title, brand: product.brand, category: product.category };
    const candidates = buildCandidates(snapshot, normalizeCatalogText, input);
    const scored = findCatalogMatches(input, candidates);

    const highConfidence = scored.filter((m) => m.confidence >= HIGH_CONFIDENCE);
    if (hasAmbiguousHighConfidenceMatch(scored)) {
      results.ambiguous.push({ product, candidates: highConfidence });
      continue;
    }

    const best = scored[0];
    if (!best || best.confidence < HIGH_CONFIDENCE) {
      results.unmatched.push({ product, best: best ?? null });
      continue;
    }

    const candidate = candidates.find((c) => c.product.id === best.productId);
    const resolved = candidate ? addVariantMatch(input, candidate, best) : null;
    results.matched.push({ product, resolved });
  }

  console.log("--- Matched (confidence >= 0.90) ---");
  for (const { product, resolved } of results.matched) {
    console.log(
      `  [${dryRun ? "would match" : "matching"}] "${product.brand} ${product.title}" (${product.id}) -> ` +
        `${resolved.productName} [${resolved.match.productId}]` +
        (resolved.variantName ? ` / variant "${resolved.variantName}"` : "") +
        ` (confidence ${resolved.match.confidence}, ${resolved.match.reason})`
    );
  }

  console.log("\n--- Ambiguous (multiple >= 0.90 candidates, left untouched) ---");
  for (const { product, candidates: cands } of results.ambiguous) {
    console.log(
      `  [skipped] "${product.brand} ${product.title}" (${product.id}) -> ` +
        cands.map((c) => `${c.productId} (${c.confidence})`).join(", ")
    );
  }

  console.log("\n--- Unmatched (no candidate >= 0.90, left untouched) ---");
  for (const { product, best } of results.unmatched) {
    console.log(
      `  [skipped] "${product.brand} ${product.title}" (${product.id})` +
        (best ? ` best candidate confidence ${best.confidence} (${best.reason})` : " no candidate")
    );
  }

  console.log(
    `\nSummary: ${results.matched.length} matched, ${results.ambiguous.length} ambiguous, ${results.unmatched.length} unmatched.`
  );

  if (dryRun) {
    console.log("\nDry run only - no rows were changed. Re-run with --apply to write these matches.");
    return;
  }

  console.log("\nApplying updates...");
  let written = 0;
  for (const { product, resolved } of results.matched) {
    // Guard against a race with a concurrent write/backfill run: never clobber
    // a catalog_product_id that got set between the read above and this write.
    const { data, error } = await supabase
      .from("products")
      .update({
        catalog_product_id: resolved.match.productId,
        catalog_variant_id: resolved.variantId,
      })
      .eq("id", product.id)
      .is("catalog_product_id", null)
      .select("id");
    if (error) {
      console.error(`  FAILED to update ${product.id}:`, error.message);
      continue;
    }
    if (data && data.length) written += 1;
  }
  console.log(`Done. ${written}/${results.matched.length} rows updated.`);
}

main().catch((error) => {
  console.error("Backfill failed:", error);
  process.exit(1);
});
