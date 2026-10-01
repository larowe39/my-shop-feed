# Taste Onboarding (PR #35)

PENCHANT's first-user Taste Onboarding turns a brand-new authenticated user
from a cold start into a useful **explicit** taste seed through a short,
visual shopping/discovery flow:

1. **"What are you into?"** — curated category multi-select (min 3).
2. **"Pick what catches your eye."** — real-product visual selection (min 5).
3. **"Your Penchant is taking shape."** — concise summary, then **Enter PENCHANT**.

This PR establishes the onboarding **data + UX contract** that PR #36
(FOR YOU V2) will consume. It does not change feed ranking.

## Source of truth

| Concern | Where |
| --- | --- |
| Eligibility marker | `public.user_profiles.taste_onboarding_version` (NULL = grandfathered) |
| Onboarding state | `public.user_taste_onboarding` (one row per user) |
| Taste-relevant events | `public.user_events` (unchanged append-only source of truth) |
| Derived affinities | `public.user_taste_affinities` (PR #34; untouched by this PR's client) |

Navigation never infers completion by scanning events — it reads the state
row via `hooks/TasteOnboardingContext.tsx`.

## UX stages

- **Stage 1 — categories.** The curated discovery categories from
  `constants/categories.ts`, filtered by the existing visibility rules in
  `lib/discoveryTaxonomy.ts` (`getOnboardingCategories()`). Multi-select,
  obvious reversible tactile states, at least **3** required before Continue
  (`ONBOARDING_MIN_CATEGORY_SELECTIONS`). Internal canonical taxonomy nodes
  are never exposed.
- **Stage 2 — products.** A deterministic image-forward grid of **real**
  `public.products` candidates (see below), moderation-aware imagery
  (`ModeratedProductImage`), at least **5** selections
  (`ONBOARDING_MIN_PRODUCT_SELECTIONS`; relaxed to "everything available"
  when the catalog genuinely offers fewer — `requiredProductMinimum()`).
- **Stage 3 — completion.** Selected category names, a few selected brands,
  product count, and the **Enter PENCHANT** CTA which atomically completes
  onboarding (see below).

While the user taps/untaps, selections are **local only** — no events fire
per tap. Moving between stages persists the in-progress selection to the
state row (status `in_progress`, no taste events), so an interrupted or
resumed onboarding keeps its selections.

## Eligibility / grandfathering (rollout-safe)

The app already has historical users, so "row missing" can never mean
"onboarding required". The mechanism:

- `user_profiles.taste_onboarding_version integer NULL` — added by
  `supabase/migrations/20261002_add_taste_onboarding.sql`. Applying the
  migration **never retroactively marks existing users**: the column
  defaults to NULL.
- When the client **creates a brand-new profile row**
  (`AuthContext.ensureUserProfile`), it sets the marker to the current
  `ONBOARDING_VERSION` (1). Existing profiles hit the unique constraint on
  insert and keep NULL → **grandfathered, normal app forever**.
- A brand-new account created after feature activation gets marker `1` →
  **onboarding required** until its state row is `completed`.
- `in_progress` state → **resume** onboarding with saved selections.
- Completion is durable in Postgres — sign-out/sign-in preserves state, and
  nothing authoritative lives in AsyncStorage.
- Email-confirmation flow: the profile (and marker) is created on the first
  session after confirmation, exactly like any new account; the gate then
  routes to onboarding. No production activation timestamp is inferred
  anywhere in client code.
- Race safety: if the profile row isn't visible yet (the ensure-insert lands
  asynchronously), `TasteOnboardingContext` retries (5 × 500 ms) rather than
  deciding early; a definitively missing profile is treated as **eligible**,
  never grandfathered, so profile creation can never permanently skip
  required onboarding.

Known edge: a historical account that predates `user_profiles` entirely and
whose profile gets created only now would receive the marker and see
onboarding once — acceptable, and completing or grandfathering is decided by
the same deterministic rule.

## Centralized navigation gate

One decision, evaluated at the root navigation boundary
(`app/_layout.tsx` → `OnboardingGate`), via the pure, unit-tested
`resolveOnboardingGate()` in `lib/tasteOnboarding.ts`:

