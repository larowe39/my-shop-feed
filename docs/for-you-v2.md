# FOR YOU V2 — Taste Graph-Aware Feed Ranking (PR #36)

FOR YOU V2 makes the persisted Taste Graph (PR #34) the **primary preference
model** of the FOR YOU feed, while preserving the useful V1 signals
(quality, freshness, followed sellers, direct engagement, diversity) and the
unchanged V1 ranker as a safe fallback.

## Architecture

```
service-side Taste Graph rebuild (scripts/taste-graph-rebuild.js, PR #34)
        ↓  (manual/operator-run today — no automatic materialization)
public.user_taste_affinities + public.taste_entities
        ↓  (RLS: own affinity rows only; entities authenticated read-only)
client batched loader (lib/tasteAffinities.ts, 2 queries per load)
        ↓
resolved O(1) affinity lookup (Map "entity_type:entity_key" → entry)
        ↓
pure FOR YOU V2 ranker (lib/forYouV2.ts, injected nowMs)
        ↓
deterministic diversity/exploration interleaver (same module)
        ↓
Feed UI (app/(tabs)/index.tsx), Search EXPLORE (app/(tabs)/search.tsx)
```

- **No server-side ranking** in this PR.
- **No affinity writes from the client** — no client write policies exist on
  either taste table; the loader is read-only and statically write-free.
- **No background rebuild infrastructure** in this PR (scope boundary; see
  "Freshness" below).

## Affinity loader (lib/tasteAffinities.ts)

Exactly **two batched queries** per load, implemented as
`tasteAffinityStore` in `hooks/ProductsContext.tsx`:

1. `user_taste_affinities.select("taste_entity_id, recent_score, long_term_score, positive_signal_count, negative_signal_count, last_interaction_at, updated_at").eq("user_id", userId)` — RLS restricts to the caller's own rows.
2. `taste_entities.select("id, entity_type, entity_key, display_name").in("id", ids)` — ONE batched query for **all** referenced entity ids.

There are **no per-affinity entity queries**; the store interface
(`fetchUserAffinities` / `fetchTasteEntities(ids)`) makes N+1 structurally
impossible, and the offline suite asserts the single batched call.

`buildTasteAffinityLookup` (pure) resolves rows into
`Map<"entity_type:normalized entity_key", entry>` using the **same**
`normalizeEntityKey` from `lib/tasteSignals.ts` that the rebuild path used —
normalization semantics are never duplicated. Rows with missing/duplicate
entity records are skipped safely; non-finite scores coerce to 0.

Loading is **best effort**: any failure resolves to `null` and the feed
falls back to V1. It is race-safe across auth changes (request-id guard in
`ProductsContext`), signed-out safe (state cleared), and empty-snapshot
safe. Exposed via `ProductsContext` as `affinityLookup` +
`affinitySnapshotAt` (latest persisted `updated_at` — metadata only).

## Scoring formula

Per candidate product:

```
score = 1.0                                  base
      + quality  (≤ 0.20, V1 unchanged: image .10 / brand .04 / price .03 / url .03)
      + recency  (≤ 0.25, 14-day linear decay vs INJECTED nowMs; invalid date → 0.05)
      + taste    (bounded, see below)
      + 0.30 if product.user_id ∈ followingIds
      + 0.08 if liked or saved
      − 0.15 if product.user_id === currentUserId
      + hash("product.id") × 0.08            deterministic tie jitter
      + exploration (≤ 0.20, see below)
```

### Temporal blend

```
blended = 0.65 × recent_score + 0.35 × long_term_score
```

### Saturation

Raw affinity magnitudes are **never** added to the feed score directly.
Magnitude is transformed by a monotonic, sign-preserving saturating function:

```
saturate(x) = sign(x) × (1 − exp(−|x| / k)),   k = 4
```

| x | saturate(x) |
|---|---|
| 0 | 0 |
| 2 | 0.393 |
| 4 | 0.632 |
| 8 | 0.865 |
| 10 | 0.918 |
| →∞ | → 1 (finite ceiling) |

k = 4 matches current signal magnitudes (single onboarding select = 4,
strong categories ≈ 8–10): 0→2 matters substantially, 2→4 still matters,
8→10 matters much less. Negative affinity stays **bounded negative**
(mirrored saturation into (−1, 0]) and can never become positive relevance.

### Dimension contributions

Each dimension contributes `saturate(blend) × weight`, individually bounded:

| dimension | key source | weight (cap) |
|---|---|---|
| product | `product.id` | 1.0 |
| canonical_product | `product.catalog_product_id` (if present) | 0.9 |
| brand | `product.brand` | 0.6 |
| category | combined raw+curated (below) | 0.7 |
| seller | `product.user_id` | 0.4 |

Total taste contribution is bounded by the sum of weights (**≤ 3.6**) even
when every dimension matches. Exact/canonical identity are the strongest
individual matches; brand/category provide generalization to unseen
products; seller is deliberately moderate so seller taste cannot dominate
product taste.

## Category namespace bridge

The Taste Graph legitimately contains two category namespaces:

- **A. raw product categories** (`hoodies`, `sneakers`) from organic signals
- **B. curated discovery categories** (`fashion`, `shoes`, `electronics`)
  from onboarding selections

For each candidate, the ranker collects **both**:

1. the affinity of the product's normalized raw category;
2. the affinity of every visible curated discovery category the product
   matches via the existing `matchProductCategory` semantics
   (`constants/categories.ts`) over `CURATED_DISCOVERY_CATEGORY_SLUGS`.

Keys are de-duplicated (raw `"shoes"` and curated `"shoes"` are the same
normalized key), then combined **without naive double counting**:

```
combined = strongest + 0.25 × (sum of additional distinct signals), clamped to [-1, 1]
```

The strongest signal is primary; additional distinct category evidence
contributes a smaller incremental amount. Entity keys are NOT rewritten and
no migration is involved.

## Self-seller protection

Handled entirely inside the ranker; the graph is never mutated or filtered:

- when `product.user_id === currentUserId`, the **seller-affinity
  contribution is ignored** for that candidate;
- the explicit **own-item penalty (−0.15)** is retained.

A user's interactions with their own listings can never cause self-seller
affinity to reinforce their own products.

## Retained V1 signals

Quality (≤0.20), recency (≤0.25), followed-seller bonus (+0.30), direct
liked/saved engagement (+0.08), own-item penalty (−0.15), deterministic tie
jitter (≤0.08), and the greedy diversity interleaver are all preserved.

V1's per-render category affinity (`computeUserCategoryAffinity`) is
**deliberately dropped** in V2: Taste Graph category relevance is the
primary category preference model, and keeping both would double-count the
same preference. Likes/saves remain as direct engagement context (+0.08).

## Diversity + exploration

The deterministic greedy anti-clustering pass is preserved unchanged:

- window: top 10 remaining candidates per slot;
- same category as previous item: −0.50; as item 2 back: −0.22;
- same seller **or** brand as previous: −0.60; as 2 back: −0.25.

Exploration is a modest **deterministic** pressure, not a partition:
whenever a candidate's combined category signal is weak or absent
(`0 ≤ combined < 0.05`), it receives `hash("explore:" + product.id) × 0.20`
— a stable per-product bonus in `[0, 0.20)` that lets unseen or
weaker-affinity categories periodically enter the candidate window.
Negatively-affinity categories receive none. No `Math.random()`, no render
reshuffles, no unstable ordering.

## Recency

Same 14-day linear decay as V1 (`max(0, 1 − ageHours/336) × 0.25`), but
computed against the **injected `nowMs`** — the pure ranker never calls
`Date.now()`. Missing/invalid `created_at` yields the deterministic 0.05
fallback.

## Stale-snapshot contract

There is intentionally **no automatic/background materialization** of
`user_taste_affinities` yet. FOR YOU V2 is therefore stale-tolerant:

- no affinities → V1 fallback (`hasUsableTasteAffinities` is false);
- affinity load failure → V1 fallback;
- persisted affinities are used **even if not perfectly current** — the
  ranker never applies a freshness cutoff;
- new `user_events` are NOT treated as already-reflected in the graph;
- `affinitySnapshotAt` exposes snapshot freshness metadata for observability;
- the client never writes affinities.

Automatic materialization (scheduled rebuild, trigger/queue on
`user_events`) is **future infrastructure** after PR #36.

## Integration

- `app/(tabs)/index.tsx` — FOR YOU uses `rankForYouFeedV2` when
  `hasUsableTasteAffinities(affinityLookup)`, else the unchanged V1
  `rankForYouFeed`. FOLLOWING mode is untouched. Impression/open/dwell/
  shop-click/like/save/seller navigation and moderation behavior are
  unchanged; no new `user_events` writes.
- `app/(tabs)/search.tsx` — the no-query EXPLORE strip uses the same V2/V1
  decision with the **shared** context lookup (no duplicate queries).

## Tuning parameters

All in `lib/forYouV2.ts`: `TASTE_BLEND_RECENT/LONG_TERM` (0.65/0.35),
`AFFINITY_SATURATION_K` (4), `DIMENSION_WEIGHTS`
(1.0/0.9/0.6/0.7/0.4), `CATEGORY_SECONDARY_FACTOR` (0.25),
`FOLLOWED_SELLER_BONUS` (0.30), `ENGAGEMENT_BONUS` (0.08),
`OWN_ITEM_PENALTY` (−0.15), `TIE_JITTER_WEIGHT` (0.08),
`EXPLORATION_WEIGHT` (0.20), `EXPLORATION_CATEGORY_THRESHOLD` (0.05),
diversity penalties/window.

## What PR #36 deliberately does NOT implement

- Server-side ranking / ranking RPC.
- Automatic or background Taste Graph rebuilds (cron, webhooks, queues,
  DB triggers on `user_events`).
- Incremental affinity updates from the client.
- Any migration (the existing RLS/schema are sufficient).
- Explainability UI (entity evidence counts are loaded but not displayed).
- Changes to PR #33 catalog apply work, moderation, or event tracking.

## Tests

`npm run taste:for-you-test` — deterministic offline suite
(`scripts/test-for-you-v2.js`) covering blending, saturation (including
production-shaped magnitudes), all five dimensions, the category bridge,
self-seller protection, retained V1 signals, diversity, exploration,
fallback/safety contracts, loader batching/mapping/error handling, input
immutability, and V1 regression. Preserved: `npm run taste:test`,
`npm run taste:onboarding-test`.
