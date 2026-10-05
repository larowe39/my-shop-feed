-- Durable Taste Graph freshness work state (PR #37A).
--
-- user_events remains the source of truth. This queue records only which
-- users need a full replay; it does not contain affinity data.
-- Scheduling and the worker are intentionally not enabled by this migration.

create table public.taste_graph_rebuild_queue (
  user_id uuid primary key references auth.users (id) on delete cascade,
  requested_generation bigint not null default 0,
  processed_generation bigint not null default 0,
  dirty_since timestamptz,
  debounce_until timestamptz,
  available_at timestamptz not null default pg_catalog.clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  attempt_count integer not null default 0,
  blocked_at timestamptz,
  last_attempt_at timestamptz,
  last_processed_at timestamptz,
  last_duration_ms integer,
  last_error text,
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint taste_graph_rebuild_queue_generation_check
    check (
      requested_generation >= processed_generation
      and processed_generation >= 0
    ),
  constraint taste_graph_rebuild_queue_attempt_count_check
    check (attempt_count >= 0),
  constraint taste_graph_rebuild_queue_duration_check
    check (last_duration_ms is null or last_duration_ms >= 0),
  constraint taste_graph_rebuild_queue_lease_pair_check
    check ((lease_token is null) = (lease_until is null)),
  constraint taste_graph_rebuild_queue_dirty_state_check
    check (
      (
        requested_generation > processed_generation
        and dirty_since is not null
        and debounce_until is not null
      )
      or (
        requested_generation = processed_generation
        and dirty_since is null
        and debounce_until is null
        and lease_token is null
        and lease_until is null
        and blocked_at is null
      )
    )
);

create index taste_graph_rebuild_queue_available_idx
  on public.taste_graph_rebuild_queue (available_at, user_id)
  where requested_generation > processed_generation
    and blocked_at is null;

create index taste_graph_rebuild_queue_lease_idx
  on public.taste_graph_rebuild_queue (lease_until, user_id)
  where requested_generation > processed_generation
    and lease_token is not null
    and blocked_at is null;

create index if not exists user_events_user_created_id_idx
  on public.user_events (user_id, created_at, id);

alter table public.taste_graph_rebuild_queue enable row level security;
revoke all on table public.taste_graph_rebuild_queue
  from public, anon, authenticated, service_role;

-- Explicit preference events are now emitted by privileged transition
-- triggers, not by clients; ordinary own-user behavioral inserts remain
-- available under the existing authenticated policy.
drop policy "Users can record their own events" on public.user_events;
create policy "Users can record their own non-state events"
  on public.user_events
  for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and event_type not in (
      'product_like',
      'product_unlike',
      'product_save',
      'product_unsave',
      'seller_follow',
      'seller_unfollow'
    )
  );

-- An allowlisted event increments a monotonic per-user generation in the
-- same transaction as its user_events insert. New events extend quiet
-- debounce but preserve dirty_since, enforcing a 90-second starvation cap.
create or replace function public.mark_taste_graph_user_dirty()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if new.user_id is null or new.event_type not in (
    'product_open',
    'product_dwell',
    'product_like',
    'product_unlike',
    'product_save',
    'product_unsave',
    'shop_click',
    'seller_open',
    'seller_follow',
    'seller_unfollow',
    'search_result_open',
    'onboarding_category_select',
    'onboarding_category_deselect',
    'onboarding_product_select',
    'onboarding_product_deselect'
  ) then
    return new;
  end if;

  insert into public.taste_graph_rebuild_queue as q (
    user_id,
    requested_generation,
    processed_generation,
    dirty_since,
    debounce_until,
    available_at,
    attempt_count,
    updated_at
  ) values (
    new.user_id,
    1,
    0,
    v_now,
    v_now + interval '40 seconds',
    v_now,
    0,
    v_now
  )
  on conflict (user_id) do update set
    requested_generation = q.requested_generation + 1,
    dirty_since = case
      when q.requested_generation = q.processed_generation then v_now
      else q.dirty_since
    end,
    debounce_until = v_now + interval '40 seconds',
    available_at = case
      when q.requested_generation = q.processed_generation then v_now
      else q.available_at
    end,
    attempt_count = case
      when q.requested_generation = q.processed_generation then 0
      else q.attempt_count
    end,
    blocked_at = case
      when q.requested_generation = q.processed_generation then null
      else q.blocked_at
    end,
    last_error = case
      when q.requested_generation = q.processed_generation then null
      else q.last_error
    end,
    updated_at = v_now;

  return new;
