#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { gzipSync } = require("zlib");

async function main() {
  const ledgerPath = path.join(__dirname, "..", ".catalog-staging", "catalog-taxonomy-mappings.test.json");
  process.env.CATALOG_TAXONOMY_LEDGER_PATH = ledgerPath;
  const taxonomy = await import("../lib/catalogTaxonomyTypes.ts");
  const mappings = await import("../lib/catalogTaxonomyMappings.ts");
  const acquisition = await import("../lib/catalogAcquisition.ts");
  const staging = await import("../lib/stagingStore.ts");
  const providerTaxonomy = await import("../lib/catalogProviderTaxonomy.ts");
  const providers = await import("../lib/catalogProviders.ts");
  const { mappingKey, mappingIsTrusted } = taxonomy;
  const { LocalTaxonomyMappingStore } = mappings;
  const { acquireFromRecords, assessCandidateReadiness } = acquisition;
  const { LocalStagingStore } = staging;
  const { OPEN_ICECAT_CATEGORIES_URL, parseOpenIcecatCategoriesXml, fetchOpenIcecatTaxonomy, loadOpenIcecatTaxonomyCache, saveOpenIcecatTaxonomyCache } = providerTaxonomy;
  const { normalizeIcecatProduct } = providers;
  const { CURATED_DISCOVERY_CATEGORY_SLUGS, isDiscoveryCategoryVisible } = await import("../lib/discoveryTaxonomy.ts");

  fs.rmSync(ledgerPath, { force: true });
  const store = new LocalTaxonomyMappingStore({
    categories: [{ id: "cat-electronics", name: "Electronics" }, { id: "cat-home", name: "Home" }],
    subcategories: [
      { id: "sub-headphones", categoryId: "cat-electronics", name: "Headphones" },
      { id: "sub-printers", categoryId: "cat-electronics", name: "Printers" },
    ],
  });

  assert.strictEqual(CURATED_DISCOVERY_CATEGORY_SLUGS.length, 10);
  assert.strictEqual(isDiscoveryCategoryVisible("electronics"), true);
  assert.strictEqual(isDiscoveryCategoryVisible("printers"), false);
  const categoriesScreenSource = fs.readFileSync(path.join(__dirname, "..", "app", "(tabs)", "categories.tsx"), "utf8");
  assert.doesNotMatch(categoriesScreenSource, /list\.push\(/, "product labels must not create discovery navigation tiles");
  const canonicalCliSource = fs.readFileSync(path.join(__dirname, "catalog-taxonomy-canonical.js"), "utf8");
  assert.match(canonicalCliSource, /internal-only/, "canonical taxonomy inspection must distinguish internal-only nodes");

  const categoryFixture = fs.readFileSync(path.join(__dirname, "__fixtures__", "catalog-taxonomy", "open-icecat-categories.xml"), "utf8");
  const authoritativeCategories = await parseOpenIcecatCategoriesXml(categoryFixture);
  const authoritativeById = new Map(authoritativeCategories.map((identity) => [identity.externalId, identity]));
  assert.deepStrictEqual(authoritativeById.get("971"), {
    provider: "open-icecat",
    externalId: "971",
    name: "Large Format Media",
    path: "1 > 2833 Computers & Peripherals > 225 Printers & Scanners > 692 Printing Media > 971 Large Format Media",
    parentId: "692",
    parentName: "Printing Media",
    parentPath: "1 > 2833 Computers & Peripherals > 225 Printers & Scanners > 692 Printing Media",
  });
  assert.strictEqual(authoritativeById.get("9999").name, null, "missing English provider name must remain unavailable");
  assert.match(authoritativeById.get("9999").path, /> 9999$/, "an unnamed category path must retain only its authoritative ID");

  const taxonomyCachePath = path.join(__dirname, "..", ".catalog-staging", "open-icecat-taxonomy.test.json");
  saveOpenIcecatTaxonomyCache(authoritativeCategories, { cachePath: taxonomyCachePath, fetchedAt: "2026-09-16T00:00:00.000Z" });
  assert.strictEqual(loadOpenIcecatTaxonomyCache(taxonomyCachePath).get("971").name, "Large Format Media");
  let capturedTaxonomyRequest = null;
  const streamedCategories = await fetchOpenIcecatTaxonomy({
    headers: { "Api-Token": "fixture-token" },
    fetcher: async (url, request) => {
      capturedTaxonomyRequest = { url, headers: request.headers };
      return new Response(gzipSync(Buffer.from(categoryFixture)), { status: 200, headers: { "Content-Type": "application/x-gzip-compressed" } });
    },
  });
  assert.strictEqual(capturedTaxonomyRequest.url, OPEN_ICECAT_CATEGORIES_URL);
  assert.deepStrictEqual(capturedTaxonomyRequest.headers["Api-Token"], "fixture-token");
  assert.strictEqual(streamedCategories.find((identity) => identity.externalId === "971").name, "Large Format Media");

  const normalizedWithTaxonomy = normalizeIcecatProduct({
    sourceExternalId: "provider-product-1",
    brand: "Fixture Brand",
    productName: "A title that does not identify its category",
    modelNumber: "MODEL-1",
    mpn: "MODEL-1",
    gtin: null,
    sourceUrl: "https://example.test/product.xml",
    category: "971",
    subcategory: null,
    onMarket: true,
    country: null,
    updated: null,
    supplierId: "1",
    dateAdded: null,
    imageUrl: null,
    countryMarkets: [],
    raw: { provider: "open-icecat", categoryId: "971" },
  }, {}, authoritativeById);
  assert.deepStrictEqual(normalizedWithTaxonomy.externalTaxonomy, authoritativeById.get("971"));
  assert.deepStrictEqual(normalizedWithTaxonomy.raw.externalTaxonomy, authoritativeById.get("971"), "authoritative identity must survive staging raw-payload serialization");
  assert.strictEqual(normalizedWithTaxonomy.category, null, "provider taxonomy must not create a PENCHANT category");
  assert.strictEqual(normalizedWithTaxonomy.subcategory, null, "provider taxonomy must not create a PENCHANT subcategory");
  assert.strictEqual(normalizedWithTaxonomy.raw.taxonomyMapping, null, "provider taxonomy lookup must not create a mapping");

  const inspectorSource = fs.readFileSync(path.join(__dirname, "catalog-taxonomy-external.js"), "utf8");
  assert.doesNotMatch(inspectorSource, /resolveStagingStore|resolveTaxonomyMappingStore|upsert|insert|update|delete/, "external taxonomy inspector must not access mutable catalog stores");
  assert.doesNotMatch(inspectorSource, /console\.(?:log|error)\([^\n]*(?:TOKEN|PASSWORD|Authorization|headers)/i, "external taxonomy inspector must never log credentials or request headers");
  const gapsCliSource = fs.readFileSync(path.join(__dirname, "catalog-taxonomy-gaps.js"), "utf8");
  assert.doesNotMatch(gapsCliSource, /fetchOpenIcecatTaxonomy|refresh-cache/, "ordinary gap reports must remain deterministic and offline");

  const authoritativeGap = acquisition.rankTaxonomyGaps("run-authoritative", [{
    id: "candidate-authoritative", importRunId: "run-authoritative", sourceId: "source", sourceExternalId: "product",
    fingerprint: "fingerprint", status: "needs_review", classification: "NEW", brand: "Fixture", productName: "Unknown title",
    modelNumber: null, family: null, category: null, subcategory: null, aliases: [], sourceUrl: null, imageUrl: null,
    sourceType: "open-icecat", upc: null, gtin: null, mpn: null, externalTaxonomy: authoritativeById.get("971"),
    rawPayload: { externalTaxonomy: authoritativeById.get("971") }, confidence: 0.88,
    createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:00.000Z",
  }], []);
  assert.strictEqual(authoritativeGap[0].name, "Large Format Media");
  assert.match(authoritativeGap[0].path, /Printing Media > 971 Large Format Media$/);
  const historicalGap = acquisition.rankTaxonomyGaps("run-historical", [{
    id: "candidate-historical", importRunId: "run-historical", sourceId: "source", sourceExternalId: "historical",
    fingerprint: "historical", status: "needs_review", classification: "NEW", brand: "Fixture", productName: "Looks like paper",
    modelNumber: null, family: null, category: null, subcategory: null, aliases: [], sourceUrl: null, imageUrl: null,
    sourceType: "open-icecat", upc: null, gtin: null, mpn: null,
    externalTaxonomy: { provider: "open-icecat", externalId: "971" }, rawPayload: {}, confidence: 0.88,
    createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:00.000Z",
  }], [{ provider: "open-icecat", externalTaxonomyId: "971", externalName: "Untrusted fallback", status: "suggested" }]);
  assert.strictEqual(historicalGap[0].name, null, "historical ID-only rows must not infer or borrow an unpersisted name");
  assert.strictEqual(historicalGap[0].path, null);

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

  const newInternalTarget = await store.validateCanonicalTarget("cat-electronics", "sub-printers");
  const newInternalMapping = await store.upsertMapping({
    identity: { provider: "open-icecat", externalId: "printer-category" },
    status: "verified", method: "manual",
  }, newInternalTarget);
  assert.strictEqual(mappingIsTrusted(newInternalMapping), true, "a legitimate reviewed internal class can receive an external mapping");

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
  fs.rmSync(taxonomyCachePath, { force: true });
  fs.rmSync(path.join(__dirname, "..", ".catalog-staging", "taxonomy-acquisition.test.json"), { force: true });
  console.log("Catalog taxonomy tests passed.");
}

main().catch((error) => { console.error(error); process.exit(1); });
