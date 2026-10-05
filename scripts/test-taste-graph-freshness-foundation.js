#!/usr/bin/env node
// Static regression checks for the Taste Graph durable freshness migration.
// PostgreSQL locking/concurrency semantics require database integration tests;
// these assertions verify that the migration expresses the required contract.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const migration = fs.readFileSync(
  path.join(
    root,
    "supabase/migrations/20261005_add_taste_graph_freshness_foundation.sql"
  ),
  "utf8"
);
const productsContext = fs.readFileSync(
  path.join(root, "hooks/ProductsContext.tsx"),
  "utf8"
);

const expectedTasteEvents = [
  "product_open",
  "product_dwell",
  "product_like",
  "product_unlike",
  "product_save",
  "product_unsave",
  "shop_click",
  "seller_open",
  "seller_follow",
  "seller_unfollow",
  "search_result_open",
  "onboarding_category_select",
  "onboarding_category_deselect",
  "onboarding_product_select",
  "onboarding_product_deselect",
];

function section(start, end) {
  const from = migration.indexOf(start);
  assert.notStrictEqual(from, -1, `missing migration section: ${start}`);
  const to = end ? migration.indexOf(end, from) : migration.length;
  assert.notStrictEqual(to, -1, `missing migration boundary: ${end}`);
  return migration.slice(from, to);
}

