# Catalog Apply Safety

This branch is preparation for a later small, human-controlled catalog apply. This document is not authorization to apply. The next gate is Astra Ultra re-review of the exact repaired PR head. No live Open Icecat acquisition or production write is part of this repair.

## Supported Apply Path

Only the Open Icecat discovery path is supported for `--apply`: `catalog-acquire-icecat.js --discover --mode initial`. Apply through file input or lookup mode fails closed. Ordinary invocation without `--apply` remains a zero-write dry run. Apply requires an explicit integer `--limit` from 1 through 100. Same-run recovery requires `--resume-run RUN_ID`; the stored cursor is used automatically and provider, source, mode, filters, limit, page size, and concurrency must match the failed run.

The first apply recommendation is 1-10 records, `--page-size` equal to the chosen limit, and `--concurrency 1`. Keep the page size at or below the limit. Do not start with the maximum bound.

## Persistence And Acknowledgment

The path is `catalog-acquire-icecat.js` -> `acquireDiscoveredProducts` -> `processDiscoveredPages` -> `acquireFromRecords` -> `StagingStore`. Source and `partial` import-run creation are separate writes. Discovery persists page by page, not in fixed 200-product groups. Within a page, product upsert statements commit independently from alias statements; aliases may commit in separate batches. A product row can therefore remain durable after an alias failure. Same-run replay deduplicates `(import_run_id, fingerprint)` and `(import_run_id, source_external_id)` identities and reconciles missing aliases.

**Acknowledgment invariant:** A discovery page may only be acknowledged after all records up to that frontier have reached the required durable persistence/accounting state: accepted candidates and aliases are persisted, staged count is reconciled, and invalid/provider dispositions plus page counters are durably recorded in `summary.pendingPage`. Cumulative run counters advance only in a second update after the provider acknowledgment callback returns. A provider-error page fails closed and is not acknowledged. An incompatible duplicate payload is recorded as an invalid disposition before the page can advance.

The provider acknowledgment frontier is in memory; it is not a transactional or independently durable database cursor. After the provider callback advances, the cumulative counters and opaque continuation token are written to `catalog_import_runs.summary.acknowledgedCursor`, and `pendingPage` is cleared. If this update fails and read-only reconciliation cannot prove it committed, recovery uses the last token already stored, ignores pending page counters, and safely replays from that earlier boundary. The CLI prints the run ID before acquisition starts, prints the usable token after it is persisted, and supplies a same-run recovery command. Acknowledgment failure after writes does not roll those writes back.

Run status meanings:

- `partial`: a run exists and pages may still be applied.
- `completed`: the final staged count was read and completed status/counters were accepted, or a lost response was reconciled by reading the run back as completed.
- `failed`: a provider, persistence, accounting, acknowledgment, count, or finalization failure interrupted the run. Some page writes may already be durable.
- `UNKNOWN/AMBIGUOUS`: operator output could not prove the final database status or durable staged count. Reconcile read-only before doing anything else.

Counters are durable database counts or accounted dispositions, never attempted candidate counts. Validation/normalization failures are retained in `summary.invalidRecords`; provider/transport errors are separate. `staged` must agree with a read-only count of `catalog_staged_products` for the run.

No migration is added or required by this repair. The four migrations already deployed manually must not be rewritten in place: `20260915_add_catalog_acquisition_staging.sql`, `20260916_extend_catalog_staging_observability.sql`, `20260917_add_catalog_taxonomy_mappings.sql`, and `20260917_fix_catalog_staged_run_identity.sql`.

## Preconditions

1. Complete Astra Ultra re-review and the repository's normal approval gates before considering a production apply. Keep PR #33 Draft until that review requests otherwise.
2. Confirm the intended Supabase project in its dashboard/CLI and verify Supabase health before acquisition. Use a read-only SQL session to confirm the staging tables are reachable and inspect the latest run status. Do not use an apply command as a health check.
3. Ensure Open Icecat service availability and credentials are configured locally in gitignored `.env.local`; never print credentials or change service-role credentials as part of this procedure.
4. Record a read-only pre-apply snapshot of the canonical table counts below. Confirm the staging and taxonomy-mapping tables exist and the service-role connection is healthy.
5. Run a matching offline/mock dry run or the planned bounded dry run with `--limit N --page-size N --concurrency 1` and no `--apply`; verify `DRY RUN -- ZERO Supabase staging/canonical writes`. A live provider dry run is still a provider request and is outside this offline repair.
6. Confirm no other operator is acquiring, reviewing, approving, rejecting, or promoting candidates in the same source/run window.

## First Apply Template

Do not execute this template while preparing for Astra re-review. Choose the same value `N` for limit and page size, where `1 <= N <= 10`:

```sh
npm run catalog:acquire:icecat -- --discover --mode initial --limit N --page-size N --concurrency 1 --apply
```

