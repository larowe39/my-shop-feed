#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

async function main() {
  const ledgerPath = path.join(__dirname, "..", ".catalog-staging", "catalog-taxonomy-mappings.test.json");
  process.env.CATALOG_TAXONOMY_LEDGER_PATH = ledgerPath;
  const taxonomy = await import("../lib/catalogTaxonomyTypes.ts");
  const mappings = await import("../lib/catalogTaxonomyMappings.ts");
  const acquisition = await import("../lib/catalogAcquisition.ts");
  const staging = await import("../lib/stagingStore.ts");
  const { mappingKey, mappingIsTrusted } = taxonomy;
  const { LocalTaxonomyMappingStore } = mappings;
  const { acquireFromRecords, assessCandidateReadiness } = acquisition;
  const { LocalStagingStore } = staging;

  fs.rmSync(ledgerPath, { force: true });
  const store = new LocalTaxonomyMappingStore({
    categories: [{ id: "cat-electronics", name: "Electronics" }, { id: "cat-home", name: "Home" }],
    subcategories: [{ id: "sub-headphones", categoryId: "cat-electronics", name: "Headphones" }],
  });

  assert.strictEqual(mappingKey({ provider: "open-icecat", externalId: "846" }), mappingKey({ provider: "OPEN-ICECAT", externalId: "846" }));
  assert.notStrictEqual(mappingKey({ provider: "open-icecat", externalId: "846" }), mappingKey({ provider: "gs1", externalId: "846" }));
  const target = await store.validateCanonicalTarget("cat-electronics", "sub-headphones");
  await assert.rejects(() => store.validateCanonicalTarget("cat-home", "sub-headphones"), /does not belong/);

  const suggested = await store.upsertMapping({
    identity: { provider: "open-icecat", externalId: "846", name: "Headphones", path: "Electronics > Audio > Headphones" },
    status: "suggested", method: "automated_suggestion", confidence: 0.91,
  }, target);
  assert.strictEqual(mappingIsTrusted(suggested), false);
  const suggestedRun = await acquireFromRecords([{
    sourceExternalId: "suggested-1", brand: "Sony", productName: "Suggested Headphone",
    externalTaxonomy: { provider: "open-icecat", externalId: "846", name: "Headphones" },
    raw: { provider: "open-icecat", externalTaxonomy: { provider: "open-icecat", externalId: "846", name: "Headphones" } },
  }], [], { name: "taxonomy-test", type: "external-provider" }, { taxonomyResolver: (identity) => store.resolveTrustedMapping(identity) });
  assert.strictEqual(suggestedRun.staged[0].subcategory, null, "suggested mappings must not resolve hierarchy");
  const rejected = await store.upsertMapping({
    identity: { provider: "open-icecat", externalId: "999", name: "Unknown" }, status: "rejected", method: "manual",
  }, { categoryId: null, categoryName: null, subcategoryId: null, subcategoryName: null });
  assert.strictEqual(await store.resolveTrustedMapping({ provider: "open-icecat", externalId: "999" }), null);

  const verified = await store.upsertMapping({
    identity: { provider: "open-icecat", externalId: "846", name: "Headphones", path: "Electronics > Audio > Headphones" },
    status: "verified", method: "manual", reviewedBy: "test",
  }, target);
  assert.strictEqual(mappingIsTrusted(verified), true);
  const reused = await store.resolveTrustedMapping({ provider: "open-icecat", externalId: "846" });
  assert.strictEqual(reused.canonicalSubcategoryName, "Headphones");

  const unresolved = { sourceExternalId: "product-1", brand: "Sony", productName: "Headphone", raw: { provider: "open-icecat", externalCategory: { id: "846", name: "Headphones" } }, externalTaxonomy: { provider: "open-icecat", externalId: "846", name: "Headphones" } };
  assert.strictEqual(assessCandidateReadiness(unresolved, "NEW").promotionReady, false);
  const acquisitionLedgerPath = path.join(__dirname, "..", ".catalog-staging", "taxonomy-acquisition.test.json");
  const stagingStore = new LocalStagingStore(acquisitionLedgerPath);
  stagingStore.reset();
  const mappedRun = await acquireFromRecords([unresolved], [], { name: "taxonomy-test", type: "external-provider" }, { apply: true, adapter: "test", taxonomyResolver: (identity) => store.resolveTrustedMapping(identity) }, stagingStore);
  assert.strictEqual(mappedRun.staged[0].subcategory, "Headphones");
  assert.strictEqual(mappedRun.staged[0].status, "pending", "mapping must not approve a candidate");
  assert.strictEqual(assessCandidateReadiness({ ...unresolved, category: "Electronics", subcategory: "Headphones", raw: { ...unresolved.raw, taxonomyMapping: { status: "verified" } } }, "NEW").promotionReady, true);

  const secondRun = await acquireFromRecords([unresolved], [], { name: "taxonomy-test", type: "external-provider" }, { apply: true, adapter: "test", taxonomyResolver: (identity) => store.resolveTrustedMapping(identity) }, stagingStore);
  assert.strictEqual(secondRun.staged.length, 1, "verified mapping reuse remains deterministic and idempotent at candidate identity");
  fs.rmSync(ledgerPath, { force: true });
  fs.rmSync(path.join(__dirname, "..", ".catalog-staging", "taxonomy-acquisition.test.json"), { force: true });
  console.log("Catalog taxonomy tests passed.");
}

main().catch((error) => { console.error(error); process.exit(1); });
