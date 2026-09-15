#!/usr/bin/env node
// scripts/validate-catalog-data.js
//
// Static, offline validation of catalog-data/*.json (see docs/catalog-data.md).
// Runs BEFORE anything reaches Supabase — no network access, no service-role
// key required. This is what `npm run catalog:validate` runs, and it's also
// the first step scripts/import-catalog-data.js performs before touching the
// database.
//
// Usage:
//   node scripts/validate-catalog-data.js
//   npm run catalog:validate
//
// Exits non-zero if any validation error is found.

const path = require("path");
const { loadAndValidateCatalogData } = require("./lib/catalogDataLoader");

const CATALOG_DATA_DIR = path.join(__dirname, "..", "catalog-data");

async function loadNormalizeFn() {
  // Native Node TS type-stripping (no bundler) — same pattern as
  // scripts/backfill-catalog-matches.js, so alias dedupe matches the runtime
  // matcher exactly.
  const mod = await import("../lib/catalogMatching.ts");
  return mod.normalizeCatalogText;
}

async function main() {
  const normalizeCatalogText = await loadNormalizeFn();
  const result = loadAndValidateCatalogData(CATALOG_DATA_DIR, normalizeCatalogText);

  if (result.fileCount === 0) {
    console.log(`No catalog-data files found under ${path.relative(process.cwd(), CATALOG_DATA_DIR)}/`);
    return result;
  }

  console.log(`Validated ${result.fileCount} catalog-data file(s).`);
  console.log(`  Categories: ${result.taxonomy.categories.size}`);
  console.log(`  Subcategories: ${result.taxonomy.subcategoryByPath.size}`);
  console.log(`  Brands: ${result.brands.length}`);
  console.log(`  Families: ${result.families.length}`);
  console.log(`  Products: ${result.products.length}`);
  console.log(`  Variants: ${result.products.reduce((sum, p) => sum + (p.variants?.length ?? 0), 0)}`);

  if (result.errors.length === 0) {
    console.log("\nNo validation errors found.");
    return result;
  }

  console.log(`\n${result.errors.length} validation error(s):\n`);
  for (const { file, entity, problem } of result.errors) {
    console.log(file);
    console.log(`${entity}`);
    console.log(`ERROR: ${problem}\n`);
  }
  return result;
}

main()
  .then((result) => {
    process.exit(result.errors.length > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error("Catalog validation crashed:", error);
    process.exit(1);
  });
