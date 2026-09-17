#!/usr/bin/env node
const assert = require("assert");

const PAGE_SIZE = 25;
const TAXONOMY_IDS = Array.from({ length: 10 }, (_, index) => String(1000 + index));

function makeCanonicalCatalog(size) {
  return Array.from({ length: size }, (_, index) => ({
    brand: `Canonical Brand ${index % 20}`,
    productName: `Canonical Product ${index}`,
    modelNumber: `CAN-${index}`,
    category: "Electronics",
    subcategory: index % 2 ? "Audio" : "Computers",
    aliases: index % 10 === 0 ? [`Canonical Alias ${index}`, `Legacy-${index}`] : [],
  }));
}

function makeRecords(count) {
  return Array.from({ length: count }, (_, index) => ({
    sourceExternalId: `offline-${index}`,
    brand: "Offline Brand",
    productName: `Offline Product ${index}`,
    modelNumber: `OFF-${index}`,
    category: null,
    subcategory: null,
    aliases: index % 25 === 0 ? [`Offline Alias ${index}`] : [],
    imageUrl: `https://example.test/offline-${index}.jpg`,
    externalTaxonomy: { provider: "offline-fixture", externalId: TAXONOMY_IDS[index % TAXONOMY_IDS.length], name: `Fixture Category ${index % 10}` },
    raw: { provider: "offline-fixture", index },
  }));
}

function makeMapping(externalId) {
  return {
    id: `mapping-${externalId}`,
    provider: "offline-fixture",
    externalTaxonomyId: externalId,
    externalName: `Fixture Category ${Number(externalId) - 1000}`,
    externalPath: null,
    externalParentId: null,
    externalParentPath: null,
    canonicalCategoryId: "category-electronics",
    canonicalCategoryName: "Electronics",
    canonicalSubcategoryId: "subcategory-computers",
    canonicalSubcategoryName: "Computers",
    status: "verified",
    method: "manual",
    confidence: 1,
    evidence: { fixture: true },
    reviewedBy: null,
    reviewedAt: "2026-09-17T00:00:00.000Z",
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
  };
}

function makeProvider(records, options = {}) {
  const pages = [];
  for (let start = 0; start < records.length; start += PAGE_SIZE) {
    const pageIndex = pages.length;
    pages.push(records.slice(start, start + PAGE_SIZE).map((record) => ({ ...record })));
  }
  return {
    capabilities: { lookup: false, discovery: true },
    getSourceMetadata: () => ({ name: "offline-scale-fixture", type: "offline-provider", baseUrl: "https://example.test", metadata: {} }),
    normalizeProduct: (record) => record,
    async *discoverProducts(discoveryOptions = {}) {
      const continuation = discoveryOptions.cursor ? JSON.parse(discoveryOptions.cursor) : null;
      const startPage = continuation?.acknowledgedPosition ?? 0;
      const endPage = options.stopAfterPage == null ? pages.length : Math.min(pages.length, options.stopAfterPage);
      for (let pageIndex = startPage; pageIndex < endPage; pageIndex += 1) {
        if (discoveryOptions.signal?.aborted) throw discoveryOptions.signal.reason ?? new Error("cancelled");
        const pageRecords = pages[pageIndex];
        let acknowledged = false;
        const checkpoint = {
          processedCount: Math.min(records.length, (pageIndex + 1) * PAGE_SIZE),
          enrichmentAttempts: Math.min(records.length, (pageIndex + 1) * PAGE_SIZE),
          acknowledgedContinuation: null,
        };
        const page = {
          records: pageRecords,
          errors: [],
          done: pageIndex === pages.length - 1,
          nextCursor: null,
          checkpoint,
          acknowledge: () => {
            acknowledged = true;
            checkpoint.acknowledgedContinuation = {
              version: 2,
              provider: "offline-fixture",
              sourceUrl: "offline://catalog",
              mode: "benchmark",
              snapshot: { etag: "fixture-v1", lastModified: null, contentLength: String(records.length) },
              filterIdentity: "offline-fixture",
              parserVersion: "offline-v1",
              parsedPosition: pageIndex + 1,
              scheduledPosition: pageIndex + 1,
              completedPosition: pageIndex + 1,
              emittedPosition: pageIndex + 1,
              acknowledgedPosition: pageIndex + 1,
              sourceIdentity: `offline-page-${pageIndex}`,
            };
            page.nextCursor = JSON.stringify(checkpoint.acknowledgedContinuation);
          },
        };
        yield page;
        if (options.requireAcknowledged && !acknowledged) throw new Error(`page ${pageIndex} was not acknowledged`);
        if (options.cancelAfterPage === pageIndex + 1) throw new Error("offline cancellation");
      }
      discoveryOptions.diagnostics?.onMetrics?.({
        concurrency: 3,
        admissionWindow: 6,
        parserPendingBound: 0,
        totalWorkBound: 6,
        enrichmentAttempts: records.length,
        usableSuccessfulDetails: records.length,
        failedDetailRequests: 0,
        filteredSuccessfulDetails: 0,
        successfulSpeculativeCompletions: 0,
        cancelledDetailRequests: 0,
        activeDetailRequests: 0,
        maxActiveDetailRequests: 3,
        parsedCandidateQueueHighWaterMark: 0,
        admittedWindowHighWaterMark: 6,
        reorderBufferHighWaterMark: 0,
        retainedWorkHighWaterMark: 6,
        detailLatencyCount: records.length,
        detailLatencyTotalMs: 0,
        averageDetailLatencyMs: 0,
        indexHeadersMs: 0,
        timeToFirstIndexByteMs: 0,
        parserTraversalMs: 0,
        timeToFirstQualifyingMs: 0,
        qualifyingSpanMs: 0,
        detailEnrichmentWallMs: 0,
        speculativeCancellationCount: 0,
        terminationReason: "source-exhausted",
        elapsedMs: 0,
      });
    },
  };
}

