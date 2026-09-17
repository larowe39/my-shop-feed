# Catalog Apply Safety

This branch prepares the first controlled Open Icecat apply. It does not authorize or execute a live apply.

## Apply path and durability

The call path is `catalog-acquire-icecat.js` -> `acquireDiscoveredProducts` -> `processDiscoveredPages` -> `acquireFromRecords` -> `StagingStore`. Apply writes, in order, `catalog_sources`, one `catalog_import_runs` row with `partial` status, staged products, staged aliases, and final run counters/status. The page acknowledgment is called only after page persistence returns successfully. Provider continuation is therefore replayable when normalization, persistence, finalization, or acknowledgment fails.

Source and run creation are separate writes. Product and alias writes are separate Supabase operations inside `upsertStagedCandidates`; a product write can therefore succeed before an alias write fails. The repair is application-level idempotent retry: product identity is run-scoped by `(import_run_id, fingerprint)` and aliases by `(staged_product_id, normalized_alias)`. A retry reconciles aliases even when the product already exists. No transactional RPC is required for staging correctness, and no migration is added in this PR; the existing run-identity migration provides the required indexes.

Run statuses mean:

- `partial`: run exists and is still receiving pages.
- `completed`: all pages persisted and the final counters were written.
- `failed`: a persistence, finalization, or acknowledgment failure interrupted the run; the failure and invalid dispositions are retained in `summary`.

A completed status is never inferred from attempted counts. Invalid normalization records are counted separately from provider errors and retained in the run summary; they do not advance the durable success frontier.

## Alias identity

Staged and canonical promotion use the same lower-case, punctuation/whitespace-normalized conflict key. Product name, model number, and explicit source aliases are retained, while bare brand aliases are excluded. `X100`, `x-100`, and `X 100` produce one conflict key. Meaningfully different aliases remain distinct.

## First controlled apply runbook

Pre-flight:

1. Start from reviewed `main`, confirm the branch and clean working tree, and keep service credentials only in gitignored `.env.local`.
2. Run the matching bounded dry run with `--limit 10 --page-size 10`; verify the expected `DRY RUN -- ZERO Supabase staging/canonical writes` output.
3. Confirm the expected canonical write count is zero. Acquisition never approves, promotes, or writes canonical products, aliases, or taxonomy.

Command:

```sh
npm run catalog:acquire:icecat -- --discover --mode initial --limit 10 --page-size 10 --concurrency 1 --apply
```

The CLI refuses apply without an explicit limit between 1 and 100. Record the printed import run ID, source ID, counters, status, and acknowledged continuation.

Post-flight inspection:

```sh
npm run catalog:staging:status -- --run-id RUN_ID
npm run catalog:staging:list -- --run-id RUN_ID --limit 25
```

Inspect staged products, staged aliases, source provenance, raw external taxonomy, unresolved taxonomy status, and the import run summary. Confirm canonical product, alias, taxonomy, approval, and promotion tables are unchanged.

Idempotency verification:

Reprocess the same bounded source page/run only after recording the first run ID. Confirm the same run has one staged row per fingerprint/source identity and one alias per normalized conflict key. A failed run must remain `failed` until a deliberate retry/recovery decision; a fresh run retains separate provenance by design.

Rollback/cleanup:

Do not issue broad destructive SQL. If the tiny run exposes a defect, stop approval and promotion, retain the run ID, and use the operator staging review/reject workflow for identified candidates. Any cleanup must be scoped by `import_run_id` and source provenance after human review.

## Advisory gates

| Gate | Status | Evidence |
|---|---|---|
| Apply persistence correctness | PASS | Offline store and Supabase-shaped harness cover ordered writes. |
| Idempotency | PASS | Same-run product and alias retry converges in deterministic tests. |
| Partial-failure recovery | PASS | Failure after staged write leaves retryable state; discovery marks run failed. |
| Acknowledgment safety | REVIEW | Ordering is explicit and tested structurally; live consumer failure remains offline-only. |
| Counter reconciliation | PASS | Final counters are read from persisted staged rows and invalid dispositions are retained. |
| Alias integrity | PASS | Shared normalized conflict key and adversarial variants are tested. |
| Taxonomy review safety | PASS | Unresolved candidates remain review-required and are never promoted by acquisition. |
| Canonical isolation | PASS | Acquisition has no approval/promotion path and uses staging tables only. |
| Dry-run isolation | PASS | Existing zero-store-call regression coverage remains green. |
| Controlled-bound safety | PASS | Apply requires an explicit `--limit` from 1 through 100. |

The gates are advisory and do not authorize a live apply. No live Icecat request or production write was made while preparing this branch.

## Batching implications

Supabase staged-product batches remain 200 and alias batches remain 500. Page size 25 means a 10-product apply uses one partial product and alias batch; 100 products still use one product batch and one alias batch; 1,000 products use five product batches and two alias batches per logical run. Page persistence governs recovery and acknowledgment boundaries, not maximum batch fill. Throughput optimization is intentionally out of scope.
