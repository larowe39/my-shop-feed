-- Taste Graph foundation (PR #34): derived, rebuildable user taste affinities.
--
-- public.user_events remains the append-only behavioral source of truth. The
-- two tables below hold DERIVED state produced by the deterministic rebuild
-- path (scripts/taste-graph-rebuild.js, engine in lib/tasteGraph.ts). The
-- mobile client never writes these tables directly: taste_entities is
-- read-only for authenticated users and user_taste_affinities is read-own
-- only. All writes happen through the Supabase service role, which bypasses
-- RLS.
--
-- Rebuilds use snapshot-replacement semantics (upsert new snapshot, delete
-- rows for entities no longer present), so re-applying the same snapshot
-- converges instead of inflating scores or counts.

create table if not exists public.taste_entities (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('product', 'canonical_product', 'brand', 'category', 'seller')),
  entity_key text not null check (length(entity_key) > 0),
  display_name text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (entity_type, entity_key)
);

create index if not exists taste_entities_type_key_idx
  on public.taste_entities (entity_type, entity_key);

create table if not exists public.user_taste_affinities (
  user_id uuid not null references auth.users (id) on delete cascade,
  taste_entity_id uuid not null references public.taste_entities (id) on delete cascade,
  long_term_score double precision not null default 0,
  recent_score double precision not null default 0,
  positive_signal_count integer not null default 0 check (positive_signal_count >= 0),
  negative_signal_count integer not null default 0 check (negative_signal_count >= 0),
  last_interaction_at timestamptz,
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, taste_entity_id)
);

create index if not exists user_taste_affinities_entity_idx
  on public.user_taste_affinities (taste_entity_id);

alter table public.taste_entities enable row level security;
alter table public.user_taste_affinities enable row level security;

-- taste_entities rows are non-sensitive lookup data (a product/brand/category
-- label, never user data), so any authenticated user may read them. No
-- insert/update/delete policies exist for clients: entities are created and
-- maintained exclusively by the service-role rebuild path.
create policy "Authenticated users can read taste entities"
  on public.taste_entities
  for select
  to authenticated
  using (true);

-- A user may read ONLY their own derived affinities (needed for future
-- feed/explainability UI). No client insert/update/delete policies exist, so
-- users cannot write arbitrary scores; only the service role can manage
-- derived state.
create policy "Users can read their own taste affinities"
  on public.user_taste_affinities
  for select
  to authenticated
  using (auth.uid() = user_id);

create or replace function public.set_taste_entities_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists taste_entities_updated_at on public.taste_entities;
create trigger taste_entities_updated_at
  before update on public.taste_entities
  for each row execute function public.set_taste_entities_updated_at();

create or replace function public.set_user_taste_affinities_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists user_taste_affinities_updated_at on public.user_taste_affinities;
create trigger user_taste_affinities_updated_at
  before update on public.user_taste_affinities
  for each row execute function public.set_user_taste_affinities_updated_at();
