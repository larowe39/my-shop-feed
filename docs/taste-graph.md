# Taste Graph Foundation (PR #34)

The Taste Graph turns PENCHANT's append-only behavioral history
(`public.user_events`) into deterministic, rebuildable user taste affinities.
This document describes the foundation plus the durable freshness queue
foundation (PR #37A). Feed V2 and Taste Onboarding build on it.

```
user_events (append-only source of truth)
    ↓  taste-relevant event increments a per-user dirty generation
taste_graph_rebuild_queue (derived work state; worker not active yet)
    ↓  future leased worker performs full replay
    ↓  event → taste signal mapping        (lib/tasteSignals.ts)
taste_entities                             (public.taste_entities)
    ↓  deterministic replay engine         (lib/tasteGraph.ts)
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
| Freshness queue migration | `supabase/migrations/20261005_add_taste_graph_freshness_foundation.sql` | Transactional dirty generations, preference-state events, and worker-only queue RPCs. Not deployed; no worker or schedule is active. |
| Inspect CLI | `scripts/taste-graph-inspect.js` | Read-only debug printing of a computed snapshot; supports `--user` and offline `--fixture` modes. |
| Migration | `supabase/migrations/20261001_add_taste_graph_foundation.sql` | New tables, RLS, and the atomic replacement RPC. Applied manually via the Supabase SQL editor like all migrations in this repo. |
| Tests | `scripts/test-taste-graph.js` | `npm run taste:test` — fully offline, deterministic. |

`lib/analytics.ts` remains the **only** client-side writer to
`public.user_events`. The Taste Graph adds no new client write paths:
affinity state is derived exclusively by the service-side rebuild.

## Automatic freshness foundation (not active)

The raw `public.user_events` table remains the source of truth; the
`public.taste_graph_rebuild_queue` table is derived work state only. Its
monotonic `requested_generation` and `processed_generation` identify exactly
which event history a future full replay must publish. A worker lease token
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

This PR adds only the database/queue foundation. The Edge Function worker is
not implemented, no automatic rebuild is active, the migration is not yet
deployed, and `pg_cron` / `pg_net` remain disabled. Until a worker is deployed
and scheduled, the existing manual rebuild path remains the only materializer.

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
| `user_events` | insert own behavioral events; explicit like/save/follow events are trigger-only | full |
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

- Rebuild is manual/one-user-at-a-time; no automatic incremental or
  background processing (deliberately — correctness first).
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
