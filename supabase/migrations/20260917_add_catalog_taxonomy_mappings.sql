create table if not exists public.catalog_taxonomy_mappings (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_taxonomy_id text not null,
  external_name text,
  external_path text,
  external_parent_id text,
  external_parent_path text,
  canonical_category_id uuid references public.catalog_categories(id) on delete restrict,
  canonical_subcategory_id uuid references public.catalog_subcategories(id) on delete restrict,
  mapping_status text not null default 'suggested' check (mapping_status in ('unmapped', 'suggested', 'verified', 'rejected')),
  mapping_method text not null check (mapping_method in ('manual', 'exact_deterministic', 'verified_reuse', 'automated_suggestion')),
  confidence double precision check (confidence is null or (confidence >= 0 and confidence <= 1)),
  evidence jsonb not null default '{}'::jsonb,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (provider, external_taxonomy_id),
  check (canonical_category_id is not null or canonical_subcategory_id is null)
);

create index if not exists catalog_taxonomy_mappings_status_idx
  on public.catalog_taxonomy_mappings(mapping_status, provider, updated_at desc);

alter table public.catalog_taxonomy_mappings enable row level security;
create policy "Catalog taxonomy mappings are not publicly readable"
  on public.catalog_taxonomy_mappings for select using (false);

comment on table public.catalog_taxonomy_mappings is
  'Operator-reviewed provider taxonomy mappings. Only verified mappings may resolve staged candidates into canonical hierarchy.';