function main() {
  const dirtyTrigger = section(
    "create or replace function public.mark_taste_graph_user_dirty()",
    "create trigger trg_user_events_mark_taste_graph_dirty"
  );
  const preferenceTrigger = section(
    "create or replace function public.record_taste_preference_transition()",
    "create trigger trg_product_likes_record_taste_event"
  );
  const claim = section(
    "create or replace function public.claim_taste_graph_rebuild_jobs(",
    "create or replace function public.renew_taste_graph_rebuild_lease("
  );
  const finalize = section(
    "create or replace function public.finalize_taste_graph_rebuild(",
    "create or replace function public.fail_taste_graph_rebuild("
  );
  const failure = section(
    "create or replace function public.fail_taste_graph_rebuild(",
    "create or replace function public.requeue_taste_graph_rebuild("
  );
  const eventPolicy = section(
    'drop policy "Users can record their own events"',
    "-- An allowlisted event increments"
  );

  assert.match(
    migration,
    /create table public\.taste_graph_rebuild_queue[\s\S]*?user_id uuid primary key references auth\.users \(id\) on delete cascade/
  );
  for (const column of [
    "requested_generation bigint",
    "processed_generation bigint",
    "dirty_since timestamptz",
    "debounce_until timestamptz",
    "available_at timestamptz",
    "lease_token uuid",
    "lease_until timestamptz",
    "attempt_count integer",
    "blocked_at timestamptz",
    "last_attempt_at timestamptz",
    "last_processed_at timestamptz",
    "last_duration_ms integer",
    "last_error text",
    "updated_at timestamptz",
  ]) {
    assert.ok(migration.includes(column), `queue is missing ${column}`);
  }
  assert.match(migration, /enable row level security/);
  assert.match(
    migration,
    /revoke all on table public\.taste_graph_rebuild_queue\s+from public, anon, authenticated, service_role/
  );
  assert.match(eventPolicy, /auth\.uid\(\) = user_id/);
  for (const transition of [
    "product_like",
    "product_unlike",
    "product_save",
    "product_unsave",
    "seller_follow",
    "seller_unfollow",
  ]) {
    assert.ok(
      eventPolicy.includes(`'${transition}'`),
      `clients must not directly create authoritative ${transition} events`
    );
  }
  assert.match(
    migration,
    /on public\.user_events \(user_id, created_at, id\)/
  );
  assert.match(dirtyTrigger, /security definer\s+set search_path = ''/);
  assert.match(dirtyTrigger, /v_now \+ interval '40 seconds'/);
  assert.match(dirtyTrigger, /q\.requested_generation \+ 1/);
  for (const eventType of expectedTasteEvents) {
    assert.ok(
      dirtyTrigger.includes(`'${eventType}'`),
      `dirty trigger is missing taste event ${eventType}`
    );
  }
  for (const excludedEvent of [
    "product_impression",
    "onboarding_complete",
    "search_query",
    "product_report",
    "sensitive_content_reveal",
    "catalog_match_attempt",
  ]) {
    assert.ok(
      !dirtyTrigger.includes(`'${excludedEvent}'`),
      `non-taste event unexpectedly dirties queue: ${excludedEvent}`
    );
  }

  for (const transition of [
    "product_like",
    "product_unlike",
    "product_save",
    "product_unsave",
    "seller_follow",
    "seller_unfollow",
  ]) {
    assert.ok(
      preferenceTrigger.includes(`'${transition}'`),
      `missing database-generated transition event ${transition}`
    );
  }
  assert.match(preferenceTrigger, /new\.product_id else old\.product_id/);
  assert.match(preferenceTrigger, /new\.following_id else old\.following_id/);
  assert.match(preferenceTrigger, /'preference_state'/);
  assert.match(preferenceTrigger, /metadata, created_at/);
  assert.match(preferenceTrigger, /v_transition_at/);

  assert.match(claim, /for update skip locked/i);
  assert.match(claim, /limit greatest/i);
  assert.match(claim, /q\.dirty_since \+ interval '90 seconds'/);
  assert.match(claim, /pg_catalog\.gen_random_uuid\(\)/);
  assert.match(claim, /interval '5 minutes'/);
  assert.match(claim, /attempt_count = q\.attempt_count \+ 1/);
  assert.match(claim, /q\.available_at <= v_now/);
  assert.match(claim, /q\.lease_until <= v_now/);

  assert.match(finalize, /for update/);
  assert.match(finalize, /v_queue\.lease_token is distinct from p_lease_token/);
  assert.match(finalize, /v_queue\.lease_until <= pg_catalog\.clock_timestamp\(\)/);
  assert.match(finalize, /v_queue\.requested_generation <> p_captured_generation/);
  assert.ok(
    finalize.indexOf("v_queue.requested_generation <> p_captured_generation") <
      finalize.indexOf("perform public.replace_user_taste_affinity_snapshot"),
    "generation mismatch must be checked before snapshot replacement"
  );
  assert.match(finalize, /perform public\.replace_user_taste_affinity_snapshot/);
  assert.match(finalize, /processed_generation = p_captured_generation/);
  assert.match(finalize, /return 'stale_generation'/);
  assert.match(finalize, /attempt_count = greatest\(attempt_count - 1, 0\)/);

  assert.match(failure, /attempt_count >= 8/);
  assert.match(failure, /attempt_count = greatest\(attempt_count - 1, 0\)/);
  assert.match(failure, /30 \* \(1 << least/);
  assert.match(failure, /last_error = pg_catalog\.left/);
  assert.match(failure, /return 'retry_scheduled'/);
  assert.match(
    section(
      "create or replace function public.requeue_taste_graph_rebuild(",
      "revoke all on function public.claim_taste_graph_rebuild_jobs"
    ),
    /requested_generation > processed_generation/
  );

  for (const rpc of [
    "claim_taste_graph_rebuild_jobs",
    "renew_taste_graph_rebuild_lease",
    "finalize_taste_graph_rebuild",
    "fail_taste_graph_rebuild",
    "requeue_taste_graph_rebuild",
  ]) {
    assert.match(
      migration,
      new RegExp(
        `revoke all on function public\\.${rpc}\\([\\s\\S]*?from public, anon, authenticated`
      )
    );
    assert.match(
      migration,
      new RegExp(`grant execute on function public\\.${rpc}\\([\\s\\S]*?to service_role`)
    );
  }
  assert.ok(
    !productsContext.includes("trackEvent("),
    "ProductsContext must not retain duplicate toggle preference events"
  );
  assert.ok(
    !productsContext.includes("../lib/analytics"),
    "ProductsContext must not import analytics solely for state transitions"
  );

  console.log("Taste Graph freshness foundation static contracts passed.");
  console.log(
    "PostgreSQL row-lock/concurrency behavior still requires integration testing."
  );
}

main();