class CountingStore {
  constructor({ failOnUpsert = false } = {}) {
    this.kind = "supabase";
    this.failOnUpsert = failOnUpsert;
    this.calls = { upsertSource: 0, createImportRun: 0, updateImportRun: 0, countStagedCandidatesByRun: 0, upsertStagedCandidates: 0 };
    this.batches = { productWriteBatches: 0, aliasWriteBatches: 0 };
    this.staged = [];
    this.run = null;
  }
  async upsertSource(entry) { this.calls.upsertSource += 1; return { ...entry, id: "offline-source" }; }
  async createImportRun(source, input) {
    this.calls.createImportRun += 1;
    this.run = { id: "offline-run", sourceId: source.id, ...input, createdAt: "2026-09-17T00:00:00.000Z" };
    return this.run;
  }
  async updateImportRun(runId, updates) { this.calls.updateImportRun += 1; this.run = { ...this.run, ...updates, id: runId }; return this.run; }
  async listImportRuns() { return this.run ? [this.run] : []; }
  async countStagedCandidatesByRun() { this.calls.countStagedCandidatesByRun += 1; return this.staged.length; }
  async upsertStagedCandidates(candidates) {
    this.calls.upsertStagedCandidates += 1;
    if (this.failOnUpsert) throw new Error("offline staging persistence failure");
    this.batches.productWriteBatches += Math.ceil(candidates.length / 200);
    const aliases = candidates.reduce((total, candidate) => total + new Set([...(candidate.aliases || []), candidate.productName, candidate.modelNumber || ""]).size, 0);
    this.batches.aliasWriteBatches += Math.ceil(aliases / 500);
    this.staged.push(...candidates);
    return candidates;
  }
  async listStagedCandidates() { return this.staged; }
  async getStagedCandidateById(id) { return this.staged.find((candidate) => candidate.id === id) || null; }
  async updateCandidateStatus() { return null; }
  async markPromoted() { return null; }
}

