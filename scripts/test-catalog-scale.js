#!/usr/bin/env node
const assert = require("assert");

(async () => {
  const acquisition = await import("../lib/catalogAcquisition.ts");

  const profile100 = acquisition.resolveScaleProfile("100");
  assert.strictEqual(profile100.limit, 100, "100-profile must resolve to 100 requested products");
  assert.strictEqual(profile100.label, "100");
  assert.strictEqual(profile100.dryRun, true, "scale profile defaults to dry-run");

  const profile500 = acquisition.resolveScaleProfile("500");
  assert.strictEqual(profile500.limit, 500, "500-profile must resolve to 500 requested products");
  assert.strictEqual(profile500.label, "500");

  const profile1000 = acquisition.resolveScaleProfile(1000, 25);
  assert.strictEqual(profile1000.limit, 1000, "explicit 1000 profile must override a small explicit limit");
  assert.strictEqual(profile1000.label, "1000");

  const report = {
    currentRunId: "run-scale-1",
    executionMode: "dry-run",
    run: null,
    candidates: [],
    metrics: {
      requested: 500,
      fetched: 500,
      enriched: 500,
      processed: 500,
      valid: 480,
      invalid: 20,
      exactExisting: 0,
      likelyExisting: 20,
      possibleExisting: 10,
      new: 430,
      conflict: 20,
      staged: 0,
      errors: 0,
      providerErrors: 0,
      elapsedMs: 120000,
      providerPages: 5,
      indexCandidatesExamined: 500,
      enrichmentAttempts: 500,
      imageCoverage: 0.9,
      gtinCoverage: 0.8,
      modelCoverage: 0.95,
      brandCoverage: 0.92,
      externalTaxonomyCoverage: 0.75,
      trustedMappingCoverage: 0.65,
      unresolvedTaxonomy: 200,
      missingTaxonomyIdentity: 0,
      manualReviewRequired: 25,
      promotionReady: 300,
    },
    sample: [],
  };

  const gate = acquisition.evaluateControlledScaleGates(report);
  assert.strictEqual(gate.advisory, true);
  assert.strictEqual(gate.discoveryHealth, "PASS");
  assert.strictEqual(gate.identityQuality, "REVIEW");
  assert.strictEqual(gate.taxonomyCoverage, "REVIEW");
  assert.strictEqual(gate.stagingSafety, "PASS");
  assert.strictEqual(gate.canonicalSafety, "PASS");
  assert.strictEqual(gate.overall, "REVIEW");

  // -------------------------------------------------------------------
  // CLI wiring regression: exercise the exact function sequence
  // scripts/catalog-acquire-icecat.js runs for a dry-run discovery
  // acquisition (acquireDiscoveredProducts -> buildCatalogRunReportFromResult
  // -> rankTaxonomyGaps -> evaluateControlledScaleGates -> format*), proving
  // the scale report is produced from the SAME in-memory run, with zero
  // persisted import run (dry-run never writes one), and without needing a
  // live Icecat call or a second acquisition.
  // -------------------------------------------------------------------
  const records = [];
  for (let index = 0; index < 3; index += 1) {
    records.push({
      sourceExternalId: `printer-${index + 1}`,
      brand: "HP",
      productName: `HP Printer Model ${index + 1}`,
      modelNumber: `HP-${index + 1}`,
      imageUrl: `https://example.test/hp-${index + 1}.jpg`,
      externalTaxonomy: { provider: "open-icecat", externalId: "846", name: "Printers" },
      raw: { provider: "open-icecat", externalTaxonomy: { provider: "open-icecat", externalId: "846", name: "Printers" } },
    });
  }
  for (let index = 0; index < 2; index += 1) {
    records.push({
      sourceExternalId: `laptop-${index + 1}`,
      brand: "Canon",
      productName: `Canon Laptop Model ${index + 1}`,
      modelNumber: `CAN-${index + 1}`,
      imageUrl: `https://example.test/canon-${index + 1}.jpg`,
      gtin: `GTIN-LAPTOP-${index + 1}`,
      externalTaxonomy: { provider: "open-icecat", externalId: "151", name: "Laptops" },
      raw: { provider: "open-icecat", externalTaxonomy: { provider: "open-icecat", externalId: "151", name: "Laptops" } },
    });
  }
  for (let index = 0; index < 6; index += 1) {
    records.push({
      sourceExternalId: `generic-${index + 1}`,
      brand: "Generic",
      productName: `Generic Accessory ${index + 1}`,
      modelNumber: `GEN-${index + 1}`,
      imageUrl: `https://example.test/generic-${index + 1}.jpg`,
      gtin: index < 3 ? `GTIN-GENERIC-${index + 1}` : null,
      raw: { provider: "open-icecat" },
    });
  }
  records.push({
    sourceExternalId: "invalid-1",
    brand: "",
    productName: "",
    raw: { provider: "open-icecat" },
  });

  const fixtureProvider = {
    capabilities: { lookup: false, discovery: true },
    getSourceMetadata: () => ({ name: "scale-cli-fixture", type: "external-provider", baseUrl: "https://example.test", metadata: {} }),
    normalizeProduct: (record) => record,
    async *discoverProducts() {
      yield {
        records: records.slice(0, 5),
        errors: [{ message: "Icecat product enrichment failed: Icecat HTTP 404 Not Found", sourceExternalId: "missing-1" }],
        nextCursor: "a",
        done: false,
        checkpoint: { processedCount: 6, enrichmentAttempts: 6 },
      };
      yield {
        records: records.slice(5, 10),
        errors: [{ message: "Icecat product enrichment failed: Icecat HTTP 404 Not Found", sourceExternalId: "missing-2" }],
        nextCursor: "b",
        done: false,
        checkpoint: { processedCount: 11, enrichmentAttempts: 12 },
      };
      yield {
        records: records.slice(10, 12),
        errors: [{ message: "Icecat product enrichment failed: Icecat HTTP 404 Not Found", sourceExternalId: "missing-3" }],
        nextCursor: null,
        done: true,
        checkpoint: { processedCount: 13, enrichmentAttempts: 15 },
      };
    },
  };

  const verifiedLaptopMapping = {
    id: "mapping-151",
    provider: "open-icecat",
    externalTaxonomyId: "151",
    externalName: "Laptops",
    externalPath: null,
    externalParentId: null,
    externalParentPath: null,
    canonicalCategoryId: "cat-electronics",
    canonicalCategoryName: "Electronics",
    canonicalSubcategoryId: "sub-laptops",
    canonicalSubcategoryName: "Laptops",
    status: "verified",
    method: "manual",
    confidence: 1,
    evidence: {},
    reviewedBy: null,
    reviewedAt: null,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };

  const discoveryRun = await acquisition.acquireDiscoveredProducts(
    fixtureProvider,
    { limit: 12, pageSize: 5 },
    [],
    fixtureProvider.getSourceMetadata(),
    {
      apply: false,
      adapter: "open-icecat",
      taxonomyResolver: async (identity) => (identity.externalId === "151" ? verifiedLaptopMapping : null),
    }
  );

  // Dry-run never persists an import run -- proving the completed run truly
  // cannot be looked up afterwards, only reported from this same invocation.
  assert.strictEqual(discoveryRun.runId, undefined, "dry-run acquisition must never persist an import run ID");
  assert.strictEqual(discoveryRun.persistence.length, 0, "dry-run acquisition must perform zero store writes");
  assert.strictEqual(discoveryRun.fetched, 12);
  assert.strictEqual(discoveryRun.enriched, 12);
  assert.strictEqual(discoveryRun.pages, 3);
  assert.strictEqual(discoveryRun.providerErrors.length, 3, "the three simulated 404 enrichment failures must be reported as provider errors, not usable enrichments");
  assert.strictEqual(discoveryRun.matcherMetrics.indexBuildCount, 1, "multi-page discovery must build the matcher index once");
  assert.strictEqual(discoveryRun.matcherMetrics.recordsClassified, 11, "matcher telemetry must count valid classified records");

  const cliReport = acquisition.buildCatalogRunReportFromResult(discoveryRun, { requestedLimit: 12 });
  assert.strictEqual(cliReport.currentRunId, null, "a dry-run report has no persisted run ID to key off of");
  assert.strictEqual(cliReport.executionMode, "dry-run");
  assert.strictEqual(cliReport.metrics.requested, 12);
  assert.strictEqual(cliReport.metrics.fetched, 12);
  assert.strictEqual(cliReport.metrics.enriched, 12, "RECORDS ENRICHED must count only usable enrichments, not attempts");
  assert.strictEqual(cliReport.metrics.enrichmentAttempts, 15, "attempted enrichments (including the 3 failures) must be distinguishable from usable enriched count");
  assert.strictEqual(cliReport.metrics.enrichmentAttempts - cliReport.metrics.enriched, 3, "enrichment failures must reconcile against attempts minus usable enrichments");
  assert.strictEqual(cliReport.metrics.indexCandidatesExamined, 13);
  assert.strictEqual(cliReport.metrics.providerErrors, 3);
  assert.strictEqual(cliReport.metrics.providerPages, 3);
  assert.strictEqual(typeof cliReport.metrics.elapsedMs, "number");
  assert.strictEqual(cliReport.metrics.requestedLimitReached, true, "12 requested and 12 usable enrichments means the requested usable limit was reached");
  assert.strictEqual(cliReport.metrics.valid, 11);
  assert.strictEqual(cliReport.metrics.invalid, 1);
  assert.strictEqual(cliReport.metrics.new, 11);
  assert.strictEqual(cliReport.metrics.conflict, 0);
  assert.strictEqual(cliReport.metrics.productNameCoverage, 1);
  assert.strictEqual(cliReport.metrics.sourceExternalIdCoverage, 1);
  assert.strictEqual(cliReport.metrics.brandCoverage, 1);
  assert.strictEqual(cliReport.metrics.modelCoverage, 1);
  assert.strictEqual(cliReport.metrics.imageCoverage, 1);
  assert.strictEqual(cliReport.metrics.gtinCoverage, Number((5 / 11).toFixed(4)), "gtin coverage must reflect only the valid staged candidates");
  assert.strictEqual(cliReport.metrics.externalTaxonomyCoverage, 5 / 11, "provider taxonomy ID coverage must reflect records carrying an external taxonomy identity");
  assert.strictEqual(cliReport.metrics.taxonomyResolvedProducts, 2, "only the two verified-mapping laptop records are resolved");
  assert.strictEqual(cliReport.metrics.unresolvedTaxonomy, 3, "the three printer records with an unmapped external taxonomy ID must be unresolved");
  assert.strictEqual(cliReport.metrics.missingTaxonomyIdentity, 6, "records without provider taxonomy identity must remain visible in taxonomy reporting");
  assert.strictEqual(cliReport.metrics.trustedMappingCoverage, 2 / 11);
  assert.strictEqual(cliReport.metrics.taxonomyResolvedPercentage, 2 / 11);
  assert.strictEqual(cliReport.metrics.wouldStage, 2, "only records with a resolved canonical hierarchy are stage-ready without review");
  assert.strictEqual(cliReport.metrics.blockedForReview, 9);
  assert.strictEqual(cliReport.metrics.duplicateFingerprintCollisions, 0);
  assert.strictEqual(cliReport.candidates.length, 11);

  const applyReport = acquisition.buildCatalogRunReportFromResult({ ...discoveryRun, executionMode: "apply" }, { requestedLimit: 12 });
  assert.strictEqual(applyReport.executionMode, "apply");
  assert.strictEqual(acquisition.evaluateControlledScaleGates(applyReport).canonicalSafety, "REVIEW", "apply mode must never receive canonical-safety PASS");

  const mappingRecords = [verifiedLaptopMapping];
  const gaps = acquisition.rankTaxonomyGaps(cliReport.currentRunId, cliReport.candidates, mappingRecords);
  assert.strictEqual(gaps.length, 1, "the verified 151 mapping must be excluded from the unresolved gap ranking");
  assert.strictEqual(gaps[0].externalId, "846");
  assert.strictEqual(gaps[0].candidateCount, 3, "unresolved taxonomy IDs must be ranked by PRODUCT COUNT");
  assert.strictEqual(gaps[0].name, "Printers");
  assert.strictEqual(gaps[0].verifiedMapping, false);

  const cliGate = acquisition.evaluateControlledScaleGates(cliReport);
  assert.strictEqual(cliGate.discoveryHealth, "REVIEW", "non-zero provider errors must surface for review, never be silently PASS");
  assert.strictEqual(cliGate.identityQuality, "PASS");
  assert.strictEqual(cliGate.taxonomyCoverage, "REVIEW");
  assert.strictEqual(cliGate.stagingSafety, "PASS");
  assert.strictEqual(cliGate.canonicalSafety, "PASS", "a genuine dry-run report (no persisted run) must not be misclassified as unsafe");
  assert.strictEqual(cliGate.overall, "REVIEW");
  assert.strictEqual(cliGate.advisory, true, "gates are diagnostics and cannot authorize writes or workflow actions");
  assert.strictEqual(acquisition.evaluateControlledScaleGates({ ...cliReport, metrics: { ...cliReport.metrics, conflict: 1 } }).identityQuality, "REVIEW", "conflicts must remain visible as a review diagnostic");

  const formattedReport = acquisition.formatCatalogRunReport(cliReport);
  assert.match(formattedReport, /DISCOVERY/);
  assert.match(formattedReport, /DATA QUALITY/);
  assert.match(formattedReport, /TAXONOMY/);
  assert.match(formattedReport, /STAGING IMPACT/);
  assert.match(formattedReport, /Resolved products: 2/);
  assert.match(formattedReport, /Unresolved products: 3/);
  assert.match(formattedReport, /Missing taxonomy identity: 6/);
  assert.match(formattedReport, /Attempted enrichments: 15/);
  assert.match(formattedReport, /Failed detail requests: unavailable/);

  const formattedGaps = acquisition.formatTaxonomyGapReport(gaps);
  assert.match(formattedGaps, /846/);
  assert.match(formattedGaps, /products=3/);

  const formattedGate = acquisition.formatControlledScaleGateReport(cliGate);
  assert.match(formattedGate, /Discovery health: REVIEW/);
  assert.match(formattedGate, /Overall: REVIEW/);

  console.log("Catalog scale profile tests passed.");
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
