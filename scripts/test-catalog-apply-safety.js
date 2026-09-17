#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

async function main() {
  const ledgerPath = path.join(__dirname, "..", ".catalog-staging", "catalog-apply-safety.test.json");
  const { acquireFromRecords, acquireDiscoveredProducts } = await import("../lib/catalogAcquisition.ts");
  const { LocalStagingStore } = await import("../lib/stagingStore.ts");

  class FailingStore {
    constructor(delegate, failure) {
      this.kind = delegate.kind;
      this.delegate = delegate;
      this.failure = failure;
      this.calls = {};
    }
    async invoke(name, args) {
      this.calls[name] = (this.calls[name] || 0) + 1;
      if (this.failure.name === name && this.calls[name] === this.failure.at) {
        if (this.failure.afterWrite) {
          await this.delegate[name](...args);
        }
        throw new Error(`injected ${name} failure`);
      }
      return this.delegate[name](...args);
    }
    upsertSource(...args) { return this.invoke("upsertSource", args); }
    createImportRun(...args) { return this.invoke("createImportRun", args); }
    updateImportRun(...args) { return this.invoke("updateImportRun", args); }
    listImportRuns(...args) { return this.delegate.listImportRuns(...args); }
    countStagedCandidatesByRun(...args) { return this.delegate.countStagedCandidatesByRun(...args); }
    upsertStagedCandidates(...args) { return this.invoke("upsertStagedCandidates", args); }
    listStagedCandidates(...args) { return this.delegate.listStagedCandidates(...args); }
    getStagedCandidateById(...args) { return this.delegate.getStagedCandidateById(...args); }
    updateCandidateStatus(...args) { return this.delegate.updateCandidateStatus(...args); }
    markPromoted(...args) { return this.delegate.markPromoted(...args); }
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

  const cliSource = fs.readFileSync(path.join(__dirname, "catalog-acquire-icecat.js"), "utf8");
  assert.match(cliSource, /explicit bounded --limit between 1 and 100/);
  assert.match(cliSource, /ACKNOWLEDGED CONTINUATION/);

  store.reset();
  if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);
  console.log("Catalog apply safety tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
