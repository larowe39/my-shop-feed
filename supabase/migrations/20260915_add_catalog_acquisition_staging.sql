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
  promoted_catalog_product_id uuid references public.catalog_products(id) on delete set null,
  promoted_at timestamptz,
  review_notes text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (fingerprint)
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
comment on column public.catalog_staged_products.promoted_catalog_product_id is
  'Set only after successful atomic promotion; links the staged row to the canonical catalog_products row it produced.';

-- Atomic staging -> canonical promotion. Everything below (final duplicate
-- recheck, canonical product insert, alias inserts, and the staged row's
-- status transition to 'promoted') executes as a single statement from the
-- caller's perspective, so Postgres commits or rolls back all of it together
-- -- there is no window where a canonical row exists but the staged row still
-- says 'approved', or vice versa. Only ever called for status = 'approved'
-- rows; row is locked FOR UPDATE to avoid a concurrent double-promotion.
create or replace function public.promote_catalog_staged_product(
  p_staged_id uuid,
  p_brand_id uuid,
  p_subcategory_id uuid,
  p_family_id uuid,
  p_slug text,
  p_name text,
  p_model_number text,
  p_description text,
  p_attributes jsonb,
  p_aliases jsonb
) returns table (catalog_product_id uuid) language plpgsql as $$
declare
  v_staged public.catalog_staged_products%rowtype;
  v_product_id uuid;
  v_existing_product_id uuid;
begin
  select * into v_staged from public.catalog_staged_products where id = p_staged_id for update;
  if not found then
    raise exception 'staged candidate % not found', p_staged_id;
  end if;
  if v_staged.status <> 'approved' then
    raise exception 'staged candidate % is not approved (status=%)', p_staged_id, v_staged.status;
  end if;

  -- Final duplicate/conflict recheck immediately before writing, inside the
  -- same transaction as the write itself (closes the TOCTOU gap between the
  -- caller's pre-check and this function running).
  select id into v_existing_product_id
  from public.catalog_products
  where slug = p_slug
     or (p_model_number is not null and brand_id = p_brand_id and model_number = p_model_number)
  limit 1;

  if v_existing_product_id is not null then
    raise exception 'canonical product already exists (id=%) matching slug/model-number; refusing duplicate promotion', v_existing_product_id;
  end if;

  insert into public.catalog_products (brand_id, family_id, subcategory_id, slug, name, model_number, description, attributes)
  values (p_brand_id, p_family_id, p_subcategory_id, p_slug, p_name, p_model_number, p_description, coalesce(p_attributes, '{}'::jsonb))
  returning id into v_product_id;

  insert into public.catalog_aliases (entity_type, entity_id, alias, normalized_alias)
  select 'product', v_product_id, alias_row->>'alias', alias_row->>'normalized_alias'
  from jsonb_array_elements(coalesce(p_aliases, '[]'::jsonb)) as alias_row
  where coalesce(alias_row->>'normalized_alias', '') <> ''
  on conflict (entity_type, normalized_alias) do nothing;

  update public.catalog_staged_products
    set status = 'promoted',
        promoted_catalog_product_id = v_product_id,
        promoted_at = timezone('utc', now()),
        updated_at = timezone('utc', now())
  where id = p_staged_id;

  return query select v_product_id;
end;
$$;

comment on function public.promote_catalog_staged_product is
  'Atomically promotes one approved staged candidate to the canonical catalog: rechecks duplicates, inserts catalog_products + catalog_aliases, and flips the staged row to promoted, all in one transaction.';
