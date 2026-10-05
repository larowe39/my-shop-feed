# Taste Graph Foundation (PR #34)

The Taste Graph turns PENCHANT's append-only behavioral history
(`public.user_events`) into deterministic, rebuildable user taste affinities.
This document describes the foundation, the deployed durable freshness queue
(PR #37A), and the worker runtime implementation (PR #37B).
Feed V2 and Taste Onboarding build on it. Production activation is NOT enabled.

```
user_events (append-only source of truth)
    ↓  taste-relevant event increments a per-user dirty generation
taste_graph_rebuild_queue (derived work state; production worker not active)
    ↓  claim ≤ 5 jobs, retaining generation + lease token + expiry
    ↓  full replay + product context resolution
    ↓  event → taste signal mapping        (lib/tasteSignals.ts)
taste_entities                             (public.taste_entities)
    ↓  deterministic replay engine         (lib/tasteGraph.ts)
    ↓  generation-checked finalize (atomic snapshot + acknowledgement)
user_taste_affinities                      (public.user_taste_affinities)
    ↓
future Feed V2 / Search / onboarding / PENCHANT AI
```

## Architecture

| Layer | File | Notes |
| --- | --- | --- |
| Signal model | `lib/tasteSignals.ts` | Versioned weights, thresholds, propagation multipliers, decay constants, entity-key normalization. Pure, dependency-free. |
| Engine | `lib/tasteGraph.ts` | Deterministic replay of one user's event history into a complete replacement snapshot. Pure, dependency-free; never calls `Date.now()` — the reference time is injected as `asOf`. |
| Rebuild orchestration | `lib/tasteGraphRebuild.ts` | Store-agnostic rebuild pipeline (fetch events → resolve product context → snapshot → persist). Duck-typed `TasteGraphStore` keeps it testable offline. |
| Rebuild CLI | `scripts/taste-graph-rebuild.js` | Service-role script. Dry-run by default; `--apply` writes. |
| Freshness queue migration (#37A) | `supabase/migrations/20261005_add_taste_graph_freshness_foundation.sql` | Already deployed, immutable. Transactional dirty generations, preference-state events, worker-only queue RPCs. |
| Worker orchestration (#37B) | `lib/tasteGraphWorker.ts` | Dependency-injected, bounded single batch; reuses the rebuild preparation/entity mapping helpers. |
| Worker runtime / adapter | `scripts/taste-graph-worker.js`, `scripts/lib/taste-worker-store.ts` | Server-only Node service-role invocation; paged events, chunked context/entities, request deadlines. No Edge Function or schedule. |
| Onboarding authority repair | `supabase/migrations/20261005_repair_taste_onboarding_event_authority.sql` | New, unapplied migration: blocks direct onboarding events; preserves validated completion through a privileged wrapper. |
| Inspect CLI | `scripts/taste-graph-inspect.js` | Read-only debug printing of a computed snapshot; supports `--user` and offline `--fixture` modes. |
| Migration | `supabase/migrations/20261001_add_taste_graph_foundation.sql` | New tables, RLS, and the atomic replacement RPC. Applied manually via the Supabase SQL editor like all migrations in this repo. |
| Tests | `scripts/test-taste-graph.js` | `npm run taste:test` — fully offline, deterministic. |

`lib/analytics.ts` remains the **only** client-side writer to
`public.user_events`. The Taste Graph adds no new client write paths:
affinity state is derived exclusively by the service-side rebuild.

## Freshness: deployed foundation, implemented runtime, activation pending

The raw `public.user_events` table remains the source of truth; the
`public.taste_graph_rebuild_queue` table is derived work state only. Its
monotonic `requested_generation` and `processed_generation` identify exactly
which event history a full replay must publish. A worker lease token
prevents an expired or replaced worker from publishing. Finalization must
validate the captured generation and replace the affinity snapshot in one
transaction; a replay for generation G is rejected if a newer event has
advanced the queue.

The new migration records only allowlisted taste events. Like/save/follow
state transitions create their corresponding `user_events` rows in the same
database transaction as the authoritative row change. Other behavioral
analytics remain best-effort. Clients may still insert their own behavioral
events, but cannot directly manufacture like/save/follow transition events.
The onboarding RPC's multi-event transaction advances one user's generation
multiple times while retaining one coalesced queue row. Debounce is 40 seconds
with a 90-second starvation cap.

#37A is merged and its queue migration is already deployed. The production
like/unlike canary advanced requested generations 1 then 2, with processed
generation 0 and no lease/block/retry state. **Do not reapply or edit that
migration.**

#37B implements a **one-shot Node worker**, not an Edge Function. No production
worker has been invoked, no production schedule exists, and `pg_cron` /
`pg_net` remain disabled. The runtime is ready for controlled validation, not
activated production automation.

### Worker flow and bounds

`event → dirty generation → claim → full replay → generation-checked finalize`

1. Exactly one `claim_taste_graph_rebuild_jobs(integer)` call, requesting 1–5
   jobs (default 5). Invalid sizes fail before any claim.
2. Jobs run concurrently within that bounded batch, each retaining its user,
   captured generation, lease token and expiry. One failure cannot abort others.
3. `prepareUserTasteSnapshot` and `persistTasteSnapshotEntities` in
   `lib/tasteGraphRebuild.ts` are shared with the existing manual rebuild.
   Full history, decay, toggles, missing-product fallback, product context
   semantics and fail-closed entity mapping are unchanged. No second algorithm.
4. Events are read ascending in `(created_at, id)` order, 500 rows per page,
   using keyset pagination, never offsets. Each full page retains its final
   row's exact database timestamp and ID; the next page filters
   `created_at > cursor.created_at OR
   (created_at = cursor.created_at AND id > cursor.id)`. Timestamp precision
   is preserved (no JavaScript Date rounding). Backdated non-taste inserts
   cannot shift page boundaries and duplicate taste contributions. A new
   taste-relevant event, even behind the cursor, advances requested generation;
   finalize rejects the older generation without publication or acknowledgement,
   leaving newer work dirty for a later full replay. Product
   context and entity upserts use chunks of 200 to avoid URL/response row limits.
   Supabase's configured API row limit must be **at least 500**.
5. One explicit `asOf` is injected per invocation. No partial-history snapshot:
   histories over 50,000 events or snapshots over 20,000 entities fail closed
   and go through the fail RPC. These conservative safety ceilings require
   future capacity review; raising them is not an operator CLI option.
6. Replay work has a 240-second invocation budget, checked between stages and
   every page/chunk. Each database request is abortable and limited to 15 seconds
   or the remaining budget, whichever is smaller. Failure reporting has a
   separate 10-second request budget. Synchronous deterministic replay cannot
   be interrupted mid-call; the event/entity ceilings bound its input, and a
   checkpoint afterwards prevents publishing after the budget.
7. Checkpoints renew a live lease through `renew_taste_graph_rebuild_lease`
   when at most 90 seconds remain. Renewal retains the captured generation
   and token; a stale, replaced or expired lease is not overwritten.
8. Affinities publish **only** through `finalize_taste_graph_rebuild` with
   complete rows (including `[]` to clear the snapshot), generation, token and
   duration. The worker never calls `replace_user_taste_affinity_snapshot`
   directly, never writes the queue table and never advances a generation itself.

### Supersession, retry and blocking

- `stale_generation` from finalize is normal superseded work, not failure.
  The RPC releases the lease without publishing/acknowledging and refunds that
  attempt. The newer generation remains dirty for a later invocation.
- Genuine read/replay/entity/finalize errors call `fail_taste_graph_rebuild`.
  The RPC schedules exponential backoff: 30, 60, 120, 240, 480, 960, then
  1800 seconds (cap). On attempt 8 it blocks. A stale failure also releases
  the superseded lease and refunds the attempt rather than penalizing new work.
- Crashes/claim response loss leave leases to expire; claim can reclaim them.
  An expired eighth attempt is blocked by the claim RPC.
- If failure reporting itself fails (expired/replaced lease, network ambiguity),
  output includes `failure_unreported` and both errors; CLI exits nonzero.
  A timed-out finalize may already have committed: do not manually acknowledge,
  clear a lease, or assume it rolled back. Repeated invocations and the RPC
  token/generation guards are the recovery mechanism.
- Blocked jobs need an explicit **service-role operator**
  `requeue_taste_graph_rebuild(user_id)` after the root cause is fixed. New
  events do not silently unblock existing failed work.

### Controlled invocation (writes; do not run against production yet)

Requires Node 24+ with native TypeScript stripping. `npm run taste:worker`
alone prints usage and claims nothing. Only `--run` performs one batch:

```sh
# Use an isolated/local or staging project, with server-managed environment:
# SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
npm run taste:worker -- --run --batch-size 5
```

The CLI does not auto-load Expo dotenv files or accept public/anon keys.
It requires the legacy JWT credential whose role is `service_role`; opaque
publishable/secret API keys are intentionally not accepted by this guard.
JWT decoding is a local misconfiguration guard, not authentication; Supabase
validates the actual credential and the RPCs enforce service-role grants.
Never prefix the service-role secret with `EXPO_PUBLIC_`, import the CLI/adapter
into Expo code, commit secrets, or log credentials. JSON output contains job
status and replay counts, not event payloads.

### Validation and eventual manual activation

```sh
npm run taste:freshness-test     # static #37A + offline worker/adapter tests
npm run taste:freshness-db-test  # disposable PostgreSQL 17 via Docker
```

The database test starts a uniquely named container with **no network or host
ports**, applies actual repository migrations on a minimal Supabase substrate,
exercises real RLS/validated onboarding/queue RPC behavior, then destroys only
that container. It never consumes a database URL or Supabase credentials.
Static assertions are not a substitute for this integration test. It does not
simulate a full Supabase deployment, PostgREST or concurrent database sessions.

After review/merge and separate approval, eventual manual steps are:

1. Apply **only** the new onboarding authority repair migration; never reapply
   the deployed #37A foundation. Confirm the owner has the same privileges as
   the existing migration owner and the private schema is not API-exposed.
2. Validate completion, direct-insert denial, replay output, stale work and
   lease/retry behavior in staging, including overlapping invocations.
3. Provision a trusted Node runner with server-only service-role credentials
   and verify time budgets, API row limits, output monitoring and blocked-job
   alerts. Existing manual `taste:rebuild --apply` must not race a queued worker:
   it deliberately uses the unguarded administrative replacement path.
4. Separately approve any production canary and scheduler/hosting design.
   No scheduler, extension enablement, deployment or production writes are
   included in this change.

Product deletion can still cascade-delete product-linked `user_events` under
the existing foreign key, and product context changes do not automatically
dirty affected users. Historical best-effort events that were never recorded
cannot be reconstructed from the event log.

## user_events as the source of truth

`public.user_events` stays append-only from the client perspective (insert-only
RLS, no client select/update/delete). Every taste affinity is **derived** and
can be dropped and rebuilt from the raw history at any time. Nothing in this
PR converts `user_events` into a mutable aggregate table.

## Entity types

Only dimensions that existing trustworthy data can actually identify:

| entity_type | Identity source | entity_key |
| --- | --- | --- |
| `product` | `public.products.id` | UUID string (lowercased) |
| `canonical_product` | `products.catalog_product_id` when non-null | UUID string (lowercased) |
| `brand` | `products.brand` | normalized text (see below) |
| `category` | `products.category` (or event-local `category` fallback) | normalized text |
| `seller` | `products.user_id` / event `seller_id` | UUID string (lowercased) |

No subcategory/family/style/material/color/aesthetic/price-band/demographic
dimensions exist yet — nothing trustworthy identifies them.

### Entity key normalization

`normalizeEntityKey(entityType, raw)` in `lib/tasteSignals.ts`:

1. trim leading/trailing whitespace
2. collapse all interior whitespace runs to single spaces
3. lowercase
4. reject empty / non-string values (`null`)

The same input semantics always produce the same key; distinct brands never
merge. `display_name` is stored separately (trimmed, original casing) and
never participates in identity.

## Signal model

Versioned (`TASTE_SIGNAL_VERSION = 1`) and centralized — numbers live only in
`lib/tasteSignals.ts`.

| event_type | kind | weight | target |
| --- | --- | --- | --- |
| `product_impression` | none (exposure/context only) | 0 | — |
| `product_open` | positive | 1 | product |
| `product_dwell` | positive, gated | 2 | product |
| `product_like` | positive | 3 | product |
| `product_unlike` | reversal of `product_like` | — | product |
| `product_save` | positive | 5 | product |
| `product_unsave` | reversal of `product_save` | — | product |
| `shop_click` | positive (purchase intent) | 6 | product |
| `seller_open` | positive | 1 | seller |
| `seller_follow` | positive | 4 | seller |
| `seller_unfollow` | reversal of `seller_follow` | — | seller |
| `search_result_open` | positive | 3 | search result target |
| `search_query` | none (context only; no NLP classification) | 0 | — |
| `product_report` | none | 0 | — |
| `sensitive_content_reveal` | none | 0 | — |
| all `catalog_match_*` | none | 0 | — |
| `catalog_variant_matched` | none | 0 | — |
| unknown future types | none (fail safe, never crash) | 0 | — |

### Dwell gating

`product_dwell` contributes only when `metadata.duration_ms` is a finite
number `>= 2000` (`DWELL_MEANINGFUL_THRESHOLD_MS`). The app records elapsed
time on the product detail screen under exactly this key (see
`app/[id].tsx`). Missing, malformed, negative, or short dwells contribute
**nothing** — the engine never invents taste from bad metadata.

### search_result_open targeting

Resolved via `metadata.result_type` + `metadata.target_id` (falling back to
the event's `product_id` / `seller_id`), matching the existing call sites in
`app/(tabs)/search.tsx`:

- `result_type: "product"` → the product target, with normal upward
  propagation to canonical product / brand / category / seller.
- `result_type: "seller"` → the seller entity at full strength.
- Anything else → no contribution (counted as malformed).

## Reversal semantics

`product_unlike` / `product_unsave` / `seller_unfollow` are **not** dislike
signals. A reversal removes exactly the contribution recorded when its
positive toggle was applied:

- Replay is state-aware. A `product_like` on product P records the exact
  per-entity deltas it applied (product + propagated dimensions). The matching
  `product_unlike` subtracts exactly those deltas, returning scores to their
  pre-like state.
- Interleaved signals on shared entities stay correct: liking two products of
  the same brand and then unliking one subtracts only that product's recorded
  brand delta.
- A duplicate positive toggle with no intervening reversal (like → like) is a
  no-op, so `like → unlike → like → unlike` cycles never accumulate drift.
- Orphan reversals (unlike/unsave/unfollow with no prior matching positive in
  the replayed history) are complete no-ops — they never create negative
  taste. They are counted in `stats.orphanReversals` for observability.

### Evidence counts

`positive_signal_count` and `negative_signal_count` are cumulative **evidence**
counts, not scores:

- each applied positive contribution increments `positive_signal_count`
- each matched reversal increments `negative_signal_count`

Scores reflect the *current effective* affinity after reversals; counts record
what was *observed*. After `like → unlike`, an entity has score ≈ 0 but
counts `(1 positive, 1 negative)`. This is deliberate: counts make future
confidence estimation possible. No fake "confidence percentage" exists yet.

## Propagation

Product-level positives propagate upward with centralized multipliers
(`PROPAGATION_MULTIPLIERS`):

| dimension | multiplier |
| --- | --- |
| product | 1.0 |
| canonical_product | 1.0 |
| brand | 0.5 |
| category | 0.5 |
| seller | 0.5 |

Seller-targeted signals (`seller_open`, `seller_follow`, seller search
results) hit the seller entity at **full strength (1.0)** and never propagate
to products. Unavailable dimensions are never inferred.

## Long-term vs recent taste

Each affinity row has two scores. Both use exponential decay with a half-life,
computed from `event.created_at` against the injected `asOf` reference time:

```
contribution = weight × multiplier × 0.5 ^ (ageInDays / halfLifeDays)
ageInDays    = max(0, (asOf - event.created_at) / 86 400 000)
```

| score | half-life | meaning |
| --- | --- | --- |
| `long_term_score` | 365 days | persistent preference (barely fades in v1) |
| `recent_score` | 14 days | current interest |

Events dated after `asOf` clamp to age 0 (treated as just-happened) rather
than amplifying. All decay math depends only on event timestamps and `asOf` —
never `Date.now()` — so replays are deterministic.

**Session intent is NOT implemented in PR #34.** Long-term taste, recent
interest, and future session intent are distinct concepts; only the first two
exist here.

## Rebuild procedure

```
npm run taste:rebuild -- --user <uuid>                 # dry-run (default, zero writes)
npm run taste:rebuild -- --user <uuid> --apply         # write the snapshot
npm run taste:rebuild -- --user <uuid> --as-of 2026-10-01T00:00:00.000Z
```

The rebuild:

1. reads the user's full `user_events` history (service role; paged)
2. resolves product context from `public.products` for referenced ids
3. builds the deterministic snapshot with `lib/tasteGraph.ts`
4. **apply only:** upserts `taste_entities` by `(entity_type, entity_key)` —
   shared, non-user lookup rows that are harmless if left unused after a
   failed rebuild — then **fails closed**: if any snapshot entity did not
   resolve to exactly one persisted taste_entity id (missing, duplicate, or
   id-less mapping), the rebuild throws here, before any affinity write
5. **apply only, atomically:** calls the
   `public.replace_user_taste_affinity_snapshot(p_user_id, p_rows)` RPC, which
   in ONE PostgreSQL function call upserts the new affinity rows by
   `(user_id, taste_entity_id)` and deletes the user's stale rows. If
   anything fails inside the function, PostgreSQL rolls back the entire
   replacement, so the user's previous snapshot is preserved — derived state
   can never be left in a mixed old/new state. An empty snapshot correctly
   deletes all of that user's affinities; other users' rows are structurally
   out of scope (`where user_id = p_user_id`)
6. prints a summary: events processed, taste events, skipped non-taste
   events, malformed events, orphan reversals, unresolved products, entities /
   affinities produced, rows written/deleted

Dry-run performs **zero** writes (verified by tests). Requires
`SUPABASE_SERVICE_ROLE_KEY` in `.env.local` (gitignored) even for dry-runs,
because `user_events` RLS is insert-only for clients.

### Idempotency

Same user + same history + same as-of ⇒ same snapshot. Applying the same
snapshot twice converges: the atomic upsert-replace plus stale-row deletion
means nothing is ever "incremented again". Covered by tests.

### Event ordering

Replay order is `created_at` ascending with a stable tie-break on event `id`,
so rows sharing a timestamp always replay identically. Malformed rows (bad
`created_at`, missing `id`/`event_type`, unresolvable required targets) are
counted and skipped without aborting the rebuild.

### Missing / deleted products

When an event references a product that no longer exists in
`public.products`:

- the rebuild does not crash
- the product entity itself is still keyed from `event.product_id`
- safe event-local dimensions (`event.category`, `event.seller_id`) are
  preserved
- brand / canonical identity is **never** invented
- the id is reported in `stats.unresolvedProducts`

## Debug / inspection

Read-only snapshot printing:

```
npm run taste:inspect -- --user <uuid> [--as-of <ISO>]
npm run taste:inspect -- --fixture scripts/fixtures/taste-graph-sample.json --as-of 2026-10-01T00:00:00.000Z
```

Shows entity type, key/display name, long-term score, recent score, positive
and negative/reversal evidence counts, and last interaction. The fixture mode
runs fully offline for deterministic testing.

## RLS / security model

| table | authenticated client | service role |
| --- | --- | --- |
| `taste_entities` | `SELECT` only (non-sensitive lookup rows) | full (rebuild writes) |
| `user_taste_affinities` | `SELECT` own rows only (`auth.uid() = user_id`) | full (rebuild writes via RPC) |
| `user_events` | insert own behavioral events; like/save/follow trigger-only; onboarding events RPC-only after #37B repair | full |
| `taste_graph_rebuild_queue` | no access | worker operations through restricted RPCs |

The `public.replace_user_taste_affinity_snapshot(uuid, jsonb)` function is
`SECURITY INVOKER` with `set search_path = ''` and fully schema-qualified
tables. EXECUTE is revoked from `PUBLIC` (Postgres grants it by default),
`anon`, and `authenticated`, and granted only to `service_role` — the
intended sole caller. `SECURITY INVOKER` is deliberate defense in depth:
even if EXECUTE were mistakenly granted to a client role, RLS would still
block the writes because no client write policies exist on
`user_taste_affinities`.

No client can insert/update/delete affinity scores or mutate entities; no user
can read another user's taste profile. The service-role key never ships in a
client bundle — it is only used by `scripts/` run locally by an operator.

## Current limitations

- Worker runtime exists but production scheduling/activation is still pending.
  Replay remains full-history, never incremental.
- No database trigger recalculates taste on event insert.
- `search_query` is context-only; no semantic/NLP classification.
- `last_interaction_at` only reflects taste-contributing events.
- Seller entities have no `display_name` yet (no trustworthy name in product
  context).
- Scores are unbounded sums; no normalization or confidence layer yet.

## Future integration points

- **Taste Onboarding** (PR #35): seed initial affinities from explicit picks.
- **Feed V2** (PR #36): consume `user_taste_affinities` in ranking. The
  current feed (`lib/feedRanking.ts`) is intentionally unchanged and does not
  depend on taste state being populated.
- Explainability / "Why you're seeing this" from entity-level evidence counts.
- Embeddings and a PENCHANT AI recommender on top of these entities.
- Session intent as a third, separate score.