Expected startup output includes `IMPORT RUN ID`, `SOURCE ID`, `RUN STATUS: partial`, and a same-run recovery command before page acquisition. On success, expect `RUN STATUS: completed`, processed/valid/invalid/provider-error counters, a staged count that matches the database, and the persisted acknowledged continuation token. No approval or promotion is performed.

## Read-Only Verification

Record the run ID printed at startup. Use read-only queries only; replace `RUN_ID` with that ID. The CLI's `catalog:staging:status` and `catalog:staging:list` are also read-only alternatives.

```sql
select id, source_id, adapter, status, processed, valid, invalid, staged, errors,
	   summary->>'failurePhase' as failure_phase,
	   summary->>'durableStagedCount' as durable_staged_count,
	   summary->>'acknowledgedCursor' is not null as has_acknowledged_cursor
from public.catalog_import_runs
where id = 'RUN_ID';

select count(*) as durable_staged_rows
from public.catalog_staged_products
where import_run_id = 'RUN_ID';

select p.id, p.source_external_id, p.normalized_brand, p.normalized_name,
	   p.status, p.review_notes, p.raw_payload->'externalTaxonomy' as external_taxonomy,
	   p.raw_payload->'taxonomyMapping' as taxonomy_mapping,
	   a.alias, a.normalized_alias
from public.catalog_staged_products p
left join public.catalog_staged_aliases a on a.staged_product_id = p.id
where p.import_run_id = 'RUN_ID'
order by p.source_external_id, a.normalized_alias;
```

Confirm the run's `staged` value equals `durable_staged_rows`. Check every source ID for one staged row, aliases for unique normalized keys, explicit useful aliases retained, and no empty/punctuation-only or bare-brand alias. Alias normalization is unchanged: `X100`/`x100` normalize to `x100`; `X-100`/`X 100`/`x_100` normalize to `x 100`; `A/B`/`A B` normalize to `a b`.

Unresolved taxonomy must remain `needs_review`, with external taxonomy retained for review and no automatic mapping. Check that `taxonomy_mapping` is trusted/verified only where there was an existing verified mapping. Acquisition must not write `catalog_taxonomy_mappings`.

Before the later apply, and again after it, compare these read-only counts; acquisition must not change any of them:

```sql
select 'catalog_products' as table_name, count(*) from public.catalog_products
union all select 'catalog_product_variants', count(*) from public.catalog_product_variants
union all select 'catalog_product_families', count(*) from public.catalog_product_families
union all select 'catalog_brands', count(*) from public.catalog_brands
union all select 'catalog_categories', count(*) from public.catalog_categories
union all select 'catalog_subcategories', count(*) from public.catalog_subcategories
union all select 'catalog_aliases', count(*) from public.catalog_aliases
union all select 'products.catalog_product_id links', count(*) from public.products where catalog_product_id is not null
union all select 'catalog_taxonomy_mappings', count(*) from public.catalog_taxonomy_mappings;
```

Counts are a sanity check, not a substitute for the code-level canonical-write isolation: acquisition may write only `catalog_sources`, `catalog_import_runs`, `catalog_staged_products`, and `catalog_staged_aliases`. Do not query or print secrets.

## Abort And Recovery

Abort the first apply and stop all review/promotion activity if the run ID is missing, status/counters disagree with database rows, any provider errors occur, alias reconciliation is incomplete, taxonomy is unexpectedly resolved or not review-blocked, canonical counts change, or Supabase health becomes uncertain. Do not approve, reject, or promote as part of acquisition verification.

Never blindly rerun the initial command after failure. Preserve the run ID and error phase. If the CLI prints a same-run recovery command, inspect the existing run and staged rows read-only, confirm status is `failed` or `partial`, confirm the provider/source/mode/filter/bounds are unchanged, then use that exact `--resume-run RUN_ID` entry point. It resumes from the last persisted token; if the failing page was not acknowledged, it replays that page in the same run and reconciles product/alias writes. Recovery does not approve or promote.

For `UNKNOWN/AMBIGUOUS`, do not retry. Re-read `catalog_import_runs`, count run-scoped staged products, inspect aliases and the stored cursor, and reconcile whether finalization committed. If status is `completed`, do not replay. If status is `partial`/`failed`, follow the same-run recovery gate only after confirming the stored context and exact recovery command. If status or rows cannot be established read-only, stop and escalate; never create a replacement run to hide uncertainty.

Do not perform broad cleanup or destructive SQL. If a defect is found, retain the run and provenance for review. No approval or promotion is part of acquisition verification. Production migrations listed above are deployed and must not be rewritten.

## Offline Evidence

Offline tests exercise the page acknowledgment frontier, invalid/provider distinction, statement-level product/alias commits, alias-batch retry, duplicate conflict semantics, count/finalization failures, ambiguous update responses, same-run recovery, review-state protection, dry-run zero-write behavior, and canonical/taxonomy isolation. These results support another adversarial review only; they do not authorize production apply.
