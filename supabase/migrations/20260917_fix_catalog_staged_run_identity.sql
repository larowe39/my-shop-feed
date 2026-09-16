-- Additive migration for correct run-scoped staging dedupe.
-- This is intentionally additive: it fixes the global unique(fingerprint)
-- constraint that allowed cross-run overwrites and prevented truthful run
-- reporting. Do not run this in production; the working branch keeps the
-- migration unexecuted until the PR is reviewed and merged by the operator.

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conrelid = 'public.catalog_staged_products'::regclass
      and conname = 'catalog_staged_products_fingerprint_key'
  ) then
    alter table public.catalog_staged_products
      drop constraint catalog_staged_products_fingerprint_key;
  end if;
end $$;

create unique index if not exists catalog_staged_products_run_fingerprint_idx
  on public.catalog_staged_products (import_run_id, fingerprint);

create unique index if not exists catalog_staged_products_run_source_external_id_idx
  on public.catalog_staged_products (import_run_id, source_external_id)
  where source_external_id is not null;

comment on index public.catalog_staged_products_run_fingerprint_idx is
  'Run-scoped staging identity. The same fingerprint may reappear across runs, but not within the same run; this preserves provenance and truthful run audits.';

comment on index public.catalog_staged_products_run_source_external_id_idx is
  'Protect same-run source-product idempotency when the same source source_external_id is re-encountered without changing the fingerprint.';
