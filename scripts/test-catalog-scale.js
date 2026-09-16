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
      manualReviewRequired: 25,
      promotionReady: 300,
    },
    sample: [],
  };

  const gate = acquisition.evaluateControlledScaleGates(report);
  assert.strictEqual(gate.discoveryHealth, "PASS");
  assert.strictEqual(gate.identityQuality, "PASS");
  assert.strictEqual(gate.taxonomyCoverage, "REVIEW");
  assert.strictEqual(gate.stagingSafety, "PASS");
  assert.strictEqual(gate.canonicalSafety, "PASS");
  assert.strictEqual(gate.overall, "REVIEW");

  console.log("Catalog scale profile tests passed.");
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
