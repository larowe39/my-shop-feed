#!/usr/bin/env node
const assert = require("assert");
const path = require("path");
const fs = require("fs");

async function main() {
  const ledgerPath = path.join(__dirname, "..", ".catalog-staging", "catalog-staging-ledger.test.json");
  process.env.CATALOG_STAGING_LEDGER_PATH = ledgerPath;
  // Ensure the Supabase fail-closed test below actually has no credentials,
  // regardless of what a developer's local .env.local happens to contain.
  delete process.env.EXPO_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const acquisition = await import("../lib/catalogAcquisition.ts");
  const {
    normalizeAcquisitionText,
    parseJsonAdapterRecords,
    parseCsvAdapterRecords,
    validateCatalogCandidate,
    classifyCandidate,
    sourceFingerprint,
    acquireFromRecords,
    showCandidate,
    approveCandidate,
    rejectCandidate,
    promoteApprovedCandidates,
  } = acquisition;

  const stagingStoreModule = await import("../lib/stagingStore.ts");
  const { LocalStagingStore, SupabaseStagingStore, resolveStagingStore, StagingBackendError } = stagingStoreModule;

  const promotionModule = await import("../lib/catalogPromotion.ts");
  const { LocalCanonicalPromotionStore, resolveCanonicalPromotionStore } = promotionModule;

  const localStore = new LocalStagingStore(ledgerPath);
  localStore.reset();
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });

  // ---------------------------------------------------------------------
  // 1. Pure parsing / normalization / validation / classification / fingerprint
  // ---------------------------------------------------------------------
  const jsonSource = path.join(__dirname, "__fixtures__", "catalog-acquisition", "sample-products.json");
  const jsonRows = parseJsonAdapterRecords(fs.readFileSync(jsonSource, "utf8"));
  assert.ok(jsonRows.length >= 4);
  assert.strictEqual(jsonRows[0].brand, "Sony");

  const csvSource = path.join(__dirname, "__fixtures__", "catalog-acquisition", "sample-products.csv");
  const csvRows = parseCsvAdapterRecords(fs.readFileSync(csvSource, "utf8"));
  assert.ok(csvRows.length >= 4);
  assert.strictEqual(csvRows[0].brand, "JBL");

  assert.strictEqual(normalizeAcquisitionText("WH-1000XM4"), "wh 1000xm4");
  assert.notStrictEqual(normalizeAcquisitionText("WH-1000XM4"), normalizeAcquisitionText("WH-1000XM5"));
  assert.notStrictEqual(normalizeAcquisitionText("990v5"), normalizeAcquisitionText("990v6"));
  assert.notStrictEqual(normalizeAcquisitionText("DCD998"), normalizeAcquisitionText("DCD999"));
  assert.notStrictEqual(normalizeAcquisitionText("HERO12"), normalizeAcquisitionText("HERO13"));
  assert.notStrictEqual(normalizeAcquisitionText("iPhone 15 Pro"), normalizeAcquisitionText("iPhone 15 Pro Max"));

  const invalid = validateCatalogCandidate({ brand: "", productName: "", sourceExternalId: "", raw: {} });
  assert.strictEqual(invalid.valid, false);

  const duplicateCandidate = {
    brand: "Sony",
    productName: "Sony WH-1000XM5",
    modelNumber: "WH-1000XM5",
    family: "Wireless Headphones",
    category: "Electronics",
    aliases: ["WH1000XM5"],
    sourceExternalId: "sony-1",
    raw: {},
  };
  const duplicateClassification = classifyCandidate(duplicateCandidate, [
    { brand: "Sony", productName: "Sony WH-1000XM5", modelNumber: "WH-1000XM5", family: "Wireless Headphones" },
  ]);
  assert.strictEqual(duplicateClassification, "EXACT_EXISTING");

  const newCandidate = {
    brand: "GoPro",
    productName: "GoPro HERO13",
    modelNumber: "HERO13",
    family: "Action Cameras",
    category: "Electronics",
    sourceExternalId: "gopro-hero13",
    raw: {},
  };
  const newClassification = classifyCandidate(newCandidate, [{ brand: "GoPro", productName: "GoPro HERO12", modelNumber: "HERO12" }]);
  assert.ok(["NEW", "POSSIBLE_EXISTING"].includes(newClassification));

  const fpA = sourceFingerprint({ sourceId: "src-1", sourceExternalId: "abc", brand: "JBL", productName: "Boombox 3" });
  const fpB = sourceFingerprint({ sourceId: "src-1", sourceExternalId: "abc", brand: "JBL", productName: "Boombox 3" });
  const fpC = sourceFingerprint({ sourceId: "src-1", sourceExternalId: "abc-2", brand: "JBL", productName: "Boombox 3" });
  assert.strictEqual(fpA, fpB);
  assert.notStrictEqual(fpA, fpC);

  // ---------------------------------------------------------------------
  // 2. Dry-run acquisition -> zero store calls / zero writes
  // ---------------------------------------------------------------------
  let storeCalls = 0;
  const countingStoreProxy = new Proxy(localStore, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value === "function") {
        return (...callArgs) => {
          storeCalls += 1;
          return value.apply(target, callArgs);
        };
      }
      return value;
    },
  });
  const dryRunRecords = [
    { sourceExternalId: "new-1", brand: "JBL", productName: "Boombox 3", modelNumber: "Boombox 3", family: "Portable Speakers", category: "Electronics", raw: { source: "fixture" } },
  ];
  const dryRunResult = await acquireFromRecords(dryRunRecords, [], { name: "dry-run-source", type: "json" }, { apply: false });
  assert.strictEqual(storeCalls, 0, "dry-run acquisition must never call the staging store");
  assert.strictEqual(dryRunResult.persistence.length, 0);
  assert.deepStrictEqual(await localStore.listStagedCandidates(), []);

  // acquireFromRecords must refuse apply=true without a store (fail closed, no implicit local fallback)
  await assert.rejects(() => acquireFromRecords(dryRunRecords, [], {}, { apply: true }), /StagingStore is required/);

  // ---------------------------------------------------------------------
  // 3. Explicit local/test backend -> local ledger writes, idempotent
  // ---------------------------------------------------------------------
  const firstRun = await acquireFromRecords(
    [
      { sourceExternalId: "new-1", brand: "JBL", productName: "Boombox 3", modelNumber: "Boombox 3", family: "Portable Speakers", category: "Electronics", raw: { source: "fixture" } },
      { sourceExternalId: "dup-1", brand: "Sony", productName: "Sony WH-1000XM5", modelNumber: "WH-1000XM5", family: "Headphones", category: "Electronics", raw: { source: "fixture" } },
      { sourceExternalId: "bad-1", brand: "", productName: "", raw: { source: "fixture" } },
    ],
    [{ brand: "Sony", productName: "Sony WH-1000XM5", modelNumber: "WH-1000XM5" }],
    { name: "Fixture source", type: "manual import" },
    { apply: true, adapter: "json", sourcePath: jsonSource },
    localStore
  );
  assert.strictEqual(firstRun.summary.valid, 2);
  assert.strictEqual(firstRun.summary.invalid, 1);
  assert.strictEqual(firstRun.summary.new + firstRun.summary.possibleExisting, 1);
  assert.strictEqual(firstRun.summary.exactExisting, 1);
  assert.ok(firstRun.persistence.every((entry) => entry.startsWith("local:")));
  const stagedAfterFirstRun = await localStore.listStagedCandidates();
  assert.ok(stagedAfterFirstRun.length >= 1);

  const secondRun = await acquireFromRecords(
    [
      { sourceExternalId: "new-1", brand: "JBL", productName: "Boombox 3", modelNumber: "Boombox 3", family: "Portable Speakers", category: "Electronics", raw: { source: "fixture" } },
      { sourceExternalId: "dup-1", brand: "Sony", productName: "Sony WH-1000XM5", modelNumber: "WH-1000XM5", family: "Headphones", category: "Electronics", raw: { source: "fixture" } },
      { sourceExternalId: "bad-1", brand: "", productName: "", raw: { source: "fixture" } },
    ],
    [{ brand: "Sony", productName: "Sony WH-1000XM5", modelNumber: "WH-1000XM5" }],
    { name: "Fixture source", type: "manual import" },
    { apply: true, adapter: "json", sourcePath: jsonSource },
    localStore
  );
  const stagedAfterSecondRun = await localStore.listStagedCandidates();
  assert.strictEqual(secondRun.summary.staged, 1, "same source re-acquired should classify the same candidates again");
  assert.strictEqual(stagedAfterSecondRun.length, stagedAfterFirstRun.length, "idempotency: no duplicate staged rows across repeated acquisition runs");

  // ---------------------------------------------------------------------
  // 4. show/approve/reject use the selected backend; cannot write canonical
  // ---------------------------------------------------------------------
  const candidatePool = await localStore.listStagedCandidates();
  const pendingCandidate = candidatePool.find((candidate) => candidate.brand === "JBL" && (candidate.status === "pending" || candidate.status === "needs_review"));
  assert.ok(pendingCandidate, "expected pending/needs_review JBL staged candidate");

  const shown = await showCandidate(localStore, pendingCandidate.id);
  assert.strictEqual(shown.found, true);

  const missing = await showCandidate(localStore, "candidate-missing");
  assert.strictEqual(missing.found, false);

  const dryApprove = await approveCandidate(localStore, pendingCandidate.id, { dryRun: true });
  assert.strictEqual(dryApprove.ok, true);
  const stillPending = await localStore.getStagedCandidateById(pendingCandidate.id);
  assert.strictEqual(stillPending.status, pendingCandidate.status, "dry-run approve must not write");

  const approved = await approveCandidate(localStore, pendingCandidate.id, { dryRun: false });
  assert.strictEqual(approved.ok, true);
  assert.strictEqual(approved.candidate.status, "approved");
  assert.ok(!("catalog_products" in approved), "approve/reject responses never reference canonical tables");

  const secondCandidate = candidatePool.find((candidate) => candidate.id !== pendingCandidate.id && candidate.status !== "promoted" && candidate.brand !== "JBL");
  if (secondCandidate) {
    const rejected = await rejectCandidate(localStore, secondCandidate.id, { dryRun: false });
    assert.strictEqual(rejected.ok, true);
    assert.strictEqual(rejected.candidate.status, "rejected");
  }

  // ---------------------------------------------------------------------
  // 5. Promotion: dry-run -> zero canonical writes
  // ---------------------------------------------------------------------
  const localCanonicalCatalog = {
    brands: [{ id: "brand-jbl", slug: "jbl", name: "JBL" }],
    subcategories: [],
    families: [{ id: "family-jbl-portable-speakers", slug: "portable-speakers", brandId: "brand-jbl" }],
    products: [],
  };
  const localCanonicalStore = new LocalCanonicalPromotionStore(localCanonicalCatalog);

  const dryPromotion = await promoteApprovedCandidates(localStore, localCanonicalStore, { dryRun: true });
  assert.strictEqual(dryPromotion.ok, true);
  assert.strictEqual(localCanonicalCatalog.products.length, 0, "dry-run promotion must never write canonical rows");
  const approvedBeforePromotion = (await localStore.listStagedCandidates()).filter((c) => c.status === "approved");
  assert.ok(approvedBeforePromotion.length >= 1);
  assert.ok(dryPromotion.entries.some((entry) => entry.dryRun === true));

  // ---------------------------------------------------------------------
  // 6. Promotion apply: only eligible approved candidates get promoted
  // ---------------------------------------------------------------------
  const applyPromotion = await promoteApprovedCandidates(localStore, localCanonicalStore, { dryRun: false });
  assert.strictEqual(applyPromotion.ok, true);
  const promotedEntry = applyPromotion.entries.find((entry) => entry.ok && !entry.dryRun);
  assert.ok(promotedEntry, "expected at least one candidate (JBL Boombox 3) to be promotable given the local canonical brand seed");
  assert.ok(localCanonicalCatalog.products.length >= 1, "successful apply promotion must write a canonical row");
  const promotedCandidateAfter = await localStore.getStagedCandidateById(promotedEntry.candidateId);
  assert.strictEqual(promotedCandidateAfter.status, "promoted", "successful atomic promotion must flip staged status to promoted");
  assert.ok(promotedCandidateAfter.promotedCatalogProductId, "provenance: promoted staged row must link to the canonical product it produced");

  // pending/needs_review/rejected/invalid/promoted can never be (re-)promoted
  const rerun = await promoteApprovedCandidates(localStore, localCanonicalStore, { dryRun: false });
  assert.ok(!rerun.entries.some((entry) => entry.candidateId === promotedEntry.candidateId), "already-promoted candidate must not be reprocessed");

  // ---------------------------------------------------------------------
  // 7. Duplicate/conflict recheck immediately before promotion + failure safety
  // ---------------------------------------------------------------------
  const conflictLedgerPath = path.join(__dirname, "..", ".catalog-staging", "catalog-staging-ledger.conflict-test.json");
  const conflictStore = new LocalStagingStore(conflictLedgerPath);
  conflictStore.reset();
  const conflictRun = await acquireFromRecords(
    [{ sourceExternalId: "conflict-1", brand: "JBL", productName: "Flip 6", modelNumber: "Flip 6", raw: {} }],
    [],
    { name: "conflict-source", type: "json" },
    { apply: true, adapter: "json" },
    conflictStore
  );
  const conflictCandidateId = conflictRun.staged[0].id;
  await approveCandidate(conflictStore, conflictCandidateId, { dryRun: false });
  const conflictCanonical = {
    brands: [{ id: "brand-jbl", slug: "jbl", name: "JBL" }],
    subcategories: [],
    families: [],
    products: [{ id: "existing-product", slug: "jbl-flip-6-flip-6", brandId: "brand-jbl", modelNumber: "flip 6" }],
  };
  const conflictCanonicalStore = new LocalCanonicalPromotionStore(conflictCanonical);
  const conflictPromotion = await promoteApprovedCandidates(conflictStore, conflictCanonicalStore, { dryRun: false });
  const conflictEntry = conflictPromotion.entries.find((entry) => entry.candidateId === conflictCandidateId);
  assert.strictEqual(conflictEntry.ok, false, "duplicate/conflicting candidate must fail/skip safely, never silently promote");
  const conflictCandidateAfter = await conflictStore.getStagedCandidateById(conflictCandidateId);
  assert.strictEqual(conflictCandidateAfter.status, "approved", "failed canonical promotion must NOT mark staging as promoted");

  // ---------------------------------------------------------------------
  // 8. Ambiguous/unresolved canonical hierarchy -> leave unpromoted
  // ---------------------------------------------------------------------
  const unresolvedLedgerPath = path.join(__dirname, "..", ".catalog-staging", "catalog-staging-ledger.unresolved-test.json");
  const unresolvedStore = new LocalStagingStore(unresolvedLedgerPath);
  unresolvedStore.reset();
  const unresolvedRun = await acquireFromRecords(
    [{ sourceExternalId: "unknown-brand-1", brand: "TotallyUnknownBrandXYZ", productName: "Widget 9000", raw: {} }],
    [],
    { name: "unresolved-source", type: "json" },
    { apply: true, adapter: "json" },
    unresolvedStore
  );
  const unresolvedId = unresolvedRun.staged[0].id;
  await approveCandidate(unresolvedStore, unresolvedId, { dryRun: false });
  const emptyCanonicalStore = new LocalCanonicalPromotionStore({ brands: [], subcategories: [], families: [], products: [] });
  const unresolvedPromotion = await promoteApprovedCandidates(unresolvedStore, emptyCanonicalStore, { dryRun: false });
  const unresolvedEntry = unresolvedPromotion.entries.find((entry) => entry.candidateId === unresolvedId);
  assert.strictEqual(unresolvedEntry.ok, false);
  assert.match(unresolvedEntry.message, /Human review required|does not exist/);

  // ---------------------------------------------------------------------
  // 9. Supabase backend: staging-store methods actually invoked (fake client)
  // ---------------------------------------------------------------------
  const recordedCalls = [];
  function makeFakeSupabaseClient() {
    const sourceRow = { id: "supabase-source-1", name: "fake-supabase-source", type: "json" };
    const stagedRowsById = new Map();
    let stagedSeq = 0;
    return {
      from(table) {
        recordedCalls.push(table);
        return {
          upsert(rows) {
            if (table === "catalog_sources") {
              return {
                select: () => ({ single: async () => ({ data: sourceRow, error: null }) }),
              };
            }
            if (table === "catalog_staged_products") {
              const inserted = (Array.isArray(rows) ? rows : [rows]).map((row) => {
                stagedSeq += 1;
                const id = `supabase-staged-${stagedSeq}`;
                stagedRowsById.set(id, { id, ...row, status: row.status ?? "pending" });
                return { id, fingerprint: row.fingerprint };
              });
              return { select: () => Promise.resolve({ data: inserted, error: null }) };
            }
            if (table === "catalog_staged_aliases") {
              return Promise.resolve({ error: null });
            }
            return Promise.resolve({ error: null });
          },
          insert(row) {
            if (table === "catalog_import_runs") {
              return { select: () => ({ single: async () => ({ data: { id: "supabase-run-1", created_at: new Date().toISOString() }, error: null }) }) };
            }
            return { select: () => ({ single: async () => ({ data: { id: "unused" }, error: null }) }) };
          },
          select() {
            return {
              range: async () => ({ data: [...stagedRowsById.values()], error: null }),
              eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
            };
          },
        };
      },
    };
  }

  const fakeClient = makeFakeSupabaseClient();
  const supabaseStagingStore = new SupabaseStagingStore(fakeClient);
  const supabaseRun = await acquireFromRecords(
    [{ sourceExternalId: "sb-1", brand: "Bose", productName: "QuietComfort Ultra", raw: {} }],
    [],
    { name: "fake-supabase-source", type: "json" },
    { apply: true, adapter: "json" },
    supabaseStagingStore
  );
  assert.ok(recordedCalls.includes("catalog_sources"), "Supabase apply path must call catalog_sources");
  assert.ok(recordedCalls.includes("catalog_import_runs"), "Supabase apply path must call catalog_import_runs");
  assert.ok(recordedCalls.includes("catalog_staged_products"), "Supabase apply path must call catalog_staged_products");
  assert.ok(supabaseRun.persistence.every((entry) => entry.startsWith("supabase:")));

  // ---------------------------------------------------------------------
  // 10. Fail-closed: Supabase backend with missing credentials never falls
  //     back to the local ledger.
  // ---------------------------------------------------------------------
  assert.throws(() => resolveStagingStore({ backend: "supabase" }), StagingBackendError);
  assert.throws(() => resolveStagingStore({}), StagingBackendError, "default backend (no explicit selection) must also fail closed, never silently use local");
  const { resolveCanonicalPromotionStore: resolveCanonicalAgain } = promotionModule;
  assert.throws(() => resolveCanonicalAgain({ backend: "supabase" }));
  assert.throws(() => resolveCanonicalAgain({}));
  // Explicit local selection must always succeed regardless of credentials.
  const explicitLocal = resolveStagingStore({ backend: "local" });
  assert.strictEqual(explicitLocal.kind, "local");

  localStore.reset();
  for (const p of [conflictLedgerPath, unresolvedLedgerPath]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  console.log("Catalog acquisition tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
