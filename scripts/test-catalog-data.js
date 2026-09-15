#!/usr/bin/env node
const assert = require("assert");
const path = require("path");
const { loadAndValidateCatalogData } = require("./lib/catalogDataLoader");

async function main() {
  const { normalizeCatalogText } = await import("../lib/catalogMatching.ts");
  const fixtures = path.join(__dirname, "__fixtures__");
  const valid = loadAndValidateCatalogData(path.join(fixtures, "catalog-data-valid"), normalizeCatalogText);
  assert.deepStrictEqual(valid.errors, []);
  assert.strictEqual(valid.products[0].slug, "jbl-boombox-3");
  assert.strictEqual(valid.products[0].variants.length, 2);

  const invalid = loadAndValidateCatalogData(path.join(fixtures, "catalog-data-invalid"), normalizeCatalogText);
  assert.ok(invalid.errors.some((error) => error.problem.includes("malformed JSON")));
  assert.ok(invalid.errors.some((error) => error.problem.includes("duplicate normalized alias")));
  assert.ok(invalid.errors.some((error) => error.problem.includes("nonexistent family")));
  assert.ok(invalid.errors.some((error) => error.problem.includes("nonexistent subcategory path")));

  console.log("Catalog data fixture tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
