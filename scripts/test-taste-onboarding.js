#!/usr/bin/env node
// scripts/test-taste-onboarding.js
//
// Deterministic offline test suite for Taste Onboarding (PR #35).
// No Supabase, no network: eligibility/gate logic, category normalization,
// candidate selection, completion validation, and the event-delta
// idempotency semantics are all pure (lib/tasteOnboarding.ts). The migration
// is validated as a static SQL/security contract.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ONBOARDING_MIGRATION = "20261002_add_taste_onboarding.sql";

// Deterministic product fixtures. ids are valid UUIDs (the selector rejects
// anything else); created_at ties are intentional to exercise id tie-breaks.
const UUID = (n) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

function product(n, overrides = {}) {
  return {
    id: UUID(n),
    title: `Product ${n}`,
    brand: overrides.brand ?? `Brand${n}`,
    category: overrides.category ?? "hoodies",
    image_url:
      "image_url" in overrides ? overrides.image_url : `https://img.test/${n}.jpg`,
    created_at: overrides.created_at ?? `2026-09-0${(n % 9) + 1}T00:00:00.000Z`,
    user_id: overrides.user_id ?? UUID(9000 + n),
    moderation:
      "moderation" in overrides ? overrides.moderation : null,
  };
}

async function main() {
  const onboarding = await import("../lib/tasteOnboarding.ts");
  const categoriesModule = await import("../constants/categories.ts");
  const taxonomy = await import("../lib/discoveryTaxonomy.ts");

  const {
    ONBOARDING_VERSION,
    ONBOARDING_MIN_CATEGORY_SELECTIONS,
    ONBOARDING_MIN_PRODUCT_SELECTIONS,
    ONBOARDING_PRODUCT_CANDIDATE_COUNT,
    isUuid,
    getOnboardingCategories,
    isValidOnboardingCategoryId,
    normalizeOnboardingCategoryIds,
    resolveOnboardingStatus,
    resolveOnboardingGate,
    requiredProductMinimum,
    selectOnboardingCandidates,
    validateOnboardingCompletion,
    computeOnboardingEventDelta,
  } = onboarding;

  // -----------------------------------------------------------------------
  // Eligibility / navigation
  // -----------------------------------------------------------------------

  // 1. Historical user with no onboarding row is grandfathered (NULL marker).
  assert.strictEqual(
    resolveOnboardingStatus({
      userId: UUID(1),
      profile: { taste_onboarding_version: null },
      state: null,
    }),
    "grandfathered"
  );

  // 2. New eligible user with no completion is required.
  assert.strictEqual(
    resolveOnboardingStatus({
      userId: UUID(1),
      profile: { taste_onboarding_version: ONBOARDING_VERSION },
      state: null,
    }),
    "required"
  );

  // 3. In-progress user resumes (status row present but not completed).
  assert.strictEqual(
    resolveOnboardingStatus({
      userId: UUID(1),
      profile: { taste_onboarding_version: ONBOARDING_VERSION },
      state: { status: "in_progress" },
    }),
    "required"
  );

  // 4. Completed user bypasses onboarding.
  assert.strictEqual(
    resolveOnboardingStatus({
      userId: UUID(1),
      profile: { taste_onboarding_version: ONBOARDING_VERSION },
      state: { status: "completed" },
    }),
    "completed"
  );

  // 5. Signed-out behavior.
  assert.strictEqual(
    resolveOnboardingStatus({ userId: null, profile: undefined, state: undefined }),
    "signed_out"
  );
  assert.strictEqual(
    resolveOnboardingGate({ authLoading: false, status: "signed_out", inOnboarding: false }),
    "none"
  );
  // Signed-out users never sit on the onboarding route.
  assert.strictEqual(
    resolveOnboardingGate({ authLoading: false, status: "signed_out", inOnboarding: true }),
    "to_app"
  );

  // 6. Auth loading blocks the decision.
  assert.strictEqual(
    resolveOnboardingGate({ authLoading: true, status: "completed", inOnboarding: false }),
    "loading"
  );

  // 7. Onboarding status loading blocks the decision.
  assert.strictEqual(
    resolveOnboardingStatus({ userId: UUID(1), profile: undefined, state: undefined }),
    "loading"
  );
  assert.strictEqual(
    resolveOnboardingGate({ authLoading: false, status: "loading", inOnboarding: false }),
    "loading"
  );

  // 8. No redirect loop: required user already on /onboarding stays; completed
  //    user inside the app stays; transitions converge after one redirect.
  assert.strictEqual(
    resolveOnboardingGate({ authLoading: false, status: "required", inOnboarding: false }),
    "to_onboarding"
  );
  assert.strictEqual(
    resolveOnboardingGate({ authLoading: false, status: "required", inOnboarding: true }),
    "none"
  );
  assert.strictEqual(
    resolveOnboardingGate({ authLoading: false, status: "completed", inOnboarding: true }),
    "to_app"
  );
  assert.strictEqual(
    resolveOnboardingGate({ authLoading: false, status: "completed", inOnboarding: false }),
    "none"
  );
  assert.strictEqual(
    resolveOnboardingGate({ authLoading: false, status: "grandfathered", inOnboarding: false }),
    "none"
  );

  // -----------------------------------------------------------------------
  // Eligibility repair regressions (DB-authoritative enrollment)
  // -----------------------------------------------------------------------

  // R1. Historical user + existing profile + NULL marker => grandfathered.
  assert.strictEqual(
    resolveOnboardingStatus({
      userId: UUID(1),
      profile: { taste_onboarding_version: null },
      state: null,
    }),
    "grandfathered"
  );

  // R2. Historical user + NO profile row => grandfathered, NOT eligible.
  //     (A missing profile must never fabricate eligibility.)
  assert.strictEqual(
    resolveOnboardingStatus({ userId: UUID(1), profile: null, state: null }),
    "grandfathered"
  );

  // R3. Delayed/failed profile creation: still missing after retries =>
  //     grandfathered; while the fetch is unsettled => loading (fail-safe),
  //     and the gate never routes a loading user anywhere.
  assert.strictEqual(
    resolveOnboardingStatus({ userId: UUID(1), profile: null, state: null }),
    "grandfathered"
  );
  assert.strictEqual(
    resolveOnboardingGate({ authLoading: false, status: "loading", inOnboarding: true }),
    "loading"
  );

  // R4. New user created after activation (trigger-enrolled marker) =>
  //     version 1 required, even before any state row exists.
  assert.strictEqual(
    resolveOnboardingStatus({
      userId: UUID(1),
      profile: { taste_onboarding_version: 1 },
      state: null,
    }),
    "required"
  );

  // R5. New-user creation race: profile row not yet visible => loading, and
  //     the gate holds (veil) instead of either skipping into the app or
  //     mis-enrolling. When the marker row lands, status resolves required.
  assert.strictEqual(
    resolveOnboardingStatus({ userId: UUID(1), profile: undefined, state: null }),
    "loading"
  );
  assert.strictEqual(
    resolveOnboardingGate({ authLoading: false, status: "loading", inOnboarding: false }),
    "loading"
  );

  // R6/R7. Eligibility is a pure function of DB-fetched inputs (the profile
  // marker), not local/session state: the same inputs always resolve the same
  // status, regardless of when/where they are evaluated.
  {
    const eligible = { userId: UUID(1), profile: { taste_onboarding_version: 1 }, state: null };
    const historical = { userId: UUID(2), profile: null, state: null };
    for (let i = 0; i < 3; i += 1) {
      assert.strictEqual(resolveOnboardingStatus(eligible), "required");
      assert.strictEqual(resolveOnboardingStatus(historical), "grandfathered");
    }
  }

  // -----------------------------------------------------------------------
  // Category selection
  // -----------------------------------------------------------------------

  // 9. Onboarding categories are exactly the curated visible set.
  {
    const visible = getOnboardingCategories();
    assert.ok(visible.length > 0);
    const slugs = new Set(taxonomy.CURATED_DISCOVERY_CATEGORY_SLUGS);
    for (const c of visible) {
      assert.ok(slugs.has(c.id), `${c.id} must be a curated discovery category`);
    }
    assert.strictEqual(visible.length, categoriesModule.CATEGORIES.length);
    const expected = [
      "fashion", "shoes", "watches", "automotive", "home",
      "electronics", "outdoors", "beauty", "fitness", "accessories",
    ];
    for (const id of expected) assert.ok(isValidOnboardingCategoryId(id), id);
    assert.ok(!isValidOnboardingCategoryId("canonical_node_42"));
  }

  // 10. Minimum 3 categories enforced by completion validation.
  assert.strictEqual(ONBOARDING_MIN_CATEGORY_SELECTIONS, 3);

  // 11 + 12. Normalization: stable, curated-only, sorted, de-duplicated.
  {
    assert.deepStrictEqual(
      normalizeOnboardingCategoryIds(["Shoes", " fashion ", "shoes", "nope", 42, null]),
      ["fashion", "shoes"]
    );
    assert.deepStrictEqual(normalizeOnboardingCategoryIds("fashion"), []);
    assert.deepStrictEqual(normalizeOnboardingCategoryIds(null), []);
    const a = normalizeOnboardingCategoryIds(["shoes", "fashion", "home"]);
    const b = normalizeOnboardingCategoryIds(["home", "fashion", "shoes"]);
    assert.deepStrictEqual(a, b, "order-independent stable ids");
  }

  // -----------------------------------------------------------------------
  // Product candidate selection
  // -----------------------------------------------------------------------

  // 13. Selected-category preference.
  {
    const products = [
      product(1, { category: "hoodies" }), // fashion
      product(2, { category: "sneakers" }), // shoes
      product(3, { category: "unknown-thing" }),
    ];
    const picked = selectOnboardingCandidates({
      products,
      selectedCategoryIds: ["fashion"],
      count: 10,
    });
    assert.strictEqual(picked[0].id, UUID(1), "matching category first");
    assert.ok(picked.some((p) => p.id === UUID(1)));
  }

  // 14. Deterministic output.
  {
    const products = [
      product(1, { category: "hoodies" }),
      product(2, { category: "sneakers" }),
      product(3, { category: "jacket" }),
      product(4, { category: "boots" }),
      product(5, { category: "t-shirt" }),
      product(6, { category: "loafers" }),
    ];
    const args = { products, selectedCategoryIds: ["fashion", "shoes"], count: 6 };
    const a = selectOnboardingCandidates(args);
    const b = selectOnboardingCandidates({ ...args, products: [...products].reverse() });
    assert.deepStrictEqual(
      a.map((p) => p.id),
      b.map((p) => p.id),
      "input order must not affect output"
    );
  }

  // 15. Category diversity: one category cannot fill the grid while others exist.
  {
    const products = [
      ...[1, 2, 3, 4, 5, 6].map((n) => product(n, { category: "hoodies" })),
      product(7, { category: "sneakers" }),
      product(8, { category: "boots" }),
    ];
    const picked = selectOnboardingCandidates({
      products,
      selectedCategoryIds: ["fashion", "shoes"],
      count: 4,
    });
    const cats = picked.map((p) => p.category);
    assert.ok(cats.includes("sneakers") || cats.includes("boots"), "shoes represented");
    assert.ok(cats.includes("hoodies"), "fashion represented");
    // Round-robin: first two picks come from different buckets.
    assert.notStrictEqual(picked[0].category, picked[1].category);
  }

  // 16. Brand diversity where practical.
  {
    const products = [
      product(1, { category: "hoodies", brand: "SameBrand", created_at: "2026-09-09T00:00:00.000Z" }),
      product(2, { category: "jacket", brand: "SameBrand", created_at: "2026-09-08T00:00:00.000Z" }),
      product(3, { category: "t-shirt", brand: "OtherBrand", created_at: "2026-09-07T00:00:00.000Z" }),
    ];
    const picked = selectOnboardingCandidates({
      products,
      selectedCategoryIds: ["fashion"],
      count: 3,
    });
    // The second pick skips ahead in the bucket to avoid repeating the brand.
    assert.strictEqual(picked[0].brand, "SameBrand");
    assert.strictEqual(picked[1].brand, "OtherBrand", "a different brand is preferred next");
    assert.strictEqual(picked[2].brand, "SameBrand", "remaining products still returned");
  }

  // 17. Hidden products are excluded.
  {
    const products = [
      product(1, { category: "hoodies", moderation: { is_hidden: true } }),
      product(2, { category: "hoodies" }),
    ];
    const picked = selectOnboardingCandidates({
      products,
      selectedCategoryIds: ["fashion"],
      count: 10,
    });
    assert.ok(!picked.some((p) => p.id === UUID(1)));
    assert.ok(picked.some((p) => p.id === UUID(2)));
  }

  // 18. Missing/blank images are excluded.
  {
    const products = [
      product(1, { category: "hoodies", image_url: null }),
      product(2, { category: "hoodies", image_url: "   " }),
      product(3, { category: "hoodies" }),
    ];
    const picked = selectOnboardingCandidates({
      products,
      selectedCategoryIds: ["fashion"],
      count: 10,
    });
    assert.deepStrictEqual(picked.map((p) => p.id), [UUID(3)]);
  }

  // 19. Sparse fallback: fills from other categories; never fabricates.
  {
    const products = [
      product(1, { category: "hoodies" }),
      product(2, { category: "rare-collectible" }),
      product(3, { category: "rare-collectible" }),
    ];
    const picked = selectOnboardingCandidates({
      products,
      selectedCategoryIds: ["fashion"],
      count: 5,
    });
    assert.strictEqual(picked.length, 3, "only real eligible products returned");
    assert.strictEqual(picked[0].id, UUID(1), "match first, then stable fill");
  }

  // 20. Fake/demo/non-UUID products are never candidates.
  {
    const products = [
      { ...product(1), id: "demo-1" },
      { ...product(2), id: "not-a-uuid" },
      product(3, { category: "hoodies" }),
    ];
    const picked = selectOnboardingCandidates({
      products,
      selectedCategoryIds: ["fashion"],
      count: 10,
    });
    assert.deepStrictEqual(picked.map((p) => p.id), [UUID(3)]);
    assert.ok(isUuid(UUID(3)));
    assert.ok(!isUuid("demo-1"));
  }

  // 21. Duplicate product rows are eliminated.
  {
    const products = [
      product(1, { category: "hoodies" }),
      product(1, { category: "hoodies" }),
    ];
    const picked = selectOnboardingCandidates({
      products,
      selectedCategoryIds: ["fashion"],
      count: 10,
    });
    assert.strictEqual(picked.length, 1);
  }

  // -----------------------------------------------------------------------
  // Completion validation (client mirror of the RPC)
  // -----------------------------------------------------------------------

  const CATS = ["fashion", "shoes", "home"];
  const PIDS = [1, 2, 3, 4, 5].map(UUID);

  // 33a. Valid completion passes with normalized payload.
  {
    const v = validateOnboardingCompletion({
      categoryIds: ["Shoes", "fashion", "HOME", "shoes"],
      productIds: [...PIDS, PIDS[0]],
      availableProductCount: 10,
    });
    assert.ok(v.ok);
    assert.deepStrictEqual(v.categories, ["fashion", "home", "shoes"]);
    assert.strictEqual(v.productIds.length, 5, "duplicates removed");
  }

  // 39. Invalid category rejected (falls below the minimum after filtering).
  {
    const v = validateOnboardingCompletion({
      categoryIds: ["fashion", "shoes", "not-a-category"],
      productIds: PIDS,
      availableProductCount: 10,
    });
    assert.strictEqual(v.ok, false);
  }

  // 40. Nonexistent/fake product ids are dropped before the minimum check.
  {
    const v = validateOnboardingCompletion({
      categoryIds: CATS,
      productIds: ["demo-1", "nope", ...PIDS],
      availableProductCount: 10,
    });
    assert.ok(v.ok);
    assert.deepStrictEqual(v.productIds, [...PIDS].sort());
    const under = validateOnboardingCompletion({
      categoryIds: CATS,
      productIds: ["demo-1", ...PIDS.slice(0, 4)],
      availableProductCount: 10,
    });
    assert.strictEqual(under.ok, false, "fake ids never count toward the minimum");
  }

  // 41. Under-minimum completion rejected; sparse catalog relaxes the minimum.
  {
    const v = validateOnboardingCompletion({
      categoryIds: CATS,
      productIds: PIDS.slice(0, 4),
      availableProductCount: 10,
    });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(ONBOARDING_MIN_PRODUCT_SELECTIONS, 5);
    assert.strictEqual(requiredProductMinimum(10), 5);
    assert.strictEqual(requiredProductMinimum(3), 3, "sparse catalog: all available");
    assert.strictEqual(requiredProductMinimum(0), 0);
    const sparse = validateOnboardingCompletion({
      categoryIds: CATS,
      productIds: PIDS.slice(0, 3),
      availableProductCount: 3,
    });
    assert.ok(sparse.ok, "sparse catalog completion allowed with everything available");
  }

  // -----------------------------------------------------------------------
  // Event delta / idempotency (mirrors the RPC's semantics)
  // -----------------------------------------------------------------------

  // 33b + 34 + 35. First completion emits exactly the final state + complete.
  {
    const writes = computeOnboardingEventDelta({
      previouslyCommitted: null,
      finalCategories: CATS,
      finalProductIds: PIDS,
    });
    const byType = (t) => writes.filter((w) => w.event_type === t);
    assert.strictEqual(byType("onboarding_category_select").length, 3);
    assert.strictEqual(byType("onboarding_product_select").length, 5);
    assert.strictEqual(byType("onboarding_category_deselect").length, 0);
    assert.strictEqual(byType("onboarding_product_deselect").length, 0);
    assert.strictEqual(byType("onboarding_complete").length, 1);
  }

  // 36 + 37. Duplicate completion / network retry emits NOTHING.
  {
    const writes = computeOnboardingEventDelta({
      previouslyCommitted: { categories: CATS, productIds: PIDS },
      finalCategories: CATS,
      finalProductIds: PIDS,
    });
    assert.deepStrictEqual(writes, [], "retry with the same state inserts nothing");
  }

  // Changed selections emit select-for-added / deselect-for-removed only.
  {
    const writes = computeOnboardingEventDelta({
      previouslyCommitted: { categories: CATS, productIds: PIDS },
      finalCategories: ["fashion", "shoes", "beauty"],
      finalProductIds: [...PIDS.slice(1), UUID(99)],
    });
    const types = writes.map((w) => `${w.event_type}:${w.category ?? w.product_id}`);
    assert.deepStrictEqual(types, [
      "onboarding_category_select:beauty",
      "onboarding_category_deselect:home",
      `onboarding_product_select:${UUID(99)}`,
      `onboarding_product_deselect:${PIDS[0]}`,
    ]);
    // onboarding_complete fires exactly once (first completion only).
    assert.ok(!writes.some((w) => w.event_type === "onboarding_complete"));
  }

  // -----------------------------------------------------------------------
  // Migration SQL / security contract (static, offline)
  // -----------------------------------------------------------------------
  {
    const migration = fs.readFileSync(
      path.join(__dirname, "..", "supabase", "migrations", ONBOARDING_MIGRATION),
      "utf8"
    );

    // State table + RLS.
    assert.match(migration, /create table if not exists public\.user_taste_onboarding/);
    assert.match(migration, /alter table public\.user_taste_onboarding enable row level security/);
    assert.match(migration, /user_id uuid primary key references auth\.users \(id\) on delete cascade/);
    assert.match(migration, /check \(status in \('in_progress', 'completed'\)\)/);
    assert.match(migration, /check \(version >= 1\)/);

    // Own-row-only policies; no delete policy; no public access.
    assert.match(migration, /on public\.user_taste_onboarding\s+for select\s+to authenticated\s+using \(auth\.uid\(\) = user_id\)/);
    assert.match(migration, /on public\.user_taste_onboarding\s+for insert\s+to authenticated\s+with check \(auth\.uid\(\) = user_id\)/);
    assert.match(migration, /on public\.user_taste_onboarding\s+for update\s+to authenticated\s+using \(auth\.uid\(\) = user_id\)\s+with check \(auth\.uid\(\) = user_id\)/);
    assert.doesNotMatch(migration, /on public\.user_taste_onboarding\s+for delete/);
    assert.doesNotMatch(migration, /user_taste_onboarding[\s\S]{0,200}to anon/);

    // Rollout-safe eligibility marker: nullable, default NULL (existing
    // profiles are never retroactively marked). The migration must contain
    // NO backfill/update of historical profiles.
    assert.match(migration, /alter table public\.user_profiles\s+add column if not exists taste_onboarding_version integer/);
    assert.doesNotMatch(migration, /taste_onboarding_version integer (not null|default [^n])/i);
    assert.doesNotMatch(migration, /update public\.user_profiles/i, "no retroactive enrollment of existing profiles");

    // Durable enrollment lives on the auth lifecycle: an AFTER INSERT
    // trigger on auth.users marks ONLY future accounts. The trigger
    // function is hardened: emptied search_path, schema-qualified, cannot
    // fail signup, and is not callable by any client role.
    assert.match(migration, /create or replace function public\.enroll_taste_onboarding_version\(\)/);
    assert.match(migration, /create trigger trg_enroll_taste_onboarding_version\s+after insert on auth\.users/);
    assert.match(migration, /when others then/);
    assert.match(migration, /revoke all on function public\.enroll_taste_onboarding_version\(\) from public/);
    assert.match(migration, /revoke all on function public\.enroll_taste_onboarding_version\(\) from anon/);
    assert.match(migration, /revoke all on function public\.enroll_taste_onboarding_version\(\) from authenticated/);

    // Atomic completion RPC: invoker security, emptied search_path,
    // schema-qualified tables, strict auth validation, EXECUTE lockdown.
    assert.match(migration, /create or replace function public\.complete_taste_onboarding\(\s*p_user_id uuid,\s*p_categories jsonb,\s*p_product_ids jsonb\s*\)/);
    assert.match(migration, /security invoker/);
    assert.match(migration, /set search_path = ''/);
    assert.match(migration, /if auth\.uid\(\) is null then/);
    assert.match(migration, /p_user_id <> auth\.uid\(\)/);
    // Eligibility enforced server-side: a grandfathered/ineligible user
    // (marker NULL) cannot manufacture onboarding taste via a direct call.
    assert.match(migration, /not eligible for taste onboarding/);
    assert.match(migration, /pr\.taste_onboarding_version is not null/);
    // SECURITY DEFINER is used ONLY for the narrowly-scoped enrollment
    // trigger function (required for auth.users + placeholder upsert);
    // the completion RPC remains invoker-security.
    const definerCount = (
      migration.match(/language plpgsql\s+security definer/gi) || []
    ).length;
    assert.strictEqual(definerCount, 1, "only the enrollment trigger is SECURITY DEFINER");
    // Server-side validation: curated allowlist, UUID shape, existence,
    // minimums.
    assert.match(migration, /'accessories', 'automotive', 'beauty', 'electronics', 'fashion',\s*'fitness', 'home', 'outdoors', 'shoes', 'watches'/);
    assert.match(migration, /unknown product id/);
    assert.match(migration, /at least 3 categories are required/);
    assert.match(migration, /at least 5 products are required/);
    // Onboarding events are emitted by the RPC (the only writer).
    assert.match(migration, /'onboarding_category_select'/);
    assert.match(migration, /'onboarding_category_deselect'/);
    assert.match(migration, /'onboarding_product_select'/);
    assert.match(migration, /'onboarding_product_deselect'/);
    assert.match(migration, /'onboarding_complete'/);
    // The RPC never touches derived taste state.
    assert.doesNotMatch(migration, /complete_taste_onboarding[\s\S]{0,400}user_taste_affinities/);
    // Grants.
    assert.match(migration, /revoke execute on function public\.complete_taste_onboarding\(uuid, jsonb, jsonb\) from public/);
    assert.match(migration, /revoke execute on function public\.complete_taste_onboarding\(uuid, jsonb, jsonb\) from anon/);
    assert.match(migration, /grant execute on function public\.complete_taste_onboarding\(uuid, jsonb, jsonb\) to authenticated/);

    // PR #34 migration must remain untouched.
    const tasteMigration = fs.readFileSync(
      path.join(__dirname, "..", "supabase", "migrations", "20261001_add_taste_graph_foundation.sql"),
      "utf8"
    );
    assert.match(tasteMigration, /create table if not exists public\.taste_entities/);
  }

  console.log("taste-onboarding tests: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