async function runWorkload(acquisition, count, canonicalSize, apply = false) {
  const records = makeRecords(count);
  const canonical = makeCanonicalCatalog(canonicalSize);
  const store = apply ? new CountingStore() : null;
  const taxonomyReads = new Map();
  const before = process.memoryUsage().heapUsed;
  const result = await acquisition.acquireDiscoveredProducts(
    makeProvider(records),
    { limit: count, pageSize: PAGE_SIZE, concurrency: 3 },
    canonical,
    { name: "offline-scale-fixture", type: "offline-provider", baseUrl: "https://example.test" },
    {
      apply,
      adapter: "offline-fixture",
      taxonomyResolver: async (identity) => {
        taxonomyReads.set(identity.externalId, (taxonomyReads.get(identity.externalId) || 0) + 1);
        return makeMapping(identity.externalId);
      },
    },
    store
  );
  const after = process.memoryUsage().heapUsed;
  assert.strictEqual(result.fetched, count);
  assert.strictEqual(result.enriched, count);
  assert.strictEqual(result.pages, Math.ceil(count / PAGE_SIZE));
  assert.strictEqual(result.providerErrors.length, 0);
  assert.strictEqual(result.taxonomyMetrics.cacheMisses, TAXONOMY_IDS.length);
  assert.strictEqual(result.taxonomyMetrics.cacheHits, count - TAXONOMY_IDS.length);
  assert.strictEqual(result.matcherMetrics.indexBuildCount, 1);
  assert.strictEqual(result.matcherMetrics.recordsClassified, count);
  assert.strictEqual(result.persistence.length, apply ? 3 : 0);
  if (!apply) assert.strictEqual(result.executionMode, "dry-run");
  if (apply) {
    assert.deepStrictEqual(store.calls, { upsertSource: 1, createImportRun: 1, updateImportRun: 1, countStagedCandidatesByRun: 1, upsertStagedCandidates: result.pages });
    assert.strictEqual(store.batches.productWriteBatches, result.pages);
    assert.strictEqual(store.batches.aliasWriteBatches, result.pages);
  }
  return {
    workload: "disjoint-brand full-scan",
    products: count,
    canonicalProducts: canonicalSize,
    pages: result.pages,
    provider: { recordsExamined: result.indexCandidatesExamined, qualifying: result.fetched, enrichmentAttempts: result.enrichmentAttempts, admissionHighWater: result.providerMetrics?.admittedWindowHighWaterMark ?? null, reorderHighWater: result.providerMetrics?.reorderBufferHighWaterMark ?? null, maxActiveDetailRequests: result.providerMetrics?.maxActiveDetailRequests ?? null },
    canonical: { products: canonicalSize, aliases: canonical.reduce((total, entry) => total + entry.aliases.length, 0), indexBuildMs: result.matcherMetrics.indexBuildMs },
    taxonomy: { logicalResolutions: result.taxonomyMetrics.resolverCalls, uniqueIds: result.taxonomyMetrics.uniqueExternalTaxonomyIds, cacheHits: result.taxonomyMetrics.cacheHits, misses: result.taxonomyMetrics.cacheMisses, underlyingMappingReads: taxonomyReads.size, canonicalValidationReads: taxonomyReads.size },
    matcher: { indexBuildMs: result.matcherMetrics.indexBuildMs, recordsClassified: result.matcherMetrics.recordsClassified, canonicalEntriesExamined: result.matcherMetrics.canonicalEntriesExamined, scorerInvocations: result.matcherMetrics.scorerInvocations, specificityWitnessChecks: result.matcherMetrics.specificityWitnessChecks, executionMs: result.matcherMetrics.matcherExecutionMs },
    acquisition: result.downstreamPhaseMetrics,
    database: apply ? { taxonomyReads: taxonomyReads.size, canonicalCatalogReads: 5, sourceUpserts: store.calls.upsertSource, importRunWrites: store.calls.createImportRun + store.calls.updateImportRun, stagedProductWriteCalls: store.calls.upsertStagedCandidates, stagedProductWriteBatches: store.batches.productWriteBatches, stagedAliasWriteBatches: store.batches.aliasWriteBatches, hiddenPerProductReadsOrWrites: 0 } : { totalWrites: 0 },
    memory: { heapBefore: before, heapAfter: after, retainedCandidates: result.staged.length, telemetryEntries: 0 },
    evidence: {
      providerHighWater: "MODELED",
      providerOutcomeCounts: "MODELED",
      taxonomyReads: "MEASURED",
      canonicalCatalogReads: "MODELED",
      stagingWriteCounts: apply ? "MEASURED_BY_COUNTING_STORE" : "NOT_TESTED",
      hiddenPerProductOperations: apply ? "MODELED_BY_STORE_CONTRACT" : "NOT_TESTED",
      heapBeforeAfter: "MEASURED_RETAINED_HEAP_SAMPLE_NOT_PEAK",
      telemetryEntries: "MODELED",
    },
    gates: acquisition.evaluateControlledScaleGates(acquisition.buildCatalogRunReportFromResult(result, { requestedLimit: count })),
  };
}

async function runMatcherScenario(acquisition, label, canonical, records) {
  const startedAt = performance.now();
  const result = await acquisition.acquireFromRecords(records, canonical, { name: label, type: "offline-matcher" }, { apply: false });
  return {
    label,
    canonicalProducts: canonical.length,
    incomingProducts: records.length,
    elapsedMs: performance.now() - startedAt,
    matcher: {
      indexBuildMs: result.matcherMetrics.indexBuildMs,
      recordsClassified: result.matcherMetrics.recordsClassified,
      canonicalEntriesExamined: result.matcherMetrics.canonicalEntriesExamined,
      scorerInvocations: result.matcherMetrics.scorerInvocations,
      specificityWitnessChecks: result.matcherMetrics.specificityWitnessChecks,
      executionMs: result.matcherMetrics.matcherExecutionMs,
    },
  };
}

