alter table public.catalog_staged_products
  add column if not exists import_run_id uuid references public.catalog_import_runs(id) on delete set null,
  add column if not exists image_url text,
  add column if not exists upc text,
  add column if not exists gtin text,
  add column if not exists mpn text;

create index if not exists catalog_staged_products_import_run_idx
  on public.catalog_staged_products(import_run_id, created_at desc);

comment on column public.catalog_staged_products.import_run_id is
  'Import run that first staged or refreshed this candidate; retained for review auditability.';