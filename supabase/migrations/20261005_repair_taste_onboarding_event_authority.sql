-- PR #37B. Additive repair; the deployed PR #37A migration is immutable.
-- Preserve the validated completion implementation, but make its writes
-- accessible only through a narrow owner-executed wrapper.
begin;

create schema if not exists taste_graph_private;
revoke all on schema taste_graph_private from public, anon, authenticated, service_role;

alter function public.complete_taste_onboarding(uuid, jsonb, jsonb)
  set schema taste_graph_private;
revoke all on function taste_graph_private.complete_taste_onboarding(uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;

create function public.complete_taste_onboarding(
  p_user_id uuid,
  p_categories jsonb,
  p_product_ids jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or p_user_id is null or auth.uid() <> p_user_id then
    raise exception 'complete_taste_onboarding: authenticated own-user completion required';
  end if;
  -- Serialize retries/changed completions, including when no state row exists.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));
  -- The original invoker function now runs as this wrapper's owner. All
  -- identity, eligibility, category, product, minimum and delta checks remain.
  return taste_graph_private.complete_taste_onboarding(p_user_id, p_categories, p_product_ids);
end;
$$;

revoke all on function public.complete_taste_onboarding(uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_taste_onboarding(uuid, jsonb, jsonb)
  to authenticated;

drop policy "Users can record their own non-state events" on public.user_events;
create policy "Users can record their own non-state events"
  on public.user_events for insert to authenticated
  with check (
    auth.uid() = user_id
    and event_type not in (
      'product_like', 'product_unlike', 'product_save', 'product_unsave',
      'seller_follow', 'seller_unfollow',
      'onboarding_category_select', 'onboarding_category_deselect',
      'onboarding_product_select', 'onboarding_product_deselect',
      'onboarding_complete'
    )
  );

-- The RPC delta base must not be forgeable or demoted by clients. Existing
-- own-user in-progress upserts still work and emit no authoritative events.
drop policy "Users can create their own onboarding state" on public.user_taste_onboarding;
drop policy "Users can update their own onboarding state" on public.user_taste_onboarding;
create policy "Users can create their own onboarding progress"
  on public.user_taste_onboarding for insert to authenticated
  with check (auth.uid() = user_id and status = 'in_progress' and completed_at is null);
create policy "Users can update their own onboarding progress"
  on public.user_taste_onboarding for update to authenticated
  using (auth.uid() = user_id and status = 'in_progress')
  with check (auth.uid() = user_id and status = 'in_progress' and completed_at is null);

commit;