end;
$$;

revoke all on function public.mark_taste_graph_user_dirty()
  from public, anon, authenticated, service_role;

create trigger trg_user_events_mark_taste_graph_dirty
after insert on public.user_events
for each row
execute function public.mark_taste_graph_user_dirty();

-- Preference state is authoritative. Emit the matching event from the state
-- transition itself so state, event, and queue generation commit together.
-- Product events carry only the authoritative product ID; the rebuild
-- resolves seller/category/brand/canonical context from public.products.
create or replace function public.record_taste_preference_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_product_id uuid;
  v_seller_id uuid;
  v_event_type text;
  v_transition_at timestamptz := pg_catalog.clock_timestamp();
begin
  if tg_table_name = 'product_likes' then
    v_user_id := case when tg_op = 'INSERT' then new.user_id else old.user_id end;
    v_product_id := case when tg_op = 'INSERT' then new.product_id else old.product_id end;
    v_event_type := case when tg_op = 'INSERT' then 'product_like' else 'product_unlike' end;

    -- Avoid generating an invalid event during product/account FK cascades.
    if not exists (
      select 1 from public.products p where p.id = v_product_id
    ) or not exists (
      select 1 from auth.users u where u.id = v_user_id
    ) then
      if tg_op = 'INSERT' then
        return new;
      end if;
      return old;
    end if;

    insert into public.user_events (
      user_id, session_id, event_type, product_id, metadata, created_at
    ) values (
      v_user_id, 'preference_state', v_event_type, v_product_id,
      pg_catalog.jsonb_build_object('source', 'preference_state'),
      v_transition_at
    );
  elsif tg_table_name = 'product_saves' then
    v_user_id := case when tg_op = 'INSERT' then new.user_id else old.user_id end;
    v_product_id := case when tg_op = 'INSERT' then new.product_id else old.product_id end;
    v_event_type := case when tg_op = 'INSERT' then 'product_save' else 'product_unsave' end;

    if not exists (
      select 1 from public.products p where p.id = v_product_id
    ) or not exists (
      select 1 from auth.users u where u.id = v_user_id
    ) then
      if tg_op = 'INSERT' then
        return new;
      end if;
      return old;
    end if;

    insert into public.user_events (
      user_id, session_id, event_type, product_id, metadata, created_at
    ) values (
      v_user_id, 'preference_state', v_event_type, v_product_id,
      pg_catalog.jsonb_build_object('source', 'preference_state'),
      v_transition_at
    );
  elsif tg_table_name = 'user_follows' then
    v_user_id := case when tg_op = 'INSERT' then new.follower_id else old.follower_id end;
    v_seller_id := case when tg_op = 'INSERT' then new.following_id else old.following_id end;
    v_event_type := case when tg_op = 'INSERT' then 'seller_follow' else 'seller_unfollow' end;

    if not exists (
      select 1 from auth.users u where u.id = v_user_id
    ) or not exists (
      select 1 from auth.users u where u.id = v_seller_id
    ) then
      if tg_op = 'INSERT' then
        return new;
      end if;
      return old;
    end if;

    insert into public.user_events (
      user_id, session_id, event_type, seller_id, metadata, created_at
    ) values (
      v_user_id, 'preference_state', v_event_type, v_seller_id,
      pg_catalog.jsonb_build_object('source', 'preference_state'),
      v_transition_at
    );
  else
    raise exception 'record_taste_preference_transition called for unsupported table';
  end if;

  if tg_op = 'INSERT' then
    return new;
  end if;
  return old;
end;
$$;

revoke all on function public.record_taste_preference_transition()
  from public, anon, authenticated, service_role;

create trigger trg_product_likes_record_taste_event
after insert or delete on public.product_likes
for each row
execute function public.record_taste_preference_transition();

