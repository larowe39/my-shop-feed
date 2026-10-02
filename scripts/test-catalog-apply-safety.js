#!/usr/bin/env node
const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

async function main() {
  const testLedgerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-apply-safety-test-"));
  const testLedgerPath = (name) => path.join(testLedgerDirectory, name);
  const ledgerPath = testLedgerPath("catalog-apply-safety.test.json");
  const { acquireFromRecords, acquireDiscoveredProducts, DiscoveryAcquisitionFailure, sourceFingerprint } = await import("../lib/catalogAcquisition.ts");
  const { LocalStagingStore, deduplicateStagedCandidates, IncompatibleStagedCandidateError } = await import("../lib/stagingStore.ts");
  const { buildStagedAliasEntries, normalizeAliasConflictKey } = await import("../lib/catalogAlias.ts");
  const { SUPABASE_STAGING_ALIAS_BATCH_SIZE } = await import("../lib/catalogStagingTypes.ts");

  class FailingStore {
    constructor(delegate, failure) {
      this.kind = delegate.kind;
      this.delegate = delegate;
      this.failures = Array.isArray(failure) ? failure : [failure];
      this.calls = {};
    }
    async invoke(name, args) {
      this.calls[name] = (this.calls[name] || 0) + 1;
      const failure = this.failures.find((entry) => entry?.name === name && this.calls[name] === entry.at);
      if (failure) {
        if (failure.afterWrite) {
          await this.delegate[name](...args);
        }
        throw new Error(`injected ${name} failure`);
      }
      return this.delegate[name](...args);
    }
    upsertSource(...args) { return this.invoke("upsertSource", args); }
    createImportRun(...args) { return this.invoke("createImportRun", args); }
    updateImportRun(...args) { return this.invoke("updateImportRun", args); }
    listImportRuns(...args) { return this.invoke("listImportRuns", args); }
    countStagedCandidatesByRun(...args) { return this.invoke("countStagedCandidatesByRun", args); }
    upsertStagedCandidates(...args) { return this.invoke("upsertStagedCandidates", args); }
    listStagedCandidates(...args) { return this.delegate.listStagedCandidates(...args); }
    getStagedCandidateById(...args) { return this.delegate.getStagedCandidateById(...args); }
    updateCandidateStatus(...args) { return this.delegate.updateCandidateStatus(...args); }
    markPromoted(...args) { return this.delegate.markPromoted(...args); }
  }

  class StatementShapedStore extends FailingStore {
    constructor(delegate, ledgerFile, failAliasBatch = null) {
      super(delegate, null);
      this.ledgerFile = ledgerFile;
      this.failAliasBatch = failAliasBatch;
      this.productStatements = [];
      this.aliasStatements = [];
    }
    async upsertStagedCandidates(candidates) {
      const uniqueCandidates = deduplicateStagedCandidates(candidates);
      const fingerprintKeys = new Set();
      const externalKeys = new Set();
      for (const candidate of uniqueCandidates) {
        const runKey = candidate.importRunId ?? "";
        const fingerprintKey = `${runKey}\u0000${candidate.fingerprint}`;
        const externalKey = candidate.sourceExternalId ? `${runKey}\u0000${candidate.sourceExternalId}` : null;
        if (fingerprintKeys.has(fingerprintKey) || (externalKey && externalKeys.has(externalKey))) {
          throw new Error("ON CONFLICT DO UPDATE command cannot affect row a second time");
        }
        fingerprintKeys.add(fingerprintKey);
        if (externalKey) externalKeys.add(externalKey);
      }
      this.productStatements.push(uniqueCandidates.map((candidate) => ({ ...candidate })));
      const ledger = JSON.parse(fs.readFileSync(this.ledgerFile, "utf8"));
      const persisted = [];
      for (const candidate of uniqueCandidates) {
        const sameRunRows = ledger.stagedProducts.filter((row) => (row.importRunId ?? null) === (candidate.importRunId ?? null));
        if (candidate.sourceExternalId && sameRunRows.some((row) => row.sourceExternalId === candidate.sourceExternalId && row.fingerprint !== candidate.fingerprint)) {
          throw new IncompatibleStagedCandidateError(`Incompatible duplicate source identity in run ${candidate.importRunId}: ${candidate.sourceExternalId}`);
        }
        const existing = sameRunRows.find((row) => row.fingerprint === candidate.fingerprint);
        const row = existing ? { ...existing, ...candidate, id: existing.id } : { ...candidate };
        if (existing) ledger.stagedProducts[ledger.stagedProducts.indexOf(existing)] = row;
        else ledger.stagedProducts.push(row);
        persisted.push(row);
      }
      fs.writeFileSync(this.ledgerFile, JSON.stringify(ledger, null, 2));

      const aliasRowsByKey = new Map();
      for (const candidate of persisted) {
        for (const alias of buildStagedAliasEntries(candidate)) {
          aliasRowsByKey.set(`${candidate.id}\u0000${alias.normalizedAlias}`, {
            stagedProductId: candidate.id,
            alias: alias.alias,
            normalizedAlias: alias.normalizedAlias,
          });
        }
      }
      const aliasRows = [...aliasRowsByKey.values()].sort((left, right) =>
        `${left.stagedProductId}\u0000${left.normalizedAlias}`.localeCompare(`${right.stagedProductId}\u0000${right.normalizedAlias}`)
      );
      for (let offset = 0, batch = 1; offset < aliasRows.length; offset += SUPABASE_STAGING_ALIAS_BATCH_SIZE, batch += 1) {
        const aliasBatch = aliasRows.slice(offset, offset + SUPABASE_STAGING_ALIAS_BATCH_SIZE);
        this.aliasStatements.push(aliasBatch);
        if (this.failAliasBatch === batch) throw new Error(`injected alias statement ${batch} failure after product commit`);
        const aliasLedger = JSON.parse(fs.readFileSync(this.ledgerFile, "utf8"));
        for (const alias of aliasBatch) {
          if (aliasLedger.stagedAliases.some((row) => row.stagedProductId === alias.stagedProductId && row.normalizedAlias === alias.normalizedAlias)) continue;
          aliasLedger.stagedAliases.push({ id: `sql-alias-${aliasLedger.stagedAliases.length + 1}`, ...alias, createdAt: new Date().toISOString() });
        }
        fs.writeFileSync(this.ledgerFile, JSON.stringify(aliasLedger, null, 2));
      }
      return persisted;
    }
  }

  const store = new LocalStagingStore(ledgerPath);
  store.reset();
  const source = await store.upsertSource({ name: "apply-safety-source", type: "external-provider" });
  const run = await store.createImportRun(source, {
    adapter: "fixture",
    dryRun: false,
    processed: 0, valid: 0, invalid: 0, exactExisting: 0, likelyExisting: 0,
    possibleExisting: 0, newRecords: 0, conflictRecords: 0, approved: 0,
    rejected: 0, promoted: 0, staged: 0, errors: 0, status: "partial", summary: {},
  });

  const record = {
    sourceExternalId: "safety-1",
    brand: "Acme",
    productName: "X100",
    modelNumber: "x-100",
    aliases: ["X100", "x100", "X-100", "X 100", "Distinct Alias"],
    raw: { fixture: true },
  };
  const existingRun = { id: run.id, source };
  const failingAfterProductWrite = new FailingStore(store, { name: "upsertStagedCandidates", at: 1, afterWrite: true });
  await assert.rejects(
    () => acquireFromRecords([record], [], source, { apply: true, adapter: "fixture", existingRun }, failingAfterProductWrite),
    /injected upsertStagedCandidates failure/
  );
  const retry = await acquireFromRecords([record], [], source, { apply: true, adapter: "fixture", existingRun }, store);
  assert.strictEqual(retry.staged.length, 1, "same-run retry must return one staged candidate");

  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.strictEqual(ledger.stagedProducts.length, 1, "product retry must converge to one staged product");
  const aliases = ledger.stagedAliases.filter((alias) => alias.stagedProductId === ledger.stagedProducts[0].id);
  assert.strictEqual(new Set(aliases.map((alias) => alias.normalizedAlias)).size, aliases.length, "normalized alias keys must be unique");
  assert.ok(aliases.some((alias) => alias.normalizedAlias === "x100"), "product/model conflict key must be retained once");
  assert.ok(aliases.some((alias) => alias.normalizedAlias === "distinct alias"), "explicit source alias must be retained");
  assert.ok(!aliases.some((alias) => alias.normalizedAlias === "acme"), "bare brand alias must never be emitted");

  assert.strictEqual(normalizeAliasConflictKey("X100"), "x100");
  assert.strictEqual(normalizeAliasConflictKey("x100"), "x100");
  for (const alias of ["X-100", "X 100", "x_100"]) assert.strictEqual(normalizeAliasConflictKey(alias), "x 100");
  assert.strictEqual(normalizeAliasConflictKey("A/B"), "a b");
  assert.strictEqual(normalizeAliasConflictKey("A B"), "a b");
  for (const alias of [null, "", "!!!", "---"]) assert.strictEqual(normalizeAliasConflictKey(alias), "");
  const aliasEntries = buildStagedAliasEntries({
    brand: "Acme",
    productName: "Useful Product Name",
    modelNumber: "MODEL-44",
    aliases: ["X100", "x100", "X-100", "X 100", "x_100", "A/B", "A B", null, "", "!!!", "ACME", "Useful Alias"],
  });
  const aliasKeys = aliasEntries.map((entry) => entry.normalizedAlias);
  assert.strictEqual(new Set(aliasKeys).size, aliasKeys.length, "alias entries must be unique by canonical key");
  assert.ok(aliasKeys.includes("x100") && aliasKeys.includes("x 100"));
  assert.ok(aliasKeys.includes("a b") && aliasKeys.includes("useful alias") && aliasKeys.includes("useful product name") && aliasKeys.includes("model 44"));
  assert.ok(!aliasKeys.includes("acme"), "explicit brand-only aliases must be omitted");

  const productionDuplicateA = { ...retry.staged[0], id: "production-shaped-candidate", importRunId: "production-shaped-run", aliases: ["Beta Alias", "Alpha Alias"] };
  const productionDuplicateB = { ...productionDuplicateA, id: "different-id", aliases: ["Alpha Alias", "Beta Alias", "Alpha Alias"] };
  const dedupedCandidates = deduplicateStagedCandidates([productionDuplicateA, productionDuplicateB]);
  const reverseDedupedCandidates = deduplicateStagedCandidates([productionDuplicateB, productionDuplicateA]);
  assert.strictEqual(dedupedCandidates.length, 1, "exact/reordered candidate duplicates must produce one SQL row");
  assert.deepStrictEqual(dedupedCandidates[0].aliases, reverseDedupedCandidates[0].aliases, "alias merging must be deterministic regardless of input ordering");
  assert.deepStrictEqual(dedupedCandidates[0].aliases, ["Alpha Alias", "Beta Alias"]);
  assert.throws(() => deduplicateStagedCandidates([
    productionDuplicateA,
    { ...productionDuplicateA, fingerprint: "different-fingerprint", productName: "Incompatible payload" },
  ]), IncompatibleStagedCandidateError, "same-run external-ID payload collisions must be classified before SQL");
  const dedupedRetryRows = await store.upsertStagedCandidates([productionDuplicateA, productionDuplicateB]);
  assert.strictEqual(dedupedRetryRows.length, 1, "retry after deduplication must remain one staged product");
  const needsReviewRow = await store.updateCandidateStatus(dedupedRetryRows[0].id, "needs_review");
  const preservedReviewRetry = await store.upsertStagedCandidates([productionDuplicateA]);
  assert.strictEqual(preservedReviewRetry[0].status, "needs_review", "retry must not downgrade an existing needs_review state");
  await store.updateCandidateStatus(needsReviewRow.id, "approved", "human reviewed candidate");
  await assert.rejects(() => store.upsertStagedCandidates([productionDuplicateA]), /protected human review or promotion state/);
  const reviewedCandidate = await store.getStagedCandidateById(needsReviewRow.id);
  assert.strictEqual(reviewedCandidate.status, "approved");
  assert.strictEqual(reviewedCandidate.reviewNotes, "human reviewed candidate");
  await store.markPromoted(needsReviewRow.id, "canonical-fixture-product");
  await assert.rejects(() => store.upsertStagedCandidates([productionDuplicateA]), /protected human review or promotion state/);

  const dryRunStore = new FailingStore(store, null);
  const dryRunResult = await acquireFromRecords([record], [], source, { apply: false, adapter: "fixture" }, dryRunStore);
  assert.strictEqual(dryRunResult.executionMode, "dry-run");
  assert.strictEqual(dryRunResult.runId, undefined);
  assert.deepStrictEqual(dryRunStore.calls, {}, "ordinary acquireFromRecords dry-run must make zero store calls");

  const directApplyFailureStore = new FailingStore(store, { name: "upsertStagedCandidates", at: 1 });
  await assert.rejects(
    () => acquireFromRecords([{ ...record, sourceExternalId: "direct-apply-failure" }], [], source, { apply: true, adapter: "fixture" }, directApplyFailureStore),
    /injected upsertStagedCandidates failure/
  );
  assert.strictEqual((await store.listImportRuns()).at(-1).status, "partial", "direct record apply must never begin as completed before staging succeeds");

  const clonedConflictPath = testLedgerPath("catalog-cloned-conflict.test.json");
  const clonedConflictDelegate = new LocalStagingStore(clonedConflictPath);
  clonedConflictDelegate.reset();
  const clonedConflictSource = await clonedConflictDelegate.upsertSource({ name: "cloned-conflict-source", type: "external-provider" });
  let clonedConflictAttempts = 0;
  const clonedConflictStore = {
    ...clonedConflictDelegate,
    kind: clonedConflictDelegate.kind,
    upsertSource: (...args) => clonedConflictDelegate.upsertSource(...args),
    createImportRun: (...args) => clonedConflictDelegate.createImportRun(...args),
    updateImportRun: (...args) => clonedConflictDelegate.updateImportRun(...args),
    listImportRuns: (...args) => clonedConflictDelegate.listImportRuns(...args),
    countStagedCandidatesByRun: (...args) => clonedConflictDelegate.countStagedCandidatesByRun(...args),
    listStagedCandidates: (...args) => clonedConflictDelegate.listStagedCandidates(...args),
    getStagedCandidateById: (...args) => clonedConflictDelegate.getStagedCandidateById(...args),
    updateCandidateStatus: (...args) => clonedConflictDelegate.updateCandidateStatus(...args),
    markPromoted: (...args) => clonedConflictDelegate.markPromoted(...args),
    async upsertStagedCandidates(candidates) {
      clonedConflictAttempts += 1;
      if (clonedConflictAttempts === 1) {
        throw new IncompatibleStagedCandidateError("Incompatible duplicate source identity in cloned conflict test", { ...candidates[1] });
      }
      return clonedConflictDelegate.upsertStagedCandidates(candidates);
    },
  };
  const clonedConflictResult = await acquireFromRecords([
    { sourceExternalId: "cloned-duplicate", brand: "Acme", productName: "Compatible Candidate", raw: {} },
    { sourceExternalId: "cloned-duplicate", brand: "Acme", productName: "Incompatible Clone", raw: {} },
  ], [], clonedConflictSource, { apply: true, adapter: "fixture" }, clonedConflictStore);
  assert.strictEqual(clonedConflictAttempts, 2, "a cloned conflict must be removed by identity, then retried once");
  assert.strictEqual(clonedConflictResult.summary.valid, 1);
  assert.strictEqual(clonedConflictResult.summary.invalid, 1);
  assert.strictEqual(clonedConflictResult.staged.length, 1);
  clonedConflictDelegate.reset();
  if (fs.existsSync(clonedConflictPath)) fs.unlinkSync(clonedConflictPath);

  const failingProviderStore = new FailingStore(store, { name: "upsertStagedCandidates", at: 1 });
  const provider = {
    capabilities: { lookup: false, discovery: true },
    async *discoverProducts() {
      yield {
        records: [{ sourceExternalId: "failure-page-1", brand: "Acme", productName: "Failure Product", raw: {} }],
        errors: [],
        done: true,
        checkpoint: { processedCount: 1, enrichmentAttempts: 1 },
      };
    },
    normalizeProduct: (value) => value,
  };
  await assert.rejects(
    () => acquireDiscoveredProducts(provider, { limit: 1, pageSize: 1 }, [], source, { apply: true, adapter: "fixture" }, failingProviderStore),
    /injected upsertStagedCandidates failure/
  );
  const failedRun = (await store.listImportRuns()).find((item) => item.summary.failure);
  assert.ok(failedRun, "interrupted discovery must leave a durable failed run");
  assert.strictEqual(failedRun.status, "failed");

  const finalizationFailureStore = new FailingStore(store, { name: "updateImportRun", at: 3 });
  await assert.rejects(
    () => acquireDiscoveredProducts(provider, { limit: 1, pageSize: 1 }, [], source, { apply: true, adapter: "fixture" }, finalizationFailureStore),
    /injected updateImportRun failure/
  );
  const failedFinalizationRun = (await store.listImportRuns()).find((item) => item.summary.failure && item.summary.failure.includes("updateImportRun"));
  assert.ok(failedFinalizationRun, "finalization failure must be durable");
  assert.strictEqual(failedFinalizationRun.status, "failed");

  const countFailureStore = new FailingStore(store, { name: "countStagedCandidatesByRun", at: 1 });
  await assert.rejects(
    () => acquireDiscoveredProducts(provider, { limit: 1, pageSize: 1 }, [], source, { apply: true, adapter: "fixture" }, countFailureStore),
    (error) => error instanceof DiscoveryAcquisitionFailure && error.phase === "page-accounting" && /injected countStagedCandidatesByRun/.test(error.message)
  );
  const failedCountRun = (await store.listImportRuns()).find((item) => item.summary.failurePhase === "page-accounting");
  assert.strictEqual(failedCountRun.status, "failed", "a count failure must keep the run non-completed");

  const doubleFailureStore = new FailingStore(store, [
    { name: "upsertStagedCandidates", at: 1 },
    { name: "updateImportRun", at: 1 },
  ]);
  await assert.rejects(
    () => acquireDiscoveredProducts(provider, { limit: 1, pageSize: 1 }, [], source, { apply: true, adapter: "fixture" }, doubleFailureStore),
    (error) => error instanceof DiscoveryAcquisitionFailure && error.finalizationState === "UNKNOWN/AMBIGUOUS" &&
      /injected upsertStagedCandidates/.test(error.message) && /failure recording failed: injected updateImportRun/.test(error.secondaryError)
  );

  const lostFinalizationResponseStore = new FailingStore(store, { name: "updateImportRun", at: 3, afterWrite: true });
  const reconciledRun = await acquireDiscoveredProducts(provider, { limit: 1, pageSize: 1 }, [], source, { apply: true, adapter: "fixture" }, lostFinalizationResponseStore);
  assert.strictEqual((await store.listImportRuns()).find((item) => item.id === reconciledRun.runId).status, "completed", "a committed final update with a lost response must reconcile as completed");

  const lostAckResponseStore = new FailingStore(store, { name: "updateImportRun", at: 2, afterWrite: true });
  const reconciledAckRun = await acquireDiscoveredProducts(provider, { limit: 1, pageSize: 1 }, [], source, { apply: true, adapter: "fixture" }, lostAckResponseStore);
  const reconciledAckRow = (await store.listImportRuns()).find((item) => item.id === reconciledAckRun.runId);
  assert.strictEqual(reconciledAckRow.status, "completed");
  assert.strictEqual(reconciledAckRow.processed, 1, "a committed ack-counter update with a lost response must not double-count or fail the run");

  const ackLedgerPath = testLedgerPath("catalog-apply-ack.test.json");
  const ackStore = new LocalStagingStore(ackLedgerPath);
  ackStore.reset();
  const ackSource = await ackStore.upsertSource({ name: "ack-safety-source", type: "external-provider" });
  let ackObservedAccounting = false;
  const ackProvider = {
    capabilities: { lookup: false, discovery: true },
    async *discoverProducts() {
      yield {
        records: [
          { sourceExternalId: "ack-valid-a", brand: "Acme", productName: "Valid A", raw: {} },
          { sourceExternalId: "ack-invalid-b", brand: "Acme", productName: "Invalid B", raw: { reject: true } },
          { sourceExternalId: "ack-valid-c", brand: "Acme", productName: "Valid C", raw: {} },
        ],
        errors: [],
        done: true,
        checkpoint: { processedCount: 3, enrichmentAttempts: 3 },
        acknowledge() {
          const ledger = JSON.parse(fs.readFileSync(ackLedgerPath, "utf8"));
          const savedRun = ledger.importRuns.at(-1);
          const pending = savedRun?.summary.pendingPage;
          ackObservedAccounting = savedRun?.processed === 0 && savedRun.invalid === 0 && savedRun.staged === 2 &&
            pending?.processed === 3 && pending.valid === 2 && pending.invalid === 1 && pending.invalidRecords?.length === 1 &&
            ledger.stagedProducts.length === 2;
        },
      };
    },
    normalizeProduct(value) {
      if (value.raw.reject) throw new Error("fixture normalization rejection");
      return value;
    },
  };
  await acquireDiscoveredProducts(ackProvider, { limit: 3, pageSize: 3 }, [], ackSource, { apply: true, adapter: "fixture" }, ackStore);
  const acknowledgedTestRun = (await ackStore.listImportRuns()).at(-1);
  if (fs.existsSync(ackLedgerPath)) fs.unlinkSync(ackLedgerPath);
  assert.ok(ackObservedAccounting, "durable valid/invalid disposition and product rows must exist at acknowledgment time");
  assert.strictEqual(acknowledgedTestRun.processed, 3, "run counters advance after acknowledgment commits");

  const providerFailurePath = testLedgerPath("catalog-provider-failure.test.json");
  const providerFailureStore = new LocalStagingStore(providerFailurePath);
  providerFailureStore.reset();
  const providerFailureSource = await providerFailureStore.upsertSource({ name: "provider-failure-source", type: "external-provider" });
  let providerErrorPageAcknowledged = false;
  const providerErrorPage = {
    capabilities: { lookup: false, discovery: true },
    async *discoverProducts() {
      yield {
        records: [
          { sourceExternalId: "provider-valid-a", brand: "Acme", productName: "Provider Valid A", raw: {} },
          { sourceExternalId: "provider-valid-c", brand: "Acme", productName: "Provider Valid C", raw: {} },
        ],
        errors: [{ sourceExternalId: "provider-failure-b", message: "fixture transport failure", retriable: true }],
        done: true,
        checkpoint: { processedCount: 3, enrichmentAttempts: 3 },
        acknowledge() { providerErrorPageAcknowledged = true; },
      };
    },
    normalizeProduct: (value) => value,
  };
  await assert.rejects(() => acquireDiscoveredProducts(providerErrorPage, { limit: 3, pageSize: 3 }, [], providerFailureSource, {
    apply: true,
    adapter: "fixture",
  }, providerFailureStore), /provider error\(s\); page was not acknowledged/);
  const providerFailureRun = (await providerFailureStore.listImportRuns()).at(-1);
  assert.strictEqual(providerErrorPageAcknowledged, false, "a provider failure between valid records must hold the acknowledgment frontier");
  assert.strictEqual(providerFailureRun.status, "failed");
  assert.strictEqual(providerFailureRun.invalid, 0, "transport errors must not be counted as invalid records");
  assert.strictEqual(providerFailureRun.summary.pendingPage.providerErrors.length, 1);
  assert.strictEqual(providerFailureRun.summary.pendingPage.providerErrors[0].message, "fixture transport failure");
  assert.strictEqual(providerFailureRun.staged, 2, "durable valid rows must be reconciled despite the failed page");
  providerFailureStore.reset();
  if (fs.existsSync(providerFailurePath)) fs.unlinkSync(providerFailurePath);

  const ackFailurePath = testLedgerPath("catalog-ack-failure.test.json");
  const ackFailureStore = new LocalStagingStore(ackFailurePath);
  ackFailureStore.reset();
  const ackFailureSource = await ackFailureStore.upsertSource({ name: "ack-failure-source", type: "external-provider" });
  const ackFailureProvider = {
    capabilities: { lookup: false, discovery: true },
    async *discoverProducts() {
      const checkpoint = { processedCount: 1, enrichmentAttempts: 1 };
      yield {
        records: [{ sourceExternalId: "ack-failure-1", brand: "Acme", productName: "Ack Failure", raw: {} }],
        errors: [],
        done: true,
        checkpoint,
        acknowledge() {
          checkpoint.acknowledgedCursor = "unpersisted-token";
          throw new Error("fixture acknowledgment failure");
        },
      };
    },
    normalizeProduct: (value) => value,
  };
  await assert.rejects(() => acquireDiscoveredProducts(ackFailureProvider, { limit: 1, pageSize: 1 }, [], ackFailureSource, {
    apply: true,
    adapter: "fixture",
  }, ackFailureStore), (error) => error instanceof DiscoveryAcquisitionFailure && error.phase === "page-acknowledgment" && /fixture acknowledgment failure/.test(error.message));
  const ackFailureRun = (await ackFailureStore.listImportRuns()).at(-1);
  assert.strictEqual(ackFailureRun.status, "failed");
  assert.strictEqual(ackFailureRun.staged, 1);
  assert.strictEqual(ackFailureRun.processed, 0);
  assert.strictEqual(ackFailureRun.summary.pendingPage.processed, 1);
  assert.strictEqual(ackFailureRun.summary.acknowledgedCursor, null);
  ackFailureStore.reset();
  if (fs.existsSync(ackFailurePath)) fs.unlinkSync(ackFailurePath);

  const conflictLedgerPath = testLedgerPath("catalog-apply-conflict.test.json");
  const conflictStore = new LocalStagingStore(conflictLedgerPath);
  conflictStore.reset();
  const conflictSource = await conflictStore.upsertSource({ name: "conflict-source", type: "external-provider" });
  let duplicateDispositionAtAck = false;
  const conflictProvider = {
    capabilities: { lookup: false, discovery: true },
    async *discoverProducts() {
      yield {
        records: [
          { sourceExternalId: "duplicate-source-id", brand: "Acme", productName: "Candidate A", raw: {} },
          { sourceExternalId: "duplicate-source-id", brand: "Acme", productName: "Incompatible Candidate B", raw: {} },
        ],
        errors: [],
        done: true,
        checkpoint: { processedCount: 2, enrichmentAttempts: 2 },
        acknowledge() {
          const ledger = JSON.parse(fs.readFileSync(conflictLedgerPath, "utf8"));
          const savedRun = ledger.importRuns.at(-1);
          const pending = savedRun?.summary.pendingPage;
          duplicateDispositionAtAck = savedRun?.processed === 0 && pending?.processed === 2 && pending.valid === 1 && pending.invalid === 1 &&
            pending.durableStagedCount === 1 && pending.invalidRecords?.length === 1 && ledger.stagedProducts.length === 1;
        },
      };
    },
    normalizeProduct: (value) => value,
  };
  const conflictResult = await acquireDiscoveredProducts(conflictProvider, { limit: 2, pageSize: 2 }, [], conflictSource, { apply: true, adapter: "fixture" }, conflictStore);
  assert.strictEqual(conflictResult.providerErrors.length, 0, "incompatible candidate payloads are not provider failures");
  assert.strictEqual(conflictResult.invalidRecords.length, 1);
  assert.ok(duplicateDispositionAtAck, "incompatible duplicate disposition must be durable before ack");
  conflictStore.reset();
  if (fs.existsSync(conflictLedgerPath)) fs.unlinkSync(conflictLedgerPath);

  const recoveryLedgerPath = testLedgerPath("catalog-apply-recovery.test.json");
  const recoveryStore = new LocalStagingStore(recoveryLedgerPath);
  recoveryStore.reset();
  let createdIdentity;
  let observedResumeCursor;
  const recoveryProvider = {
    capabilities: { lookup: false, discovery: true },
    async *discoverProducts(options) {
      if (options.cursor) {
        observedResumeCursor = options.cursor;
        yield recoveryPage({ sourceExternalId: "recovery-2", brand: "Acme", productName: "Recovery Two", raw: {} }, "token-two");
        return;
      }
      yield recoveryPage({ sourceExternalId: "recovery-1", brand: "Acme", productName: "Recovery One", raw: {} }, "token-one");
      throw new Error("simulated interruption after first acknowledged page");
    },
    normalizeProduct: (value) => value,
  };
  const recoveryDiscoveryOptions = { mode: "initial", limit: 2, pageSize: 1, concurrency: 1 };
  await assert.rejects(
    () => acquireDiscoveredProducts(recoveryProvider, recoveryDiscoveryOptions, [], { name: "same-run-source", type: "external-provider" }, {
      apply: true,
      adapter: "open-icecat",
      onRunCreated: (identity) => { createdIdentity = identity; },
    }, recoveryStore),
    (error) => error instanceof DiscoveryAcquisitionFailure && error.phase === "provider-discovery" && error.runId === createdIdentity?.runId
  );
  assert.ok(createdIdentity?.runId, "run identity must be available even when acquisition fails");
  const interruptedRun = (await recoveryStore.listImportRuns()).find((item) => item.id === createdIdentity.runId);
  assert.strictEqual(interruptedRun.status, "failed");
  assert.strictEqual(interruptedRun.summary.acknowledgedCursor, "token-one");
  const recovered = await acquireDiscoveredProducts(recoveryProvider, recoveryDiscoveryOptions, [], { name: "same-run-source", type: "external-provider" }, {
    apply: true,
    adapter: "open-icecat",
    resumeRunId: createdIdentity.runId,
  }, recoveryStore);
  assert.strictEqual(observedResumeCursor, "token-one", "same-run recovery must resume from the last persisted token");
  assert.strictEqual(recovered.runId, createdIdentity.runId, "recovery must retain the original run identity");
  assert.strictEqual(recovered.summary.processed, 2, "recovery must accumulate, not reset, processed counters");
  assert.strictEqual(recovered.summary.staged, 2);
  const recoveredRows = (await recoveryStore.listStagedCandidates()).filter((item) => item.importRunId === createdIdentity.runId);
  assert.strictEqual(recoveredRows.length, 2);
  assert.ok(recoveredRows.every((item) => item.sourceId === recovered.sourceId), "source identity must be resolved before fingerprinting");
  assert.strictEqual(recoveredRows[0].fingerprint, sourceFingerprint({ sourceId: recovered.sourceId, sourceExternalId: "recovery-1", brand: "Acme", productName: "Recovery One" }));
  const invalidRecoveryStore = new FailingStore(recoveryStore, null);
  await assert.rejects(
    () => acquireDiscoveredProducts(recoveryProvider, recoveryDiscoveryOptions, [], { name: "same-run-source", type: "external-provider" }, {
      apply: true,
      adapter: "open-icecat",
      resumeRunId: "missing-run-id",
    }, invalidRecoveryStore),
    /was not found/
  );
  assert.strictEqual(invalidRecoveryStore.calls.upsertSource ?? 0, 0, "unknown recovery runs must be rejected before source upsert");
  assert.strictEqual(invalidRecoveryStore.calls.listImportRuns ?? 0, 1);
  recoveryStore.reset();
  if (fs.existsSync(recoveryLedgerPath)) fs.unlinkSync(recoveryLedgerPath);

  const boundaryLedgerPath = testLedgerPath("catalog-apply-boundary.test.json");
  const boundaryDelegate = new LocalStagingStore(boundaryLedgerPath);
  boundaryDelegate.reset();
  const boundaryStore = new StatementShapedStore(boundaryDelegate, boundaryLedgerPath, 1);
  let boundaryRunId;
  let boundaryAckCount = 0;
  const boundaryProvider = {
    capabilities: { lookup: false, discovery: true },
    async *discoverProducts() {
      const page = recoveryPage([
        { sourceExternalId: "boundary-1", brand: "Acme", productName: "Boundary Candidate", aliases: ["Recovered alias"], raw: {} },
        { sourceExternalId: "boundary-invalid", brand: "Acme", productName: "Invalid Boundary", raw: { reject: true } },
        { sourceExternalId: "boundary-2", brand: "Acme", productName: "Boundary Second", raw: {} },
      ], "boundary-token");
      const originalAcknowledge = page.acknowledge;
      page.acknowledge = () => { originalAcknowledge(); boundaryAckCount += 1; };
      yield page;
    },
    normalizeProduct(value) {
      if (value.raw.reject) throw new Error("boundary fixture normalization rejection");
      return value;
    },
  };
  const boundaryDiscoveryOptions = { mode: "initial", limit: 3, pageSize: 3, concurrency: 1 };
  await assert.rejects(
    () => acquireDiscoveredProducts(boundaryProvider, boundaryDiscoveryOptions, [], { name: "boundary-source", type: "external-provider" }, {
      apply: true,
      adapter: "open-icecat",
      onRunCreated: ({ runId }) => { boundaryRunId = runId; },
    }, boundaryStore),
    /injected alias statement 1 failure/
  );
  const failedBoundaryLedger = JSON.parse(fs.readFileSync(boundaryLedgerPath, "utf8"));
  assert.strictEqual(boundaryAckCount, 0, "product commit followed by alias failure must not acknowledge the page");
  assert.strictEqual(failedBoundaryLedger.stagedProducts.length, 2, "product statement commit must survive an independent alias failure");
  assert.strictEqual(failedBoundaryLedger.stagedAliases.length, 0);
  const failedBoundaryRun = (await boundaryDelegate.listImportRuns()).find((item) => item.id === boundaryRunId);
  assert.strictEqual(failedBoundaryRun.staged, 2, "failure handling must reconcile the durable product count");
  assert.strictEqual(failedBoundaryRun.processed, 0, "failed unacknowledged page must not advance durable counters");
  assert.strictEqual(failedBoundaryRun.summary.pendingPage.processed, 3);
  assert.strictEqual(failedBoundaryRun.summary.pendingPage.invalid, 1);
  assert.strictEqual(failedBoundaryRun.summary.pendingPage.invalidRecords.length, 1, "rejected record disposition must remain durable after an alias failure");

  const boundaryRetryStore = new StatementShapedStore(boundaryDelegate, boundaryLedgerPath);
  const boundaryRecovered = await acquireDiscoveredProducts(boundaryProvider, boundaryDiscoveryOptions, [], { name: "boundary-source", type: "external-provider" }, {
    apply: true,
    adapter: "open-icecat",
    resumeRunId: boundaryRunId,
  }, boundaryRetryStore);
  const recoveredBoundaryLedger = JSON.parse(fs.readFileSync(boundaryLedgerPath, "utf8"));
  assert.strictEqual(boundaryRecovered.runId, boundaryRunId);
  assert.strictEqual(recoveredBoundaryLedger.stagedProducts.length, 2, "retry must not duplicate independently committed product rows");
  assert.ok(recoveredBoundaryLedger.stagedAliases.some((item) => item.normalizedAlias === "recovered alias"), "same-run replay must reconcile aliases missing after partial commit");
  assert.strictEqual(boundaryAckCount, 1, "page may be acknowledged only after retry reconciles aliases and counters");
  assert.strictEqual(boundaryRecovered.summary.processed, 3, "replayed pending counters must be committed exactly once");
  assert.strictEqual(boundaryRecovered.summary.invalid, 1);
  assert.strictEqual(boundaryRetryStore.productStatements[0].length, 2, "production-shaped SQL statement must contain one row per conflict identity");

  const largeAliasCandidate = {
    ...recoveredBoundaryLedger.stagedProducts[0],
    id: "large-alias-candidate",
    importRunId: "large-alias-run",
    sourceExternalId: "large-alias-source",
    fingerprint: "large-alias-fingerprint",
    aliases: Array.from({ length: 1001 }, (_, index) => `Alias ${String(index).padStart(4, "0")}`),
  };
  const partialAliasBatchStore = new StatementShapedStore(boundaryDelegate, boundaryLedgerPath, 2);
  await assert.rejects(() => partialAliasBatchStore.upsertStagedCandidates([largeAliasCandidate]), /alias statement 2 failure/);
  const partialAliasLedger = JSON.parse(fs.readFileSync(boundaryLedgerPath, "utf8"));
  assert.strictEqual(partialAliasLedger.stagedAliases.filter((item) => item.stagedProductId === largeAliasCandidate.id).length, SUPABASE_STAGING_ALIAS_BATCH_SIZE,
    "the first alias batch must remain committed when a later alias batch fails");
  const completedAliasRetryStore = new StatementShapedStore(boundaryDelegate, boundaryLedgerPath);
  const duplicateSqlRows = await completedAliasRetryStore.upsertStagedCandidates([largeAliasCandidate, { ...largeAliasCandidate, id: "duplicate-id", aliases: [...largeAliasCandidate.aliases].reverse() }]);
  const completeAliasLedger = JSON.parse(fs.readFileSync(boundaryLedgerPath, "utf8"));
  assert.strictEqual(duplicateSqlRows.length, 1, "exact duplicates must be reduced before a production-shaped product statement");
  assert.strictEqual(completedAliasRetryStore.productStatements[0].length, 1);
  assert.strictEqual(completeAliasLedger.stagedAliases.filter((item) => item.stagedProductId === largeAliasCandidate.id).length,
    buildStagedAliasEntries(largeAliasCandidate).length, "retry must preserve prior alias batches and reconcile only missing normalized aliases");
  boundaryDelegate.reset();
  if (fs.existsSync(boundaryLedgerPath)) fs.unlinkSync(boundaryLedgerPath);

  const cliSource = fs.readFileSync(path.join(__dirname, "catalog-acquire-icecat.js"), "utf8");
  const { parseBoundedApplyLimit } = require("./lib/cliArgs");
  for (const invalidArgs of [[], ["--limit"], ["--limit="], ["--limit", "0"], ["--limit", "-1"], ["--limit", "101"], ["--limit", "ten"]]) {
    assert.throws(() => parseBoundedApplyLimit(invalidArgs), /explicit integer --limit between 1 and 100/);
  }
  for (const [input, expected] of [["1", 1], ["10", 10], ["100", 100]]) {
    assert.strictEqual(parseBoundedApplyLimit(["--limit", input]), expected);
    assert.strictEqual(parseBoundedApplyLimit([`--limit=${input}`]), expected);
  }
  assert.match(cliSource, /only --discover Open Icecat acquisition is supported/);
  assert.match(cliSource, /PERSISTED ACKNOWLEDGED CONTINUATION TOKEN/);
  const genericApplyCli = spawnSync(process.execPath, [path.join(__dirname, "catalog-acquire.js"), "--apply", "--source", "/does/not/exist.json"], { encoding: "utf8" });
  assert.notStrictEqual(genericApplyCli.status, 0);
  assert.match(genericApplyCli.stderr, /file\/lookup acquisition is disabled/);
  const icecatLookupApplyCli = spawnSync(process.execPath, [path.join(__dirname, "catalog-acquire-icecat.js"), "--apply", "--limit", "1", "--source", "/does/not/exist.xml"], { encoding: "utf8" });
  assert.notStrictEqual(icecatLookupApplyCli.status, 0);
  assert.match(icecatLookupApplyCli.stderr, /only --discover Open Icecat acquisition is supported/);

  store.reset();
  if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);
  fs.rmSync(testLedgerDirectory, { recursive: true, force: true });
  console.log("Catalog apply safety tests passed.");
}

function recoveryPage(records, token) {
  const sourceRecords = Array.isArray(records) ? records : [records];
  const checkpoint = { processedCount: sourceRecords.length, enrichmentAttempts: sourceRecords.length };
  return {
    records: sourceRecords,
    errors: [],
    done: false,
    checkpoint,
    acknowledge() {
      checkpoint.acknowledgedCursor = token;
      checkpoint.acknowledgedContinuation = { sourceIdentity: sourceRecords.at(-1).sourceExternalId };
    },
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