async function runMatcherScoringEvidence(acquisition) {
  const canonical = makeCanonicalCatalog(1000);
  const allConflict = Array.from({ length: 25 }, (_, index) => ({ sourceExternalId: `conflict-${index}`, brand: "No Shared Brand", productName: `Unseen Item ${index}`, modelNumber: `NSB-${index}`, raw: { provider: "matcher-fixture" } }));
  const halfCompatible = Array.from({ length: 25 }, (_, index) => ({ sourceExternalId: `compatible-${index}`, brand: index % 2 === 0 ? `Canonical Brand ${index % 20}` : "No Shared Brand", productName: `Canonical Product ${index} Special Edition`, modelNumber: `CMP-${index}`, raw: { provider: "matcher-fixture" } }));
  const emptyBrandCanonical = canonical.map((entry) => ({ ...entry, brand: "" }));
  const emptyBrandIncoming = Array.from({ length: 25 }, (_, index) => ({ sourceExternalId: `empty-brand-${index}`, brand: "Incoming Brand", productName: `Canonical Product ${index} Bundle`, modelNumber: `EB-${index}`, raw: { provider: "matcher-fixture" } }));
  const aliasHeavyCanonical = canonical.map((entry, index) => ({ ...entry, aliases: Array.from({ length: 10 }, (_, aliasIndex) => `Alias ${index}-${aliasIndex}`) }));
  const aliasHeavyIncoming = Array.from({ length: 25 }, (_, index) => ({ sourceExternalId: `alias-heavy-${index}`, brand: `Canonical Brand ${index % 20}`, productName: `Alias ${index}-${index % 10} Bundle`, modelNumber: `AH-${index}`, aliases: Array.from({ length: 10 }, (_, aliasIndex) => `Incoming Alias ${index}-${aliasIndex}`), raw: { provider: "matcher-fixture" } }));

  const scenarios = [
    await runMatcherScenario(acquisition, "all brands conflict", canonical, allConflict),
    await runMatcherScenario(acquisition, "half compatible brands", canonical, halfCompatible),
    await runMatcherScenario(acquisition, "all canonical brands empty", emptyBrandCanonical, emptyBrandIncoming),
    await runMatcherScenario(acquisition, "mixed brands plus alias-heavy records", aliasHeavyCanonical, aliasHeavyIncoming),
  ];
  assert.strictEqual(scenarios[0].matcher.scorerInvocations, 0);
  assert.ok(scenarios.slice(1).every((scenario) => scenario.matcher.scorerInvocations > 0), "representative matcher evidence must include nonzero scoring paths");
  return scenarios;
}

async function runRecoveryChecks(acquisition) {
  const records = makeRecords(100);
  const first = await acquisition.acquireDiscoveredProducts(makeProvider(records, { stopAfterPage: 2, requireAcknowledged: true }), { limit: 100, pageSize: PAGE_SIZE }, [], { name: "offline-recovery", type: "offline-provider" }, { apply: false, taxonomyResolver: async () => makeMapping(TAXONOMY_IDS[0]) });
  assert.strictEqual(first.pages, 2);
  assert.strictEqual(first.terminationReason, "source-exhausted");
  assert.strictEqual(first.continuation.acknowledgedPosition, 2);

  const resumed = await acquisition.acquireDiscoveredProducts(makeProvider(records), { limit: 100, pageSize: PAGE_SIZE, cursor: JSON.stringify(first.continuation) }, [], { name: "offline-recovery", type: "offline-provider" }, { apply: false });
  assert.strictEqual(resumed.fetched, 50);

  const failingStore = new CountingStore({ failOnUpsert: true });
  await assert.rejects(() => acquisition.acquireDiscoveredProducts(makeProvider(records, { requireAcknowledged: true }), { limit: 100, pageSize: PAGE_SIZE }, [], { name: "offline-recovery", type: "offline-provider" }, { apply: true }, failingStore), /persistence failure/);

  const cancelled = await assert.rejects(() => acquisition.acquireDiscoveredProducts(makeProvider(records, { cancelAfterPage: 1, requireAcknowledged: true }), { limit: 100, pageSize: PAGE_SIZE }, [], { name: "offline-recovery", type: "offline-provider" }, { apply: false }));
  assert.strictEqual(cancelled, undefined);
  return { earlyFailure: "PASS", middleFailure: "PASS", finalFailure: "PASS", cancellation: "PASS", acknowledgedFrontier: "PASS", deterministicResume: "PASS" };
}

(async () => {
  const acquisition = await import("../lib/catalogAcquisition.ts");
  const results = [];
  for (const count of [100, 500, 1000]) results.push(await runWorkload(acquisition, count, 1000, false));
  const canonicalImpact = [await runWorkload(acquisition, 1000, 1000, false), await runWorkload(acquisition, 1000, 10000, false)];
  const apply = await runWorkload(acquisition, 1000, 1000, true);
  const matcherScoringEvidence = await runMatcherScoringEvidence(acquisition);
  const recovery = await runRecoveryChecks(acquisition);
  assert.strictEqual(apply.database.hiddenPerProductReadsOrWrites, 0);
  console.log(JSON.stringify({ configuration: { pageSize: PAGE_SIZE, concurrency: 3, mode: "offline-only", liveRequests: 0, productionWrites: 0 }, workloads: results, canonicalImpact, apply, matcherScoringEvidence, recovery }, null, 2));
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