create trigger trg_product_saves_record_taste_event
after insert or delete on public.product_saves
for each row
execute function public.record_taste_preference_transition();

create trigger trg_user_follows_record_taste_event
after insert or delete on public.user_follows
for each row
execute function public.record_taste_preference_transition();

-- Worker-only claim. The debounce deadline is capped at dirty_since + 90s.
-- Expired eighth attempts are blocked instead of being retried forever.
create or replace function public.claim_taste_graph_rebuild_jobs(
  p_batch_size integer default 5
)
returns table (
  user_id uuid,
  captured_generation bigint,
  lease_token uuid,
  lease_until timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  update public.taste_graph_rebuild_queue q
  set blocked_at = v_now,
      lease_token = null,
      lease_until = null,
      last_error = coalesce(
        q.last_error,
        'lease expired after maximum claim attempts'
      ),
      updated_at = v_now
  where q.requested_generation > q.processed_generation
    and q.blocked_at is null
    and q.lease_until <= v_now
    and q.attempt_count >= 8;

  return query
  with eligible as (
    select q.user_id
    from public.taste_graph_rebuild_queue q
    where q.requested_generation > q.processed_generation
      and q.blocked_at is null
      and q.available_at <= v_now
      and (
        q.lease_until is null
        or q.lease_until <= v_now
      )
      and least(
        q.debounce_until,
        q.dirty_since + interval '90 seconds'
      ) <= v_now
      and q.attempt_count < 8
    order by
      least(
        q.debounce_until,
        q.dirty_since + interval '90 seconds'
      ),
      q.user_id
    for update skip locked
    limit greatest(
      1,
      least(coalesce(p_batch_size, 5), 5)
    )
  )
  update public.taste_graph_rebuild_queue q
  set lease_token = pg_catalog.gen_random_uuid(),
      lease_until = v_now + interval '5 minutes',
      attempt_count = q.attempt_count + 1,
      last_attempt_at = v_now,
      updated_at = v_now
  from eligible e
  where q.user_id = e.user_id
  returning q.user_id, q.requested_generation, q.lease_token, q.lease_until;
end;
$$;

create or replace function public.renew_taste_graph_rebuild_lease(
  p_user_id uuid,
  p_captured_generation bigint,
  p_lease_token uuid
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lease_until timestamptz;
begin
  update public.taste_graph_rebuild_queue q
  set lease_until = pg_catalog.clock_timestamp() + interval '5 minutes',
      updated_at = pg_catalog.clock_timestamp()
  where q.user_id = p_user_id
    and q.requested_generation = p_captured_generation
    and q.processed_generation < p_captured_generation
    and q.lease_token = p_lease_token
    and q.lease_until > pg_catalog.clock_timestamp()
  returning q.lease_until into v_lease_until;

  if v_lease_until is null then
    raise exception 'taste graph lease is absent, expired, replaced, or stale';
  end if;

  return v_lease_until;
end;
$$;

-- Generation validation, existing atomic snapshot replacement, and queue
-- acknowledgement are one transaction. A newer event either gets the queue
-- lock first (making this finalization stale), or waits and dirties the row
-- immediately after this generation publishes.
create or replace function public.finalize_taste_graph_rebuild(
  p_user_id uuid,
  p_captured_generation bigint,
  p_lease_token uuid,
  p_rows jsonb,
  p_duration_ms integer
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_queue public.taste_graph_rebuild_queue%rowtype;
  v_now timestamptz;
begin
  if p_user_id is null
     or p_captured_generation is null
     or p_lease_token is null
     or p_duration_ms is null
     or p_duration_ms < 0 then
    raise exception 'finalize_taste_graph_rebuild received invalid arguments';
  end if;

  select q.*
    into v_queue
    from public.taste_graph_rebuild_queue q
   where q.user_id = p_user_id
   for update;

  if not found
     or v_queue.lease_token is distinct from p_lease_token
     or v_queue.lease_until is null
     or v_queue.lease_until <= pg_catalog.clock_timestamp() then
    raise exception 'taste graph lease is absent, expired, or replaced';
  end if;

  if v_queue.requested_generation <> p_captured_generation
     or v_queue.processed_generation >= p_captured_generation then
    update public.taste_graph_rebuild_queue
       set lease_token = null,
           lease_until = null,
           attempt_count = greatest(attempt_count - 1, 0),
           updated_at = pg_catalog.clock_timestamp()
     where user_id = p_user_id;
    return 'stale_generation';
  end if;

  perform public.replace_user_taste_affinity_snapshot(p_user_id, p_rows);

  v_now := pg_catalog.clock_timestamp();
  update public.taste_graph_rebuild_queue
     set processed_generation = p_captured_generation,
         dirty_since = null,
         debounce_until = null,
         available_at = v_now,
         lease_token = null,
         lease_until = null,
         attempt_count = 0,
         blocked_at = null,
         last_processed_at = v_now,
         last_duration_ms = p_duration_ms,
         last_error = null,
         updated_at = v_now
   where user_id = p_user_id;

  return 'published';
end;
$$;

create or replace function public.fail_taste_graph_rebuild(
  p_user_id uuid,
  p_captured_generation bigint,
  p_lease_token uuid,
  p_error text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_queue public.taste_graph_rebuild_queue%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select q.*
    into v_queue
    from public.taste_graph_rebuild_queue q
   where q.user_id = p_user_id
   for update;

  if not found
     or v_queue.lease_token is distinct from p_lease_token
     or v_queue.lease_until is null
     or v_queue.lease_until <= v_now then
    raise exception 'taste graph lease is absent, expired, or replaced';
  end if;

  if v_queue.requested_generation <> p_captured_generation
     or v_queue.processed_generation >= p_captured_generation then
    update public.taste_graph_rebuild_queue
       set lease_token = null,
           lease_until = null,
           attempt_count = greatest(attempt_count - 1, 0),
           updated_at = v_now
     where user_id = p_user_id;
    return 'stale_generation';
  end if;

  update public.taste_graph_rebuild_queue
     set lease_token = null,
         lease_until = null,
         blocked_at = case
           when attempt_count >= 8 then v_now
           else null
         end,
         available_at = case
           when attempt_count >= 8 then available_at
           else v_now + pg_catalog.make_interval(
             secs => least(
               1800,
               30 * (1 << least(attempt_count - 1, 6))
             )
           )
         end,
         last_error = pg_catalog.left(
           coalesce(
             nullif(pg_catalog.btrim(p_error), ''),
             'worker failure'
           ),
           1000
         ),
         updated_at = v_now
   where user_id = p_user_id;

  if v_queue.attempt_count >= 8 then
    return 'blocked';
  end if;
  return 'retry_scheduled';
end;
$$;

-- Explicit operator action; this never changes either generation.
create or replace function public.requeue_taste_graph_rebuild(
  p_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  update public.taste_graph_rebuild_queue
     set available_at = pg_catalog.clock_timestamp(),
         lease_token = null,
         lease_until = null,
         attempt_count = 0,
         blocked_at = null,
         last_error = null,
         updated_at = pg_catalog.clock_timestamp()
   where user_id = p_user_id
     and requested_generation > processed_generation;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

revoke all on function public.claim_taste_graph_rebuild_jobs(integer)
  from public, anon, authenticated;
revoke all on function public.renew_taste_graph_rebuild_lease(uuid, bigint, uuid)
  from public, anon, authenticated;
revoke all on function public.finalize_taste_graph_rebuild(uuid, bigint, uuid, jsonb, integer)
  from public, anon, authenticated;
revoke all on function public.fail_taste_graph_rebuild(uuid, bigint, uuid, text)
  from public, anon, authenticated;
revoke all on function public.requeue_taste_graph_rebuild(uuid)
  from public, anon, authenticated;

grant execute on function public.claim_taste_graph_rebuild_jobs(integer)
  to service_role;
grant execute on function public.renew_taste_graph_rebuild_lease(uuid, bigint, uuid)
  to service_role;
grant execute on function public.finalize_taste_graph_rebuild(uuid, bigint, uuid, jsonb, integer)
  to service_role;
grant execute on function public.fail_taste_graph_rebuild(uuid, bigint, uuid, text)
  to service_role;
grant execute on function public.requeue_taste_graph_rebuild(uuid)
  to service_role;
