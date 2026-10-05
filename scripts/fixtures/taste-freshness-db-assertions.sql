insert into auth.users values
  ('00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002');
insert into public.products(id, title, user_id)
select ('10000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
       'Product ' || i, '00000000-0000-0000-0000-000000000002'::uuid
from generate_series(1, 6) i;

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
do $$
declare
  v_type text;
begin
  foreach v_type in array array[
    'onboarding_category_select', 'onboarding_category_deselect',
    'onboarding_product_select', 'onboarding_product_deselect',
    'onboarding_complete', 'product_like', 'product_unlike',
    'product_save', 'product_unsave', 'seller_follow', 'seller_unfollow'
  ] loop
    begin
      insert into public.user_events(user_id, event_type, category, metadata)
      values (auth.uid(), v_type, 'fashion', '{"source":"onboarding","version":1}');
      raise exception 'direct event insert unexpectedly allowed: %', v_type;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    insert into public.user_taste_onboarding(user_id, version, status, completed_at)
    values(auth.uid(), 1, 'completed', now());
    raise exception 'client manufactured a completed delta base';
  exception when insufficient_privilege then null;
  end;
  begin
    perform taste_graph_private.complete_taste_onboarding(auth.uid(), '[]', '[]');
    raise exception 'private implementation exposed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.claim_taste_graph_rebuild_jobs(5);
    raise exception 'client claimed work';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.complete_taste_onboarding(
      '00000000-0000-0000-0000-000000000002', '[]', '[]');
    raise exception 'cross-user completion allowed';
  exception when raise_exception then
    if sqlerrm not like '%own-user completion required%' then raise; end if;
  end;
end;
$$;

insert into public.user_taste_onboarding(user_id, version, selected_categories)
values(auth.uid(), 1, '["fashion"]')
on conflict(user_id) do update set selected_categories = excluded.selected_categories;
select public.complete_taste_onboarding(auth.uid(), '["fashion","home","shoes"]',
  '["10000000-0000-0000-0000-000000000001","10000000-0000-0000-0000-000000000002","10000000-0000-0000-0000-000000000003","10000000-0000-0000-0000-000000000004","10000000-0000-0000-0000-000000000005"]');
-- Idempotent retry.
select public.complete_taste_onboarding(auth.uid(), '["fashion","home","shoes"]',
  '["10000000-0000-0000-0000-000000000001","10000000-0000-0000-0000-000000000002","10000000-0000-0000-0000-000000000003","10000000-0000-0000-0000-000000000004","10000000-0000-0000-0000-000000000005"]');
do $$
begin
  if not exists(select 1 from public.user_taste_onboarding where user_id = auth.uid() and status = 'completed') then
    raise exception 'legitimate completion failed';
  end if;
  begin
    insert into public.user_taste_onboarding(user_id, version, status)
    values(auth.uid(), 1, 'in_progress')
    on conflict(user_id) do update set status = 'in_progress';
    raise exception 'completed state demoted through progress upsert';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

do $$
begin
  if (select count(*) from public.user_events) <> 9 then raise exception 'completion/retry event count wrong'; end if;
  if (select requested_generation from public.taste_graph_rebuild_queue) <> 8 then raise exception 'completion did not dirty eight taste events'; end if;
end;
$$;

-- Invalid inputs must leave events and the prior completed state unchanged.
set role authenticated;
do $$
begin
  begin
    perform public.complete_taste_onboarding(auth.uid(), '["fake","home","shoes"]', '[]');
    raise exception 'invalid categories accepted';
  exception when raise_exception then
    if sqlerrm not like '%unknown curated category%' then raise; end if;
  end;
  begin
    perform public.complete_taste_onboarding(auth.uid(), '["fashion","home","shoes"]',
      '["10000000-0000-0000-0000-000000000001","10000000-0000-0000-0000-000000000002","10000000-0000-0000-0000-000000000003","10000000-0000-0000-0000-000000000004","10000000-0000-0000-0000-000000000099"]');
    raise exception 'unknown product accepted';
  exception when raise_exception then
    if sqlerrm not like '%unknown product id%' then raise; end if;
  end;
end;
$$;
-- Changed completion emits two reversals and two selects.
select public.complete_taste_onboarding(auth.uid(), '["watches","home","shoes"]',
  '["10000000-0000-0000-0000-000000000006","10000000-0000-0000-0000-000000000002","10000000-0000-0000-0000-000000000003","10000000-0000-0000-0000-000000000004","10000000-0000-0000-0000-000000000005"]');
insert into public.user_events(user_id, event_type) values(auth.uid(), 'product_impression');
reset role;
do $$
begin
  if (select count(*) from public.user_events) <> 14 then raise exception 'changed completion/behavioral insert wrong'; end if;
  if (select requested_generation from public.taste_graph_rebuild_queue) <> 12 then raise exception 'changed completion generation wrong'; end if;
end;
$$;

-- Test-only clock setup as database owner, never worker code.
update public.taste_graph_rebuild_queue
set dirty_since = now() - interval '2 minutes', debounce_until = now() - interval '1 minute';
insert into public.taste_entities(id, entity_type, entity_key)
values ('20000000-0000-0000-0000-000000000001', 'brand', 'old');
insert into public.user_taste_affinities(user_id, taste_entity_id, long_term_score)
values ('00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 9);

set role service_role;
do $$
declare
  j record;
begin
  begin
    update public.taste_graph_rebuild_queue set processed_generation = requested_generation;
    raise exception 'service role directly mutated queue';
  exception when insufficient_privilege then null;
  end;
  select * into strict j from public.claim_taste_graph_rebuild_jobs(5);
  perform public.renew_taste_graph_rebuild_lease(j.user_id, j.captured_generation, j.lease_token);
  if public.finalize_taste_graph_rebuild(j.user_id, j.captured_generation, j.lease_token, '[]', 1) <> 'published' then
    raise exception 'empty snapshot not published';
  end if;
end;
$$;
reset role;
do $$
begin
  if exists(select 1 from public.user_taste_affinities) then raise exception 'empty snapshot did not replace'; end if;
  if exists(select 1 from public.taste_graph_rebuild_queue where processed_generation <> requested_generation or lease_token is not null) then
    raise exception 'generation not acknowledged atomically';
  end if;
end;
$$;

insert into public.user_events(user_id, event_type, seller_id)
values ('00000000-0000-0000-0000-000000000001', 'seller_open', '00000000-0000-0000-0000-000000000002');
update public.taste_graph_rebuild_queue
set dirty_since = now() - interval '2 minutes', debounce_until = now() - interval '1 minute';
-- Owner simulates a concurrent event AFTER claim; use the actual dirty trigger.
do $$
declare j record;
begin
  select * into strict j from public.claim_taste_graph_rebuild_jobs(1);
  insert into public.user_events(user_id, event_type, seller_id)
  values(j.user_id, 'seller_open', '00000000-0000-0000-0000-000000000002');
  if public.finalize_taste_graph_rebuild(j.user_id, j.captured_generation, j.lease_token, '[]', 1) <> 'stale_generation' then
    raise exception 'stale work published';
  end if;
  if (select processed_generation from public.taste_graph_rebuild_queue where user_id = j.user_id) <> 12 then
    raise exception 'stale work advanced processed generation';
  end if;
end;
$$;
update public.taste_graph_rebuild_queue
set dirty_since = now() - interval '2 minutes', debounce_until = now() - interval '1 minute';
set role service_role;
do $$
declare j record;
begin
  select * into strict j from public.claim_taste_graph_rebuild_jobs(1);
  if public.fail_taste_graph_rebuild(j.user_id, j.captured_generation, j.lease_token, 'rebuild failed') <> 'retry_scheduled' then
    raise exception 'failure not retried';
  end if;
  if exists(select 1 from public.claim_taste_graph_rebuild_jobs(5)) then
    raise exception 'backoff was ignored';
  end if;
end;
$$;
reset role;

-- Publication failures roll back BOTH the snapshot and acknowledgement.
update public.taste_graph_rebuild_queue
set available_at = now(), dirty_since = now() - interval '2 minutes',
    debounce_until = now() - interval '1 minute';
insert into public.user_taste_affinities(user_id, taste_entity_id, long_term_score)
values ('00000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 9);
do $$
declare j record;
begin
  select * into strict j from public.claim_taste_graph_rebuild_jobs(1);
  begin
    perform public.finalize_taste_graph_rebuild(j.user_id, j.captured_generation, j.lease_token,
      '[{"taste_entity_id":"20000000-0000-0000-0000-000000000001","long_term_score":2,"recent_score":2,"positive_signal_count":-1,"negative_signal_count":0}]', 1);
    raise exception 'invalid snapshot unexpectedly published';
  exception when check_violation then null;
  end;
  if (select long_term_score from public.user_taste_affinities where user_id = j.user_id) <> 9 then
    raise exception 'failed publication damaged prior snapshot';
  end if;
  if (select processed_generation from public.taste_graph_rebuild_queue where user_id = j.user_id) <> 12 then
    raise exception 'failed publication acknowledged generation';
  end if;
  begin
    perform public.finalize_taste_graph_rebuild(j.user_id, j.captured_generation,
      '99999999-0000-0000-0000-000000000000', '[]', 1);
    raise exception 'replaced token published';
  exception when raise_exception then
    if sqlerrm not like '%lease is absent, expired, or replaced%' then raise; end if;
  end;
  if public.finalize_taste_graph_rebuild(j.user_id, j.captured_generation, j.lease_token,
    '[{"taste_entity_id":"20000000-0000-0000-0000-000000000001","long_term_score":2,"recent_score":2,"positive_signal_count":1,"negative_signal_count":0}]', 1) <> 'published' then
    raise exception 'nonempty publication failed';
  end if;
  if (select long_term_score from public.user_taste_affinities where user_id = j.user_id) <> 2 then
    raise exception 'nonempty snapshot incorrect';
  end if;
end;
$$;

insert into public.user_events(user_id, event_type, seller_id)
values ('00000000-0000-0000-0000-000000000001', 'seller_open', '00000000-0000-0000-0000-000000000002');
update public.taste_graph_rebuild_queue
set dirty_since = now() - interval '2 minutes', debounce_until = now() - interval '1 minute',
    attempt_count = 7;
set role service_role;
do $$
declare j record;
begin
  select * into strict j from public.claim_taste_graph_rebuild_jobs(1);
  if public.fail_taste_graph_rebuild(j.user_id, j.captured_generation, j.lease_token, 'eighth failure') <> 'blocked' then
    raise exception 'eighth failure not blocked';
  end if;
  if exists(select 1 from public.claim_taste_graph_rebuild_jobs(1)) then raise exception 'blocked work claimed'; end if;
  if not public.requeue_taste_graph_rebuild(j.user_id) then raise exception 'operator requeue failed'; end if;
end;
$$;
reset role;

-- SQL-level batch clamp, beyond the runtime's stricter input rejection.
do $$
declare j record;
begin
  select * into strict j from public.claim_taste_graph_rebuild_jobs(1);
  update public.taste_graph_rebuild_queue set lease_until = now() - interval '1 second'
  where user_id = j.user_id;
  begin
    perform public.finalize_taste_graph_rebuild(j.user_id, j.captured_generation, j.lease_token, '[]', 1);
    raise exception 'expired lease published';
  exception when raise_exception then
    if sqlerrm not like '%lease is absent, expired, or replaced%' then raise; end if;
  end;
  begin
    perform public.renew_taste_graph_rebuild_lease(j.user_id, j.captured_generation, j.lease_token);
    raise exception 'expired lease renewed';
  exception when raise_exception then
    if sqlerrm not like '%lease is absent, expired, replaced, or stale%' then raise; end if;
  end;
end;
$$;

insert into auth.users
select ('30000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid
from generate_series(1, 6) i;
insert into public.user_events(user_id, event_type, seller_id)
select id, 'seller_open', '00000000-0000-0000-0000-000000000002'::uuid
from auth.users where id::text like '30000000%';
update public.taste_graph_rebuild_queue
set dirty_since = now() - interval '2 minutes', debounce_until = now() - interval '1 minute';
set role service_role;
do $$
begin
  if (select count(*) from public.claim_taste_graph_rebuild_jobs(100)) <> 5 then
    raise exception 'database claim exceeded or failed batch cap';
  end if;
end;
$$;
reset role;
