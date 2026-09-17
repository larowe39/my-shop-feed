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
  const { loadAndValidateCatalogData } = require("./lib/catalogDataLoader");
  const providerTaxonomy = await import("../lib/catalogProviderTaxonomy.ts");
  const providers = await import("../lib/catalogProviders.ts");
  const { mappingKey, mappingIsTrusted } = taxonomy;
  const { LocalTaxonomyMappingStore } = mappings;
  const { acquireFromRecords, assessCandidateReadiness, createRunScopedTaxonomyResolver } = acquisition;
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
      { id: "sub-laptops", categoryId: "cat-electronics", name: "Laptops" },
    ],
  });

  assert.strictEqual(CURATED_DISCOVERY_CATEGORY_SLUGS.length, 10);
  assert.strictEqual(isDiscoveryCategoryVisible("electronics"), true);
  assert.strictEqual(isDiscoveryCategoryVisible("printers"), false);
  const categoriesScreenSource = fs.readFileSync(path.join(__dirname, "..", "app", "(tabs)", "categories.tsx"), "utf8");
  assert.doesNotMatch(categoriesScreenSource, /list\.push\(/, "product labels must not create discovery navigation tiles");
  const canonicalCliSource = fs.readFileSync(path.join(__dirname, "catalog-taxonomy-canonical.js"), "utf8");
  assert.match(canonicalCliSource, /internal-only/, "canonical taxonomy inspection must distinguish internal-only nodes");

  const loadedCatalog = loadAndValidateCatalogData(path.join(__dirname, "..", "catalog-data"), (await import("../lib/catalogMatching.ts")).normalizeCatalogText);
  assert.ok(loadedCatalog.taxonomy.subcategoryByPath.has("electronics::printers-and-scanners"), "Printers & Scanners must exist as a canonical internal node");
  assert.ok(loadedCatalog.taxonomy.subcategoryByPath.has("electronics::printers-and-scanners/printing-supplies/ink-cartridges"), "Ink Cartridges must exist under Printing Supplies");
  assert.ok(loadedCatalog.taxonomy.subcategoryByPath.has("electronics::printers-and-scanners/printing-media/large-format-media"), "Large Format Media must exist under Printing Media");
  assert.strictEqual(isDiscoveryCategoryVisible("printers-and-scanners"), false, "internal printing taxonomy must not become discovery-visible");
  assert.strictEqual(isDiscoveryCategoryVisible("electronics"), true, "core discovery categories must remain visible");

  const coveragePlanner = require("./catalog-taxonomy-coverage.js");
  assert.strictEqual(typeof coveragePlanner.computeCoverage, "function", "coverage planner must exist");

  const coverageLedgerPath = path.join(__dirname, "..", ".catalog-staging", "taxonomy-coverage.test.json");
  const coverageStore = new LocalStagingStore(coverageLedgerPath);
  coverageStore.reset();
  const coverageRun = await coverageStore.createImportRun({ id: "source-coverage-test", name: "coverage-source", type: "open-icecat", baseUrl: null, trustClassification: "staged", active: true, notes: null, metadata: {} }, {
    adapter: "open-icecat", dryRun: true, processed: 100, valid: 100, invalid: 0, exactExisting: 0, likelyExisting: 0, possibleExisting: 0, newRecords: 100, conflictRecords: 0, approved: 0, rejected: 0, promoted: 0, staged: 100, errors: 0, status: "completed", summary: {},
  });
  const mappedCounts = new Map([["971", 18], ["846", 13], ["853", 12], ["377", 10], ["151", 9], ["714", 8], ["845", 3], ["702", 3], ["905", 3]]);
  const unresolvedCounts = new Map([["847", 13], ["292", 3], ["221", 2], ["1066", 1], ["222", 1], ["154", 1]]);
  const coverageCandidates = [];
  let candidateNumber = 0;
  for (const [externalId, count] of [...mappedCounts, ...unresolvedCounts]) {
    for (let index = 0; index < count; index += 1) {
      candidateNumber += 1;
      coverageCandidates.push({
        id: `candidate-${candidateNumber}`,
        importRunId: coverageRun.id,
        sourceId: "source-coverage-test",
        sourceExternalId: `${externalId}-${index}`,
        fingerprint: `fp-${externalId}-${index}`,
        status: "pending",
        classification: "NEW",
        brand: "Fixture",
        productName: `Product ${candidateNumber}`,
        modelNumber: null,
        family: null,
        category: null,
        subcategory: null,
        aliases: [],
        sourceUrl: null,
        imageUrl: null,
        sourceType: "open-icecat",
        upc: null,
        gtin: null,
        mpn: null,
        externalTaxonomy: { provider: "open-icecat", externalId, name: externalId === "847" ? "Photo Paper" : `External ${externalId}` },
        rawPayload: { provider: "open-icecat", externalTaxonomy: { provider: "open-icecat", externalId } },
        confidence: 0.9,
        createdAt: "2026-09-16T00:00:00.000Z",
        updatedAt: "2026-09-16T00:00:00.000Z",
      });
    }
  }
  coverageCandidates.push({ ...coverageCandidates[0], id: "foreign-candidate", importRunId: "foreign-run", fingerprint: "foreign-fingerprint" });
  await coverageStore.upsertStagedCandidates(coverageCandidates);
  const laptopTarget = await store.validateCanonicalTarget("cat-electronics", "sub-laptops");
  await store.upsertMapping({ identity: { provider: "OPEN-ICECAT", externalId: " 151 ", name: "Laptops" }, status: "verified", method: "manual" }, laptopTarget);
  await store.upsertMapping({ identity: { provider: "open-icecat", externalId: "847", name: "Photo Paper" }, status: "suggested", method: "automated_suggestion" }, laptopTarget);
  await store.upsertMapping({ identity: { provider: "open-icecat", externalId: "292", name: "Rejected" }, status: "rejected", method: "manual" }, laptopTarget);
  await store.upsertMapping({ identity: { provider: "other-provider", externalId: "151", name: "Other Laptops" }, status: "verified", method: "manual" }, laptopTarget);
  const planPath = path.join(__dirname, "..", "docs", "catalog-taxonomy-mapping-plan.json");
  const computed = await coveragePlanner.computeCoverage({ runId: coverageRun.id, backend: "local", planPath, logger: console }, { store: coverageStore, mappingStore: store });
  assert.strictEqual(computed.totalRunProducts, 100, "coverage planner must compute actual run totals from persisted data");
  assert.strictEqual(computed.currentlyResolvedProducts, 9, "persisted verified 151 mapping must resolve its nine products");
  assert.strictEqual(computed.currentlyUnresolvedProducts, 91, "only products without persisted verified mappings remain currently unresolved");
  assert.strictEqual(computed.newlyResolvedProducts, 70, "persistently resolved products must not be double-counted as proposed-new");
  assert.strictEqual(computed.resolvedAfterPlanProducts, 79, "resolved-after-plan products must be weighted by source count");
  assert.strictEqual(computed.unresolvedAfterPlanProducts, 21, "unmapped taxonomy IDs must retain their product source counts");
  assert.strictEqual(computed.resolvedAfterPlanProducts + computed.unresolvedAfterPlanProducts, computed.totalRunProducts, "product-level coverage must conserve total products");
  assert.strictEqual(computed.mappedExternalTaxonomyIds, 9, "mapped taxonomy ID count must remain separate from product count");
  assert.strictEqual(computed.unresolvedExternalTaxonomyIds, 6, "unresolved taxonomy ID count must remain separate from product count");
  assert.strictEqual(computed.byExternalCategory.find((row) => row.externalId === "971").sourceCount, 18, "971 must contribute 18 products");
  assert.strictEqual(computed.byExternalCategory.find((row) => row.externalId === "971").newlyResolvedCount, 18, "971 must contribute 18 newly resolved products");
  assert.strictEqual(computed.byExternalCategory.find((row) => row.externalId === "151").currentResolution, "resolved", "persisted verified 151 mapping must be current");
  assert.strictEqual(computed.byExternalCategory.find((row) => row.externalId === "151").currentResolvedCount, 9, "151 current resolution must contribute nine products");
  assert.strictEqual(computed.byExternalCategory.find((row) => row.externalId === "151").newlyResolvedCount, 0, "151 must contribute zero proposed-new products");
  assert.strictEqual(computed.byExternalCategory.find((row) => row.externalId === "847").currentResolution, "unresolved", "suggested mappings must not count as current resolution");
  assert.strictEqual(computed.byExternalCategory.find((row) => row.externalId === "292").currentResolution, "unresolved", "rejected mappings must not count as current resolution");
  assert.strictEqual(computed.byExternalCategory.find((row) => row.externalId === "847").afterPlanState, "unresolved", "847 must remain unresolved");

  const verifiedRun = await coverageStore.createImportRun({ id: "source-verified-test", name: "verified-source", type: "open-icecat", baseUrl: null, trustClassification: "staged", active: true, notes: null, metadata: {} }, {
    adapter: "open-icecat", dryRun: true, processed: 2, valid: 2, invalid: 0, exactExisting: 0, likelyExisting: 0, possibleExisting: 0, newRecords: 2, conflictRecords: 0, approved: 0, rejected: 0, promoted: 0, staged: 2, errors: 0, status: "completed", summary: {},
  });
  await coverageStore.upsertStagedCandidates([
    { ...coverageCandidates[0], id: "verified-151-1", importRunId: verifiedRun.id, sourceExternalId: "verified-151-1", fingerprint: "verified-fp-1", rawPayload: { provider: "open-icecat", externalTaxonomy: { provider: "open-icecat", externalId: "151" }, taxonomyMapping: { status: "verified" } } },
    { ...coverageCandidates[1], id: "verified-151-2", importRunId: verifiedRun.id, sourceExternalId: "verified-151-2", fingerprint: "verified-fp-2", rawPayload: { provider: "open-icecat", externalTaxonomy: { provider: "open-icecat", externalId: "151" }, taxonomyMapping: { status: "verified" } } },
  ]);
  const verifiedComputed = await coveragePlanner.computeCoverage({ runId: verifiedRun.id, backend: "local", planPath, logger: null }, { store: coverageStore });
  assert.strictEqual(verifiedComputed.currentlyResolvedProducts, 2, "persisted verified products must count as currently resolved");
  assert.strictEqual(verifiedComputed.newlyResolvedProducts, 0, "persisted verified products must not be double-counted as proposed-new");
  assert.strictEqual(verifiedComputed.resolvedAfterPlanProducts, 2, "verified products must remain resolved after the plan");
  assert.strictEqual(verifiedComputed.totalRunProducts, 2, "run isolation must exclude candidates from other runs");
  fs.rmSync(coverageLedgerPath, { force: true });

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

  const repeatedIds = ["151", "846", "971", "702", "905"];
  let repeatedResolverCalls = 0;
  const repeatedResolver = async (identity) => {
    repeatedResolverCalls += 1;
    if (!repeatedIds.includes(identity.externalId)) return null;
    return {
      id: `mapping-${identity.externalId}`,
      provider: identity.provider,
      externalTaxonomyId: identity.externalId,
      externalName: `Taxonomy ${identity.externalId}`,
      externalPath: null,
      externalParentId: null,
      externalParentPath: null,
      canonicalCategoryId: "cat-electronics",
      canonicalCategoryName: "Electronics",
      canonicalSubcategoryId: identity.externalId === "151" ? "sub-laptops" : null,
      canonicalSubcategoryName: identity.externalId === "151" ? "Laptops" : null,
      status: "verified",
      method: "manual",
      confidence: 1,
      evidence: {},
      reviewedBy: "test",
      reviewedAt: "2026-09-16T00:00:00.000Z",
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
    };
  };
  const repeatedBatch = Array.from({ length: 100 }, (_, index) => ({
    sourceExternalId: `repeated-${index}`,
    brand: "Repeated",
    productName: `Repeated Product ${index}`,
    externalTaxonomy: { provider: "open-icecat", externalId: repeatedIds[index % repeatedIds.length], name: `Category ${repeatedIds[index % repeatedIds.length]}` },
    raw: { provider: "open-icecat", externalTaxonomy: { provider: "open-icecat", externalId: repeatedIds[index % repeatedIds.length], name: `Category ${repeatedIds[index % repeatedIds.length]}` } },
  }));
  const repeatedScopedResolver = createRunScopedTaxonomyResolver(repeatedResolver);
  await acquireFromRecords(repeatedBatch, [], { name: "taxonomy-batch", type: "external-provider" }, { taxonomyResolver: repeatedScopedResolver });
  assert.ok(repeatedScopedResolver.getMetrics().cacheHits >= 95, `reused taxonomy IDs must count as cache hits; saw ${repeatedScopedResolver.getMetrics().cacheHits} hits for 100 repeated records`);
  assert.ok(repeatedScopedResolver.getMetrics().cacheMisses <= repeatedIds.length, `cache misses must remain bounded by unique taxonomy IDs; saw ${repeatedScopedResolver.getMetrics().cacheMisses} misses for ${repeatedIds.length} unique IDs`);
  assert.ok(repeatedResolverCalls <= repeatedIds.length, `repeated taxonomy IDs must reuse a run-scoped cache instead of resolving once per product; saw ${repeatedResolverCalls} calls for ${repeatedIds.length} unique ids`);

  const pageResolverCalls = [];
  const pageResolver = async (identity) => {
    pageResolverCalls.push(`${identity.provider}:${identity.externalId}`);
    if (identity.externalId === "151") {
      return { id: "mapping-151", provider: identity.provider, externalTaxonomyId: "151", externalName: "Laptops", externalPath: null, externalParentId: null, externalParentPath: null, canonicalCategoryId: "cat-electronics", canonicalCategoryName: "Electronics", canonicalSubcategoryId: "sub-laptops", canonicalSubcategoryName: "Laptops", status: "verified", method: "manual", confidence: 1, evidence: {}, reviewedBy: "test", reviewedAt: "2026-09-16T00:00:00.000Z", createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:00.000Z" };
    }
    if (identity.externalId === "846") {
      return { id: "mapping-846", provider: identity.provider, externalTaxonomyId: "846", externalName: "Printers", externalPath: null, externalParentId: null, externalParentPath: null, canonicalCategoryId: "cat-electronics", canonicalCategoryName: "Electronics", canonicalSubcategoryId: "sub-printers", canonicalSubcategoryName: "Printers", status: "verified", method: "manual", confidence: 1, evidence: {}, reviewedBy: "test", reviewedAt: "2026-09-16T00:00:00.000Z", createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:00.000Z" };
    }
    return null;
  };
  const pageProvider = {
    capabilities: { lookup: false, discovery: true },
    getSourceMetadata: () => ({ name: "page-cache-source", type: "external-provider", baseUrl: "https://example.test", metadata: {} }),
    normalizeProduct: (record) => record,
    async *discoverProducts() {
      yield { records: [
        { sourceExternalId: "page-1-a", brand: "Brand A", productName: "Product A", externalTaxonomy: { provider: "open-icecat", externalId: "151", name: "Laptops" }, raw: { provider: "open-icecat", externalTaxonomy: { provider: "open-icecat", externalId: "151", name: "Laptops" } } },
        { sourceExternalId: "page-1-b", brand: "Brand B", productName: "Product B", externalTaxonomy: { provider: "open-icecat", externalId: "846", name: "Printers" }, raw: { provider: "open-icecat", externalTaxonomy: { provider: "open-icecat", externalId: "846", name: "Printers" } } },
        { sourceExternalId: "page-1-c", brand: "Brand C", productName: "Product C", externalTaxonomy: { provider: "open-icecat", externalId: "151", name: "Laptops" }, raw: { provider: "open-icecat", externalTaxonomy: { provider: "open-icecat", externalId: "151", name: "Laptops" } } },
      ], errors: [], nextCursor: "page-2", done: false, checkpoint: { processedCount: 3, enrichmentAttempts: 3 } };
      yield { records: [
        { sourceExternalId: "page-2-a", brand: "Brand D", productName: "Product D", externalTaxonomy: { provider: "open-icecat", externalId: "151", name: "Laptops" }, raw: { provider: "open-icecat", externalTaxonomy: { provider: "open-icecat", externalId: "151", name: "Laptops" } } },
        { sourceExternalId: "page-2-b", brand: "Brand E", productName: "Product E", externalTaxonomy: { provider: "open-icecat", externalId: "846", name: "Printers" }, raw: { provider: "open-icecat", externalTaxonomy: { provider: "open-icecat", externalId: "846", name: "Printers" } } },
        { sourceExternalId: "page-2-c", brand: "Brand F", productName: "Product F", externalTaxonomy: { provider: "open-icecat", externalId: "971", name: "Large Format Media" }, raw: { provider: "open-icecat", externalTaxonomy: { provider: "open-icecat", externalId: "971", name: "Large Format Media" } } },
      ], errors: [], nextCursor: null, done: true, checkpoint: { processedCount: 6, enrichmentAttempts: 6 } };
    },
  };
  const multiPageRun = await acquisition.acquireDiscoveredProducts(pageProvider, { limit: 6, pageSize: 3 }, [], { name: "page-cache-source", type: "external-provider" }, { taxonomyResolver: pageResolver });
  assert.ok(pageResolverCalls.length <= 3, `repeated taxonomy IDs across discovery pages must share the same run-scoped cache; saw ${pageResolverCalls.length} calls across 3 unique identifiers`);
  assert.strictEqual(multiPageRun.staged.length, 6, "multi-page catalog discovery must continue to stage each valid record even with cached taxonomy resolution");
  fs.rmSync(ledgerPath, { force: true });
  fs.rmSync(taxonomyCachePath, { force: true });
  fs.rmSync(path.join(__dirname, "..", ".catalog-staging", "taxonomy-acquisition.test.json"), { force: true });
  console.log("Catalog taxonomy tests passed.");
}

main().catch((error) => { console.error(error); process.exit(1); });
