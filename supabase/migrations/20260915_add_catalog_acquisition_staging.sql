create table if not exists public.catalog_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  type text not null,
  base_url text,
  trust_classification text not null default 'raw' check (trust_classification in ('raw', 'staged', 'canonical')),
  active boolean not null default true,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.catalog_import_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.catalog_sources(id) on delete set null,
  adapter text not null,
  source_path text,
  dry_run boolean not null default true,
  processed integer not null default 0,
  valid integer not null default 0,
  invalid integer not null default 0,
  exact_existing integer not null default 0,
  likely_existing integer not null default 0,
  possible_existing integer not null default 0,
  new_records integer not null default 0,
  conflict_records integer not null default 0,
  approved integer not null default 0,
  rejected integer not null default 0,
  promoted integer not null default 0,
  status text not null default 'completed' check (status in ('completed', 'failed', 'partial')),
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.catalog_staged_products (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.catalog_sources(id) on delete set null,
  source_external_id text,
  fingerprint text not null,
  raw_payload jsonb not null default '{}'::jsonb,
  normalized_brand text,
  normalized_name text,
  normalized_model text,
  proposed_category text,
  proposed_subcategory text,
  proposed_family text,
  source_url text,
  source_type text,
  acquired_at timestamptz not null default timezone('utc', now()),
  last_verified_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'needs_review', 'duplicate', 'invalid', 'promoted')),
  confidence double precision not null default 0,
  duplicate_of_catalog_product_id uuid references public.catalog_products(id) on delete set null,
  review_notes text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.catalog_staged_aliases (
  id uuid primary key default gen_random_uuid(),
  staged_product_id uuid not null references public.catalog_staged_products(id) on delete cascade,
  alias text not null,
  normalized_alias text not null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (staged_product_id, normalized_alias)
);

create index if not exists catalog_sources_active_idx on public.catalog_sources(active, trust_classification);
create index if not exists catalog_import_runs_source_idx on public.catalog_import_runs(source_id, created_at desc);
create index if not exists catalog_staged_products_status_idx on public.catalog_staged_products(status, created_at desc);
create index if not exists catalog_staged_products_fingerprint_idx on public.catalog_staged_products(fingerprint);
create index if not exists catalog_staged_aliases_normalized_idx on public.catalog_staged_aliases(normalized_alias);

alter table public.catalog_sources enable row level security;
alter table public.catalog_import_runs enable row level security;
alter table public.catalog_staged_products enable row level security;
alter table public.catalog_staged_aliases enable row level security;

create policy "Catalog sources are not publicly readable" on public.catalog_sources for select using (false);
create policy "Catalog import runs are not publicly readable" on public.catalog_import_runs for select using (false);
create policy "Catalog staged products are not publicly readable" on public.catalog_staged_products for select using (false);
create policy "Catalog staged aliases are not publicly readable" on public.catalog_staged_aliases for select using (false);

comment on table public.catalog_sources is 'Registry of trusted acquisition sources and their provenance metadata.';
comment on table public.catalog_import_runs is 'Audit ledger for one acquisition pass across a source and adapter.';
comment on table public.catalog_staged_products is 'Staged candidate catalog products that have not yet been promoted to canonical catalog status.';
comment on table public.catalog_staged_aliases is 'Aliases associated with staged candidate products; these are not canonical catalog aliases.';