| State | Decision |
| --- | --- |
| auth loading | blocking veil (`loading`) |
| signed out | previous behavior (browsing allowed); `/onboarding` → app |
| signed in, onboarding status loading | blocking veil (no flash of the normal app) |
| signed in, `required` | anywhere → `/onboarding`; already there → `none` |
| signed in, `completed` / `grandfathered` | `/onboarding` → app; elsewhere → `none` |

The gate renders an opaque veil while loading or while a redirect is pending,
so a required user never sees a flash of the tabs. Redirects converge after
one hop (no loops — the `none` states are stable fixed points). Sign-in now
routes to `/` and lets the gate own the next step. Sign-out works from the
onboarding header as well as the profile tab.

## Onboarding events

Explicit, typed, and distinguishable from ordinary behavioral signals. They
are **never** faked `product_like` / `product_save` / `seller_follow` /
`product_open` / `dwell` events, and they never fire on ordinary browsing.

| event_type | kind | target | weight |
| --- | --- | --- | --- |
| `onboarding_category_select` | positive (toggle) | category entity only | 4 |
| `onboarding_category_deselect` | reversal of select | category entity only | 0 |
| `onboarding_product_select` | positive (toggle) | product + standard propagation | 4 |
| `onboarding_product_deselect` | reversal of select | product + standard propagation | 0 |
| `onboarding_complete` | none (lifecycle/context) | none | 0 |

### Exact weights and propagation

- `onboardingCategorySelect = 4` — contributes to the **category entity only**
  (key = curated category id, e.g. `fashion`), at full strength. It never
  invents product, brand, seller, or canonical-product affinity.
- `onboardingProductSelect = 4` — resolves through the existing trustworthy
  product dimensions with the standard `PROPAGATION_MULTIPLIERS`:
  product ×1.0, canonical_product ×1.0 (when known), brand ×0.5,
  category ×0.5, seller ×0.5. A weight of 4 is a meaningful cold-start seed
  (above `open` 1 / `dwell` 2 / `like` 3) but deliberately **below**
  `save` 5 and `shop_click` 6, so later organic high-intent signals overtake
  it.
- `onboarding_complete` is lifecycle context only and contributes **zero**
  taste. Completing onboarding is not itself a preference.

### Reversal semantics

Deselects are state-aware reversals, not dislikes: a deselect removes exactly
the contribution recorded by the matching select. Orphan deselects are
complete no-ops, and repeated select/deselect cycles cannot drift (all
verified in `scripts/test-taste-graph.js`). The engine dedupes repeated
selects on the same scope (`toggle: true`), so idempotent retries never
double-count even if events were somehow duplicated.

`TASTE_SIGNAL_VERSION` is bumped to **2** (additive change; pre-existing
event semantics are unchanged).

## Completion: atomic RPC

Completing onboarding calls `public.complete_taste_onboarding(p_user_id,
p_categories, p_product_ids)` — the single, atomic server-side path that, in
**one transaction**:

1. validates `auth.uid() = p_user_id`,
2. validates categories against the curated allowlist (mirrors
   `CURATED_DISCOVERY_CATEGORY_SLUGS`),
3. validates product ids are UUIDs that **exist in `public.products`**
   (demo/fake ids rejected),
4. enforces ≥ 3 categories / ≥ 5 products,
5. computes the event delta against the **previously committed** row and
   inserts only the needed select/deselect events,
6. inserts `onboarding_complete` exactly once (first completion),
7. upserts the state row as `completed`.

This is an intentional narrow exception to the "`lib/analytics.ts` is the
only client writer to `user_events`" rule: the RPC inserts events
**server-side** so state + events commit atomically. UI components contain
no direct `user_events` inserts for onboarding.

### Why the delta comes from the state row

`user_events` is insert-only under RLS, so an invoker-security function
cannot read it. That is safe because the RPC is the **only** writer of
onboarding events and updates the state row in the same transaction —
"events emitted so far" always equals "the last completed row's selections".
The same delta algorithm is mirrored in pure JS
(`computeOnboardingEventDelta()`) and unit-tested offline.

