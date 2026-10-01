-- Taste Onboarding (PR #35): explicit first-user taste seeding.
--
-- Three pieces:
--   1. public.user_profiles.taste_onboarding_version — the durable,
--      rollout-safe ELIGIBILITY marker. NULL means "grandfathered": every
--      account that already exists when this migration is applied keeps NULL
--      (the migration itself never updates any profile) and is never routed
--      through onboarding. Eligibility is enrolled by the auth.users INSERT
--      trigger below, which fires ONLY for accounts created after the
--      migration is installed — never retroactively. The client never
--      decides eligibility from profile existence/creation.
--   2. public.user_taste_onboarding — one row per user holding the
--      authoritative onboarding state (status + final explicit selections),
--      so navigation never has to infer completion by scanning user_events.
--   3. public.complete_taste_onboarding(...) — the narrow, atomic,
--      SECURITY INVOKER RPC that validates the final selection, persists the
--      state row, and emits/dedupes the explicit onboarding user_events the
--      Taste Graph replays. This RPC is the ONLY writer of onboarding event
--      types; clients never insert them directly (see lib/analytics.ts).
--
-- Event-sourcing invariant: onboarding taste events are emitted ONLY by the
-- RPC, exactly when a row transitions to/through 'completed', and the row's
-- committed selections are updated in the SAME transaction. Therefore
-- "the events emitted so far" always equal "the last completed row's
-- selections", and the RPC can compute a correct delta from its own prior
-- committed row without reading user_events (which is insert-only under
-- RLS and therefore unreadable by an invoker-security function).

-- ---------------------------------------------------------------------------
-- 1. Eligibility marker on profiles (rollout-safe, default NULL) plus the
--    durable enrollment mechanism on the auth lifecycle.
--
-- INVARIANT: a historical auth.users account — with or without a profile
-- row, however delayed/failed profile creation may be — is NEVER enrolled.
-- Only accounts inserted into auth.users AFTER this trigger exists receive
-- the version marker. Applying this migration does not fire the trigger for
-- any existing auth.users row.
-- ---------------------------------------------------------------------------
alter table public.user_profiles
  add column if not exists taste_onboarding_version integer;

alter table public.user_profiles
  drop constraint if exists user_profiles_taste_onboarding_version_check;
alter table public.user_profiles
  add constraint user_profiles_taste_onboarding_version_check
  check (taste_onboarding_version is null or taste_onboarding_version >= 1);

-- Enrollment trigger: AFTER INSERT on auth.users marks ONLY newly created
-- accounts with the current onboarding version (1, mirroring
-- ONBOARDING_VERSION in lib/tasteOnboarding.ts). Eligibility therefore comes
-- from the durable account-creation event recorded in Postgres, not from
-- whether a profile row happens to exist right now.
--
-- Security model:
--   - SECURITY DEFINER is required for exactly two narrow reasons: the
--     trigger fires on auth.users (the caller inserting the auth user does
--     not own triggers on the auth schema), and it upserts
--     public.user_profiles (whose RLS insert policy requires
--     auth.uid() = user_id, which is NULL during the auth.users INSERT).
--   - The function does exactly one thing: set the marker on the NEW user's
--     profile row, creating a minimal placeholder row if none exists. It
--     never touches any other user's rows, any other column, events, or
--     derived taste state, and it cannot fail signup (any error is logged
--     and swallowed). A placeholder display_name is filled in by the
--     client's normal ensure-profile path (AuthContext), whose insert
--     conflicts are already ignored (23505) — unchanged behavior.
--   - search_path is emptied and every object is schema-qualified.
--   - EXECUTE is revoked from PUBLIC/anon/authenticated: only the trigger
--     invokes it; clients can never call it to enroll themselves.
--   - The auth.users trigger is dropped before creation so re-running the
--     migration never double-enrolls; nothing ever updates existing rows.
create or replace function public.enroll_taste_onboarding_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_profiles (user_id, display_name, taste_onboarding_version)
  values (new.id, 'Seller', 1)
  on conflict (user_id) do update
    set taste_onboarding_version = coalesce(
          public.user_profiles.taste_onboarding_version,
          excluded.taste_onboarding_version
        );
  return new;
exception
  when others then
    -- Enrollment must never break signup.
    raise warning 'enroll_taste_onboarding_version failed for user %: %', new.id, sqlerrm;
    return new;
end;
$$;

revoke all on function public.enroll_taste_onboarding_version() from public;
revoke all on function public.enroll_taste_onboarding_version() from anon;
revoke all on function public.enroll_taste_onboarding_version() from authenticated;

drop trigger if exists trg_enroll_taste_onboarding_version on auth.users;
create trigger trg_enroll_taste_onboarding_version
  after insert on auth.users
  for each row execute function public.enroll_taste_onboarding_version();

-- ---------------------------------------------------------------------------
-- 2. Authoritative onboarding state.
-- ---------------------------------------------------------------------------
create table if not exists public.user_taste_onboarding (
  user_id uuid primary key references auth.users (id) on delete cascade,
  version integer not null check (version >= 1),
  status text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  -- Curated discovery category ids (see lib/discoveryTaxonomy.ts), stored as
  -- a jsonb array of lowercase strings.
  selected_categories jsonb not null default '[]'::jsonb,
  -- Real public.products UUIDs, stored as a jsonb array of uuid strings.
  selected_product_ids jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint user_taste_onboarding_categories_array check (jsonb_typeof(selected_categories) = 'array'),
  constraint user_taste_onboarding_products_array check (jsonb_typeof(selected_product_ids) = 'array'),
  constraint user_taste_onboarding_completed_consistency check (
    status <> 'completed' or completed_at is not null
  )
);

alter table public.user_taste_onboarding enable row level security;

-- Own-row only: a user can read, create, and update ONLY their own
-- onboarding state. No delete policy (state is never deleted client-side).
create policy "Users can read their own onboarding state"
  on public.user_taste_onboarding
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can create their own onboarding state"
  on public.user_taste_onboarding
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can update their own onboarding state"
  on public.user_taste_onboarding
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create or replace function public.set_user_taste_onboarding_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists trg_user_taste_onboarding_updated_at on public.user_taste_onboarding;
create trigger trg_user_taste_onboarding_updated_at
before update on public.user_taste_onboarding
for each row
execute function public.set_user_taste_onboarding_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Atomic, idempotent completion.
--
-- complete_taste_onboarding(p_user_id, p_categories, p_product_ids):
--   - validates the caller is p_user_id (auth.uid()),
--   - validates categories against the curated discovery allowlist
--     (mirrors CURATED_DISCOVERY_CATEGORY_SLUGS in lib/discoveryTaxonomy.ts
--     — keep the two in sync),
--   - validates product ids are UUIDs that exist in public.products,
--   - enforces the same minimums as the client (>= 3 categories,
--     >= 5 products; lib/tasteOnboarding.ts),
--   - computes the event delta against the caller's PREVIOUSLY COMMITTED
--     (completed) row: inserts onboarding_category_select /
--     onboarding_product_select for newly selected targets and
--     onboarding_category_deselect / onboarding_product_deselect for removed
--     ones, so a retry with the same final state inserts NOTHING twice and
--     can never multiply taste strength,
--   - inserts the lifecycle-only onboarding_complete event exactly once
--     (first completion only),
--   - upserts the authoritative state row as 'completed' in the same
--     transaction; any failure rolls back BOTH the events and the row, so
--     state and events can never disagree.
--
-- Security model:
--   - SECURITY INVOKER on purpose: writes run as the calling user and must
--     pass the existing RLS policies (user_events insert-own,
--     user_taste_onboarding own-row). There is no privilege escalation to
--     review beyond the explicit validations below.
--   - auth.uid() must equal p_user_id: one user can never complete, seed
--     events for, or modify another user's onboarding.
--   - search_path is emptied and every table is schema-qualified.
--   - EXECUTE is revoked from PUBLIC/anon and granted to authenticated only.
--   - The function never touches user_taste_affinities: derived taste state
--     stays owned by the service-side rebuild (PR #34).
-- ---------------------------------------------------------------------------
create or replace function public.complete_taste_onboarding(
  p_user_id uuid,
  p_categories jsonb,
  p_product_ids jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- Mirrors ONBOARDING_VERSION in lib/tasteOnboarding.ts.
  v_version constant integer := 1;
  v_categories text[];
  v_product_ids uuid[];
  v_had_completed boolean;
  v_prev_categories text[];
  v_prev_product_ids uuid[];
  v_category_selects integer := 0;
  v_category_deselects integer := 0;
  v_product_selects integer := 0;
  v_product_deselects integer := 0;
  v_rows integer;
begin
  -- Identity: the caller must be authenticated and may only complete their
  -- OWN onboarding.
  if auth.uid() is null then
    raise exception 'complete_taste_onboarding: not authenticated';
  end if;
  if p_user_id is null or p_user_id <> auth.uid() then
    raise exception 'complete_taste_onboarding: cannot complete another user''s onboarding';
  end if;

  -- Eligibility: ONLY accounts enrolled with an onboarding version (the
  -- auth.users enrollment trigger above) may complete onboarding. A
  -- grandfathered/ineligible user (marker NULL) calling this RPC directly is
  -- rejected, so onboarding taste can never be manufactured outside the
  -- eligible flow. A future "Tune Your Penchant" flow can enroll explicitly
  -- by setting this marker; nothing else may.
  if not exists (
    select 1 from public.user_profiles pr
    where pr.user_id = p_user_id
      and pr.taste_onboarding_version is not null
  ) then
    raise exception 'complete_taste_onboarding: account is not eligible for taste onboarding';
  end if;

  -- Shape validation.
  if p_categories is null or jsonb_typeof(p_categories) <> 'array' then
    raise exception 'complete_taste_onboarding: p_categories must be a jsonb array of curated category ids';
  end if;
  if p_product_ids is null or jsonb_typeof(p_product_ids) <> 'array' then
    raise exception 'complete_taste_onboarding: p_product_ids must be a jsonb array of product uuid strings';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_categories) as e
    where jsonb_typeof(e) <> 'string'
  ) then
    raise exception 'complete_taste_onboarding: every category must be a string';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_product_ids) as e
    where jsonb_typeof(e) <> 'string'
  ) then
    raise exception 'complete_taste_onboarding: every product id must be a string';
  end if;

  -- Normalized, de-duplicated curated category ids.
  select coalesce(array_agg(distinct c order by c), '{}'::text[])
    into v_categories
    from (select lower(trim(jsonb_array_elements_text(p_categories))) as c) as s;

  if exists (
    select 1 from unnest(v_categories) as c
    where c not in (
      'accessories', 'automotive', 'beauty', 'electronics', 'fashion',
      'fitness', 'home', 'outdoors', 'shoes', 'watches'
    )
  ) then
    raise exception 'complete_taste_onboarding: unknown curated category id';
  end if;
  if cardinality(v_categories) < 3 then
    raise exception 'complete_taste_onboarding: at least 3 categories are required';
  end if;

  -- Product ids must be UUID strings (rejects demo/local ids like "demo-1").
  if exists (
    select 1 from jsonb_array_elements_text(p_product_ids) as t(id)
    where t.id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'complete_taste_onboarding: product ids must be uuid strings';
  end if;

  select coalesce(array_agg(distinct t.id::uuid order by t.id::uuid), '{}'::uuid[])
    into v_product_ids
    from jsonb_array_elements_text(p_product_ids) as t(id);

  if cardinality(v_product_ids) < 5 then
    raise exception 'complete_taste_onboarding: at least 5 products are required';
  end if;

  -- Every selected product must be a REAL row in public.products.
  if exists (
    select 1 from unnest(v_product_ids) as u(id)
    where not exists (select 1 from public.products p where p.id = u.id)
  ) then
    raise exception 'complete_taste_onboarding: unknown product id';
  end if;

  -- Previously COMMITTED selections. Only a completed row has emitted taste
  -- events (in-progress saves write no events), so the delta base is the
  -- last completed row — this is what makes retries idempotent.
  v_had_completed := exists (
    select 1 from public.user_taste_onboarding t
    where t.user_id = p_user_id and t.status = 'completed'
  );

  select coalesce(array_agg(distinct c order by c), '{}'::text[])
    into v_prev_categories
    from public.user_taste_onboarding t
    cross join lateral jsonb_array_elements_text(t.selected_categories) as c
    where t.user_id = p_user_id and t.status = 'completed';

  select coalesce(array_agg(distinct p::uuid order by p::uuid), '{}'::uuid[])
    into v_prev_product_ids
    from public.user_taste_onboarding t
    cross join lateral jsonb_array_elements_text(t.selected_product_ids) as p
    where t.user_id = p_user_id and t.status = 'completed';

  -- Explicit select events for newly selected categories.
  insert into public.user_events (user_id, session_id, event_type, category, metadata)
  select p_user_id, 'onboarding', 'onboarding_category_select', c,
         jsonb_build_object('source', 'onboarding', 'version', v_version)
    from unnest(v_categories) as c
   where not (c = any (v_prev_categories));
  get diagnostics v_rows = row_count;
  v_category_selects := v_rows;

  -- Explicit reversal events for categories removed since the last
  -- committed completion (no-op on first completion: v_prev is empty).
  insert into public.user_events (user_id, session_id, event_type, category, metadata)
  select p_user_id, 'onboarding', 'onboarding_category_deselect', c,
         jsonb_build_object('source', 'onboarding', 'version', v_version)
    from unnest(v_prev_categories) as c
   where not (c = any (v_categories));
  get diagnostics v_rows = row_count;
  v_category_deselects := v_rows;

  -- Explicit select events for newly selected products.
  insert into public.user_events (user_id, session_id, event_type, product_id, metadata)
  select p_user_id, 'onboarding', 'onboarding_product_select', p,
         jsonb_build_object('source', 'onboarding', 'version', v_version)
    from unnest(v_product_ids) as p
   where not (p = any (v_prev_product_ids));
  get diagnostics v_rows = row_count;
  v_product_selects := v_rows;

  -- Explicit reversal events for products removed since the last commit.
  insert into public.user_events (user_id, session_id, event_type, product_id, metadata)
  select p_user_id, 'onboarding', 'onboarding_product_deselect', p,
         jsonb_build_object('source', 'onboarding', 'version', v_version)
    from unnest(v_prev_product_ids) as p
   where not (p = any (v_product_ids));
  get diagnostics v_rows = row_count;
  v_product_deselects := v_rows;

  -- Lifecycle/context event, exactly once per user (first completion only).
  if not v_had_completed then
    insert into public.user_events (user_id, session_id, event_type, metadata)
    values (
      p_user_id,
      'onboarding',
      'onboarding_complete',
      jsonb_build_object(
        'source', 'onboarding',
        'version', v_version,
        'category_count', cardinality(v_categories),
        'product_count', cardinality(v_product_ids)
      )
    );
  end if;

  -- Persist the authoritative completed state in the same transaction.
  insert into public.user_taste_onboarding (
    user_id, version, status, selected_categories, selected_product_ids,
    started_at, completed_at
  ) values (
    p_user_id, v_version, 'completed',
    to_jsonb(v_categories), to_jsonb(v_product_ids),
    timezone('utc', now()), timezone('utc', now())
  )
  on conflict (user_id) do update set
    version = excluded.version,
    status = 'completed',
    selected_categories = excluded.selected_categories,
    selected_product_ids = excluded.selected_product_ids,
    completed_at = excluded.completed_at;

  return jsonb_build_object(
    'status', 'completed',
    'version', v_version,
    'categories', to_jsonb(v_categories),
    'product_count', cardinality(v_product_ids),
    'category_selects_inserted', v_category_selects,
    'category_deselects_inserted', v_category_deselects,
    'product_selects_inserted', v_product_selects,
    'product_deselects_inserted', v_product_deselects,
    'complete_event_inserted', not v_had_completed
  );
end;
$$;

-- Lock down execution: strip the default PUBLIC grant; clients call this as
-- themselves (authenticated), never anonymously, never as another user.
revoke execute on function public.complete_taste_onboarding(uuid, jsonb, jsonb) from public;
revoke execute on function public.complete_taste_onboarding(uuid, jsonb, jsonb) from anon;
grant execute on function public.complete_taste_onboarding(uuid, jsonb, jsonb) to authenticated;
