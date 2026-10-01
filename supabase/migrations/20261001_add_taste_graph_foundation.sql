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

-- ---------------------------------------------------------------------------
-- Atomic per-user affinity snapshot replacement (service role only).
--
-- Rebuilds persist a user's derived affinities as one indivisible transition
-- from the old snapshot to the new snapshot: upsert the supplied rows AND
-- delete that same user's stale rows inside a single PostgreSQL function
-- call. If anything fails (bad input, FK violation, negative counts,
-- duplicate entity ids), PostgreSQL raises and rolls back EVERY change made
-- by the call, so the user's previous snapshot is preserved.
--
-- Security model:
--   - SECURITY INVOKER on purpose: the function runs with the caller's
--     privileges. The intended caller is the Supabase service role, which
--     bypasses RLS. If EXECUTE were ever granted to an authenticated client
--     by mistake, RLS would still block the writes because no client
--     insert/update/delete policies exist on user_taste_affinities.
--   - EXECUTE is revoked from PUBLIC (Postgres grants it by default), anon,
--     and authenticated, and granted ONLY to service_role.
--   - The function only ever touches rows where user_id = p_user_id, so one
--     user's replacement can never affect another user's affinities.
--   - search_path is emptied and all tables are schema-qualified.
--
-- Mobile clients never call this: they have no EXECUTE privilege and no
-- write policies, so arbitrary score mutation through the API is impossible.
-- ---------------------------------------------------------------------------
create or replace function public.replace_user_taste_affinity_snapshot(
  p_user_id uuid,
  p_rows jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_upserted integer := 0;
  v_deleted integer := 0;
begin
  -- Fail closed on invalid input. Raising here aborts the call and rolls
  -- back everything this invocation has done.
  if p_user_id is null then
    raise exception 'replace_user_taste_affinity_snapshot: p_user_id must not be null';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'replace_user_taste_affinity_snapshot: p_rows must be a jsonb array of affinity rows';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_rows) as r
    where jsonb_typeof(r) <> 'object'
       or r ->> 'taste_entity_id' is null
       or r ->> 'long_term_score' is null
       or r ->> 'recent_score' is null
       or r ->> 'positive_signal_count' is null
       or r ->> 'negative_signal_count' is null
  ) then
    raise exception 'replace_user_taste_affinity_snapshot: every row must be an object with taste_entity_id, long_term_score, recent_score, positive_signal_count, negative_signal_count';
  end if;

  select coalesce(array_agg((r ->> 'taste_entity_id')::uuid), '{}'::uuid[])
    into v_ids
    from jsonb_array_elements(p_rows) as r;

  -- Upsert the new snapshot rows. Malformed values (bad uuid/number casts,
  -- negative counts via CHECK constraints, unknown taste_entity_id via the
  -- FK, or a duplicate taste_entity_id within p_rows) raise here and roll
  -- back the entire replacement, including the delete below.
  insert into public.user_taste_affinities (
    user_id,
    taste_entity_id,
    long_term_score,
    recent_score,
    positive_signal_count,
    negative_signal_count,
    last_interaction_at
  )
  select
    p_user_id,
    (r ->> 'taste_entity_id')::uuid,
    (r ->> 'long_term_score')::double precision,
    (r ->> 'recent_score')::double precision,
    (r ->> 'positive_signal_count')::integer,
    (r ->> 'negative_signal_count')::integer,
    (r ->> 'last_interaction_at')::timestamptz
  from jsonb_array_elements(p_rows) as r
  on conflict (user_id, taste_entity_id) do update set
    long_term_score = excluded.long_term_score,
    recent_score = excluded.recent_score,
    positive_signal_count = excluded.positive_signal_count,
    negative_signal_count = excluded.negative_signal_count,
    last_interaction_at = excluded.last_interaction_at;
  get diagnostics v_upserted = row_count;

  -- Delete stale rows for THIS user only. An empty p_rows array empties the
  -- user's snapshot entirely. Other users' rows are structurally out of
  -- scope because the predicate is user_id = p_user_id.
  delete from public.user_taste_affinities as a
  where a.user_id = p_user_id
    and not (a.taste_entity_id = any (v_ids));
  get diagnostics v_deleted = row_count;

  return jsonb_build_object('upserted', v_upserted, 'deleted', v_deleted);
end;
$$;

-- Lock down execution: strip the default PUBLIC grant and grant only the
-- service role.
revoke execute on function public.replace_user_taste_affinity_snapshot(uuid, jsonb) from public;
revoke execute on function public.replace_user_taste_affinity_snapshot(uuid, jsonb) from anon;
revoke execute on function public.replace_user_taste_affinity_snapshot(uuid, jsonb) from authenticated;
grant execute on function public.replace_user_taste_affinity_snapshot(uuid, jsonb) to service_role;