### Retry / idempotency

- Retrying a completed call with the same payload inserts **no** events and
  rewrites the same state row — network retries cannot multiply taste
  strength.
- A retry with changed selections emits only the difference (selects for
  added, deselects for removed).
- Any failure rolls back both events and state, so they cannot disagree.

### RPC security model

- `SECURITY INVOKER` (no `SECURITY DEFINER`): every write runs as the calling
  user and must pass the existing RLS policies.
- `set search_path = ''` and all tables are schema-qualified.
- Explicit `auth.uid()` checks: one user can never complete, seed events
  for, or modify another user's onboarding (client-side validation is UX
  only; the server re-validates everything).
- `EXECUTE` revoked from `public`/`anon`, granted to `authenticated` only.
- The RPC never touches `user_taste_affinities` — derived state stays owned
  by the service-side rebuild (PR #34). No client service-role secret exists.

### RLS policies (state table)

`public.user_taste_onboarding`: `select`/`insert`/`update` own-row only
(`auth.uid() = user_id`), no delete policy, no anon access.

## Product candidate selection

`selectOnboardingCandidates()` (pure, `lib/tasteOnboarding.ts`):

- **Real products only** — UUID ids required, so the local demo row
  (`demo-1`) and any non-UUID id can never be persisted as a selection.
- Hidden-moderation products excluded; a usable image is required.
- Matches the selected curated categories via the existing
  `matchProductCategory()` semantics; `canonical_product_id` not required.
- Buckets each product by its **first** matching selected category (sorted
  category ids), sorts each bucket newest-first with id tie-breaks, then
  interleaves buckets **round-robin** so no single category fills the screen
  while alternatives exist; within each visit a brand differing from the
  previously picked brand is preferred (brand diversity where practical).
- Sparse fallback: fills remaining slots from eligible products in other
  categories; if still short, returns what exists — never fabricates.
- Fully deterministic: the same dataset always yields the same grid.

No impression/open/like/save events are emitted for onboarding candidate
renders or taps.

## What happens right after completion

The state row is `completed` and the explicit onboarding events exist in
`user_events`. The mobile client does **not** write
`user_taste_affinities`; the derived table remains rebuildable via the PR #34
path (`scripts/taste-graph-rebuild.js`, dry-run by default). PR #36 consumes
the events/state for FOR YOU V2 and decides when to rebuild/materialize —
this PR deliberately does not add a background job.

## Boundary

**Included:** onboarding state schema + eligibility marker, atomic completion
RPC, centralized gate, 3-stage UX, candidate selection, onboarding events +
Taste Graph support, tests, docs.

**Excluded (future PRs):** FOR YOU V2 ranking/feed redesign, Taste Profile
UI, **Tune Your Penchant** (the versioning + state model already allows
re-running onboarding; the UI is intentionally not built), embeddings/vector
DB/LLM recommendations/graph DB, background workers, catalog
acquisition/persistence changes.

## Known limitations

- The curated category allowlist is duplicated between
  `lib/discoveryTaxonomy.ts` and the RPC SQL (both asserted by tests); keep
  them in sync when categories change.
- Category affinity from onboarding keys on curated ids (`fashion`), while
  product-derived category affinity keys on the product's free-text category
  (`hoodies`). PR #36 should join them via the curated keyword mapping.
- Offline tests validate the RPC's SQL/security contract statically and its
  delta semantics via the pure mirror; real PostgreSQL transactional/RLS
  behavior was **not** exercised (migrations are applied manually).
- A signed-in user's gate check adds a brief loading veil on cold start
  while the profile/state fetch settles (by design: no flash of the app for
  required onboarding users).

## Validation

```
npm run taste:test               # PR #34 suite + onboarding signal tests
npm run taste:onboarding-test    # PR #35 suite
npm run lint
npx tsc --noEmit
git diff --check
```

The migration is applied manually via the Supabase SQL editor, like every
migration in this repo. No production migration, onboarding completion, or
Taste Graph `--apply` rebuild was executed for this PR.
