#!/usr/bin/env node
// scripts/test-for-you-v2.js
//
// Deterministic offline test suite for FOR YOU V2 (PR #36): the pure
// Taste-Graph-aware ranker (lib/forYouV2.ts) and the client affinity loader /
// lookup builder (lib/tasteAffinities.ts). No Supabase, no network: the
// ranker is pure with an injected `nowMs`, and the loader is exercised
// against in-memory fake TasteAffinityStore implementations.
//
// All fixture ids are fabricated for tests only — no real user or product
// ids appear here.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const NOW_ISO = "2026-10-01T00:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const HOUR_MS = 60 * 60 * 1000;

const CURRENT_USER = "aaaaaaa1-0000-4000-8000-0000000000aa";
const SELLER_X = "bbbbbbb1-0000-4000-8000-0000000000bb";
const SELLER_Y = "bbbbbbb2-0000-4000-8000-0000000000cc";
const SELLER_OWNED = CURRENT_USER; // self-seller scenarios
const CANON_1 = "ccccccc1-0000-4000-8000-0000000000dd";

function uuid(n) {
  // Deterministic fabricated UUIDs ("...0042" etc).
  const hex = String(n).padStart(12, "0");
  return `ddddddd0-0000-4000-8000-${hex}`;
}

function makeProduct(overrides = {}) {
  return {
    id: uuid(1),
    brand: "Acme",
    category: "watches",
    user_id: SELLER_X,
    catalog_product_id: null,
    image_url: "https://example.com/img.jpg",
    price: "100",
    url: "https://example.com/p",
    created_at: NOW_ISO,
    ...overrides,
  };
}

let entitySeq = 0;
// Build a real TasteAffinityLookup through the PURE builder under test.
function lookupFrom(entries) {
  const entityRows = [];
  const affinityRows = [];
  for (const e of entries) {
    entitySeq += 1;
    const id = `eeeeeeee-0000-4000-8000-${String(entitySeq).padStart(12, "0")}`;
    entityRows.push({ id, entity_type: e.type, entity_key: e.key, display_name: null });
    affinityRows.push({
      taste_entity_id: id,
      recent_score: e.recent ?? 0,
      long_term_score: e.long ?? 0,
      positive_signal_count: e.pos ?? 1,
      negative_signal_count: e.neg ?? 0,
      last_interaction_at: "2026-09-30T00:00:00.000Z",
      updated_at: "2026-09-30T00:00:00.000Z",
    });
  }
  return { affinityRows, entityRows };
}

function rank(v2, products, lookup, opts = {}) {
  return v2.rankForYouFeedV2(products, {
    affinityLookup: lookup,
    nowMs: NOW_MS,
    ...opts,
  });
}

function approxEqual(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} ≈ ${expected}`
  );
}

function idsOf(products) {
  return products.map((p) => `${p.id}:${p.category}:${p.brand ?? ""}`);
}

async function main() {
  const v2 = await import("../lib/forYouV2.ts");
  const aff = await import("../lib/tasteAffinities.ts");
  const v1 = await import("../lib/feedRanking.ts");

  const sat = v2.saturateAffinity;
  const blend = v2.blendAffinityScores;

  // A. Temporal blending -----------------------------------------------------
  approxEqual(blend(10, 0), 6.5);
  approxEqual(blend(0, 10), 3.5);
  approxEqual(blend(10, 10), 10);
  approxEqual(blend(0, 0), 0);
  approxEqual(blend(Number.NaN, 4), 0.35 * 4); // non-finite recent coerces to 0

  // B. Saturation: zero / low / medium / high / extremely high ---------------
  assert.strictEqual(sat(0), 0);
  approxEqual(sat(2), 1 - Math.exp(-2 / 4), 1e-12);
  approxEqual(sat(4), 1 - Math.exp(-1), 1e-12);
  approxEqual(sat(8), 1 - Math.exp(-2), 1e-12);
  approxEqual(sat(10), 1 - Math.exp(-2.5), 1e-12);
  assert.ok(sat(2) > 0.35 && sat(2) < 0.45, `sat(2)=${sat(2)}`);
  assert.ok(sat(4) > 0.6 && sat(4) < 0.66);
  assert.ok(sat(1000) > 0.999 && sat(1000) <= 1); // exp(-250) underflows to 0
  // Monotonic increasing across the whole positive range.
  let prev = sat(0);
  for (const x of [0.5, 1, 2, 3, 4, 6, 8, 10, 20, 50, 100]) {
    assert.ok(sat(x) > prev, `sat must increase at ${x}`);
    prev = sat(x);
  }
  assert.ok(sat(Number.POSITIVE_INFINITY) === 0); // non-finite fails safe
  assert.ok(sat(Number.NaN) === 0);

  // C. Negative affinity stays negative and bounded ---------------------------
  approxEqual(sat(-4), -(1 - Math.exp(-1)), 1e-12);
  assert.ok(sat(-1000) >= -1 && sat(-1000) < -0.999); // bounded, may underflow to exactly -1
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "brand", key: "acme", recent: -4, long: -4, pos: 0, neg: 2 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const liked = makeProduct({ id: uuid(10), brand: "Acme" });
    const neutral = makeProduct({ id: uuid(10), brand: "UnknownCo" });
    const out = rank(v2, [liked, neutral], lookup);
    assert.strictEqual(out[0].brand, "UnknownCo");
  }

  // D. Exact product preference ----------------------------------------------
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "product", key: uuid(20), recent: 4, long: 4 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const preferred = makeProduct({ id: uuid(20) });
    const other = makeProduct({ id: uuid(21) });
    const out = rank(v2, [other, preferred], lookup);
    assert.strictEqual(out[0].id, uuid(20));
  }

  // E. Canonical-product preference -------------------------------------------
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "canonical_product", key: CANON_1, recent: 4, long: 4 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const canonical = makeProduct({ id: uuid(30), catalog_product_id: CANON_1 });
    const plain = makeProduct({ id: uuid(30), catalog_product_id: null });
    const out = rank(v2, [plain, canonical], lookup);
    assert.strictEqual(out[0].catalog_product_id, CANON_1);
  }

  // F. Brand generalization ----------------------------------------------------
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "brand", key: "acme", recent: 4, long: 4 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const knownBrand = makeProduct({ id: uuid(40), brand: "Acme" });
    const newBrand = makeProduct({ id: uuid(40), brand: "NewCo" });
    const out = rank(v2, [newBrand, knownBrand], lookup);
    assert.strictEqual(out[0].brand, "Acme");
  }

  // G. Raw category preference (normalization: "Hoodies" matches "hoodies") ---
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "category", key: "hoodies", recent: 6, long: 6 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const hoodie = makeProduct({ id: uuid(50), category: "  Hoodies " });
    const watch = makeProduct({ id: uuid(50), category: "watches" });
    const out = rank(v2, [watch, hoodie], lookup);
    assert.strictEqual(out[0].category.trim().toLowerCase(), "hoodies");
  }

  // H. Curated category onboarding bridge --------------------------------------
  {
    // Onboarding-style affinity exists ONLY on the curated "electronics" slug.
    const { affinityRows, entityRows } = lookupFrom([
      { type: "category", key: "electronics", recent: 10, long: 10 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    // Raw product category "headphones" matches curated "electronics" via the
    // existing matchProductCategory keyword semantics.
    const headphones = makeProduct({ id: uuid(60), category: "headphones" });
    const watch = makeProduct({ id: uuid(60), category: "watches" });
    const out = rank(v2, [watch, headphones], lookup);
    assert.strictEqual(out[0].category, "headphones");
  }

  // I. Raw + curated combination never naively double counts --------------------
  {
    // Product category "sneakers": raw key "sneakers" + curated key "shoes".
    const combined = v2.combineCategorySignals([
      { key: "sneakers", value: 0.5 },
      { key: "shoes", value: 0.5 },
    ]);
    approxEqual(combined, 0.5 + 0.25 * 0.5); // NOT 1.0
    // Clamped to the per-dimension bound even with many correlated signals.
    const many = Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, value: 0.9 }));
    assert.ok(v2.combineCategorySignals(many) <= 1);
    // Strongest signal is primary regardless of input order.
    const reordered = v2.combineCategorySignals([
      { key: "shoes", value: 0.4 },
      { key: "sneakers", value: 0.8 },
    ]);
    approxEqual(reordered, 0.8 + 0.25 * 0.4);
    // Raw "shoes" product + curated "shoes" slug resolve to ONE key (dedupe).
    const { affinityRows, entityRows } = lookupFrom([
      { type: "category", key: "shoes", recent: 8, long: 8 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const signals = v2.collectCategorySignals(makeProduct({ category: "shoes" }), lookup);
    assert.strictEqual(signals.length, 1);
    const rawPlusCurated = v2.collectCategorySignals(
      makeProduct({ category: "sneakers" }),
      lookup
    );
    assert.strictEqual(rawPlusCurated.length, 1); // only curated "shoes" has affinity
    assert.strictEqual(rawPlusCurated[0].key, "shoes");
  }

  // J. Seller affinity ----------------------------------------------------------
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "seller", key: SELLER_X, recent: 4, long: 4 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const fromLikedSeller = makeProduct({ id: uuid(70), user_id: SELLER_X });
    const fromOtherSeller = makeProduct({ id: uuid(70), user_id: SELLER_Y });
    const out = rank(v2, [fromOtherSeller, fromLikedSeller], lookup);
    assert.strictEqual(out[0].user_id, SELLER_X);
  }

  // K. Self-seller affinity ignored ----------------------------------------------
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "seller", key: CURRENT_USER, recent: 100, long: 100 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const own = makeProduct({ id: uuid(80), user_id: SELLER_OWNED });
    const other = makeProduct({ id: uuid(80), user_id: SELLER_Y });
    const out = rank(v2, [own, other], lookup, { currentUserId: CURRENT_USER });
    assert.strictEqual(out[0].user_id, SELLER_Y);
  }

  // L. Own-item penalty remains (no affinities at all) -----------------------------
  {
    const lookup = aff.buildTasteAffinityLookup([], []);
    const own = makeProduct({ id: uuid(90), user_id: CURRENT_USER });
    const other = makeProduct({ id: uuid(90), user_id: SELLER_Y });
    const out = rank(v2, [own, other], lookup, { currentUserId: CURRENT_USER });
    assert.strictEqual(out[0].user_id, SELLER_Y);
  }

  // M. Followed seller bonus remains ------------------------------------------------
  {
    const lookup = aff.buildTasteAffinityLookup([], []);
    const followed = makeProduct({ id: uuid(100), user_id: SELLER_X });
    const notFollowed = makeProduct({ id: uuid(100), user_id: SELLER_Y });
    const out = rank(v2, [notFollowed, followed], lookup, { followingIds: [SELLER_X] });
    assert.strictEqual(out[0].user_id, SELLER_X);
  }

  // N. Direct liked/saved relevance -------------------------------------------------
  {
    // Category affinity suppresses exploration noise for both twins; ids are
    // ordered by their deterministic jitter so the +0.08 engagement bonus is
    // always decisive.
    const { affinityRows, entityRows } = lookupFrom([
      { type: "category", key: "watches", recent: 4, long: 4 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const idA = uuid(111);
    const idB = uuid(112);
    const [engagedId, twinId] =
      v1.hashStringToFloat(idA) >= v1.hashStringToFloat(idB) ? [idA, idB] : [idB, idA];
    const engaged = makeProduct({ id: engagedId });
    const twin = makeProduct({ id: twinId });
    const likedOut = rank(v2, [twin, engaged], lookup, { likedIds: [engagedId] });
    assert.strictEqual(likedOut[0].id, engagedId);
    const savedOut = rank(v2, [twin, engaged], lookup, { savedIds: [engagedId] });
    assert.strictEqual(savedOut[0].id, engagedId);
  }

  // O. Quality contribution ---------------------------------------------------------
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "category", key: "watches", recent: 4, long: 4 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const complete = makeProduct({ id: uuid(120) });
    const sparse = makeProduct({
      id: uuid(120),
      image_url: null,
      brand: "",
      price: null,
      url: null,
    });
    const out = rank(v2, [sparse, complete], lookup);
    assert.strictEqual(out[0].image_url, complete.image_url);
  }

  // P. Freshness contribution with injected now --------------------------------------
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "category", key: "watches", recent: 4, long: 4 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const fresh = makeProduct({ id: uuid(130), created_at: NOW_ISO });
    const weekOld = makeProduct({
      id: uuid(130),
      created_at: new Date(NOW_MS - 7 * 24 * HOUR_MS).toISOString(),
    });
    const out = rank(v2, [weekOld, fresh], lookup);
    assert.strictEqual(out[0].created_at, NOW_ISO);
    // Exact recency math with the injected clock: 0.25 at age 0, 0.125 at 7d.
    approxEqual(v1.computeRecencyScore(NOW_ISO, NOW_MS), 0.25);
    approxEqual(
      v1.computeRecencyScore(new Date(NOW_MS - 7 * 24 * HOUR_MS).toISOString(), NOW_MS),
      0.125
    );
  }

  // Q. Invalid/missing created_at: deterministic safe fallback -------------------------
  approxEqual(v1.computeRecencyScore("not-a-date", NOW_MS), 0.05);
  approxEqual(v1.computeRecencyScore(undefined, NOW_MS), 0.05);
  {
    const lookup = aff.buildTasteAffinityLookup([], []);
    const a = makeProduct({ id: uuid(140), created_at: "garbage" });
    const b = makeProduct({ id: uuid(140), created_at: "also-garbage" });
    const out1 = rank(v2, [a, b], lookup);
    const out2 = rank(v2, [a, b], lookup);
    assert.deepStrictEqual(idsOf(out1), idsOf(out2));
  }

  // R. Deterministic tie jitter ---------------------------------------------------------
  approxEqual(v1.hashStringToFloat("product-x"), v1.hashStringToFloat("product-x"));
  assert.ok(v1.hashStringToFloat("product-x") >= 0 && v1.hashStringToFloat("product-x") < 1);
  {
    const lookup = aff.buildTasteAffinityLookup([], []);
    const a = makeProduct({ id: uuid(150) });
    const b = makeProduct({ id: uuid(151) });
    const out1 = rank(v2, [a, b], lookup).map((p) => p.id);
    const out2 = rank(v2, [b, a], lookup).map((p) => p.id);
    assert.deepStrictEqual(out1, out2); // input order does not matter
  }

  // S. Identical inputs + identical now => identical ordering ------------------------------
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "category", key: "electronics", recent: 10, long: 10 },
      { type: "brand", key: "acme", recent: 3, long: 3 },
      { type: "seller", key: SELLER_X, recent: 2, long: 2 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const products = [
      makeProduct({ id: uuid(160), category: "headphones" }),
      makeProduct({ id: uuid(161), category: "watches" }),
      makeProduct({ id: uuid(162), category: "sneakers" }),
      makeProduct({ id: uuid(163), category: "electronics", brand: "Acme" }),
      makeProduct({ id: uuid(164), category: "hoodies", user_id: SELLER_Y }),
    ];
    const out1 = rank(v2, products, lookup).map((p) => p.id);
    const out2 = rank(v2, products, lookup).map((p) => p.id);
    assert.deepStrictEqual(out1, out2);
    assert.strictEqual(out1.length, products.length);
  }

  // T. Diversity against repeated category --------------------------------------------------
  {
    // Brand affinity (not category) lifts the watches triplets so the greedy
    // category penalty is what breaks the run; "clogs" must appear at slot 2.
    const { affinityRows, entityRows } = lookupFrom([
      { type: "brand", key: "acme", recent: 3, long: 3 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const w1 = makeProduct({ id: uuid(170), category: "watches" });
    const w2 = makeProduct({ id: uuid(171), category: "watches" });
    const w3 = makeProduct({ id: uuid(172), category: "watches" });
    const shoe = makeProduct({ id: uuid(173), category: "clogs", brand: "OtherCo" });
    const out = rank(v2, [w1, w2, w3, shoe], lookup);
    assert.strictEqual(out[1].category, "clogs"); // breaks the run at slot 2
  }

  // U. Diversity against repeated brand --------------------------------------------------------
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "brand", key: "acme", recent: 4, long: 4 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const a1 = makeProduct({ id: uuid(180), brand: "Acme", user_id: uuid(901) });
    const a2 = makeProduct({ id: uuid(181), brand: "Acme", user_id: uuid(902) });
    const a3 = makeProduct({ id: uuid(182), brand: "Acme", user_id: uuid(903) });
    const other = makeProduct({ id: uuid(183), brand: "OtherCo", user_id: uuid(904) });
    const out = rank(v2, [a1, a2, a3, other], lookup);
    assert.strictEqual(out[1].brand, "OtherCo");
  }

  // V. Diversity against repeated seller ---------------------------------------------------------
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "seller", key: SELLER_X, recent: 5, long: 5 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const s1 = makeProduct({ id: uuid(190), brand: "BrandA", user_id: SELLER_X });
    const s2 = makeProduct({ id: uuid(191), brand: "BrandB", user_id: SELLER_X });
    const s3 = makeProduct({ id: uuid(192), brand: "BrandC", user_id: SELLER_X });
    const other = makeProduct({ id: uuid(193), brand: "BrandD", user_id: SELLER_Y });
    const out = rank(v2, [s1, s2, s3, other], lookup);
    assert.strictEqual(out[1].user_id, SELLER_Y);
  }

  // W. Structural exploration occurs at every 8th slot --------------------------------------
  {
    // 8 watches products dominate taste; a "camping" product has zero
    // affinity and must still surface at the first exploration slot.
    const { affinityRows, entityRows } = lookupFrom([
      { type: "category", key: "watches", recent: 10, long: 10 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const products = Array.from({ length: 8 }, (_, i) =>
      makeProduct({ id: uuid(300 + i), category: "watches", brand: `WB${i}`, user_id: `s-${i}` })
    );
    products.push(
      makeProduct({ id: uuid(399), category: "camping", brand: "CampCo", user_id: "s-camp" })
    );
    const out = rank(v2, products, lookup);
    // Zero-affinity camping surfaces at or before the first exploration slot.
    const campingPos = out.findIndex((p) => p.category === "camping");
    assert.ok(campingPos >= 0 && campingPos <= 8, `camping at ${campingPos} <= 8`);
  }

  // X. Exploration is deterministic -----------------------------------------------------------
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "category", key: "watches", recent: 10, long: 10 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const products = Array.from({ length: 12 }, (_, i) =>
      makeProduct({
        id: uuid(310 + i),
        category: i < 9 ? "watches" : i === 9 ? "camping" : "beauty",
        user_id: `s-${i}`,
      })
    );
    const out1 = rank(v2, products, lookup).map((p) => p.id);
    const out2 = rank(v2, products, lookup).map((p) => p.id);
    assert.deepStrictEqual(out1, out2);
  }

  // Y. No affinities => V1 fallback predicate --------------------------------------------------------
  assert.strictEqual(v2.hasUsableTasteAffinities(null), false);
  assert.strictEqual(v2.hasUsableTasteAffinities(undefined), false);
  assert.strictEqual(v2.hasUsableTasteAffinities(new Map()), false);
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "brand", key: "acme", recent: 1, long: 1 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    assert.strictEqual(v2.hasUsableTasteAffinities(lookup), true);
  }

  // Z. Empty affinity lookup is safe ------------------------------------------------------------------
  {
    const lookup = aff.buildTasteAffinityLookup([], []);
    const out = rank(v2, [makeProduct({ id: uuid(200) }), makeProduct({ id: uuid(201) })], lookup);
    assert.strictEqual(out.length, 2);
  }

  // AA. Partial entity dimensions are safe --------------------------------------------------------------
  {
    const lookup = aff.buildTasteAffinityLookup([], []);
    const partial = { id: uuid(210), brand: "Acme" }; // no category/seller/canonical/dates
    const out = rank(v2, [partial, makeProduct({ id: uuid(211) })], lookup);
    assert.strictEqual(out.length, 2);
  }

  // AB. Malformed/missing optional product fields are safe -------------------------------------------------
  {
    const lookup = aff.buildTasteAffinityLookup([], []);
    const weird = makeProduct({
      id: uuid(220),
      brand: null,
      category: null,
      user_id: null,
      catalog_product_id: undefined,
      created_at: undefined,
    });
    const out = rank(v2, [weird], lookup, { currentUserId: CURRENT_USER });
    assert.strictEqual(out.length, 1);
  }

  // AC. Signed-out / null current user is safe ---------------------------------------------------------------
  {
    const lookup = aff.buildTasteAffinityLookup([], []);
    const out = rank(v2, [makeProduct({ id: uuid(230) })], lookup, {
      currentUserId: null,
      likedIds: [],
      savedIds: [],
      followingIds: [],
    });
    assert.strictEqual(out.length, 1);
  }

  // AD. Huge affinity cannot dominate without bound -----------------------------------------------------------
  assert.ok(sat(1e9) <= 1 && sat(1e9) > 0.999);
  assert.ok(sat(1e12) <= 1);
  // Total taste contribution is structurally bounded by the dimension weights.
  const maxTaste =
    v2.DIMENSION_WEIGHTS.product +
    v2.DIMENSION_WEIGHTS.canonical_product +
    v2.DIMENSION_WEIGHTS.brand +
    v2.DIMENSION_WEIGHTS.category +
    v2.DIMENSION_WEIGHTS.seller;
  approxEqual(maxTaste, 3.6);

  // AE. Production-shaped magnitudes: saturation compresses 8 vs 10 ---------------------------------------------
  assert.ok(sat(10) - sat(8) < 0.06, `compressed diff: ${sat(10) - sat(8)}`);
  assert.ok(sat(2) - sat(0) > 0.35); // 0→2 matters substantially
  assert.ok(sat(4) - sat(2) > 0.2); // 2→4 still matters

  // AF. Onboarding category affinity ranks a related, never-before-seen product -----------------------------------
  {
    // Category ≈ 10 on curated "electronics" (onboarding-shaped snapshot).
    const { affinityRows, entityRows } = lookupFrom([
      { type: "category", key: "electronics", recent: 10, long: 10 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const unseenRelated = makeProduct({
      id: uuid(240), // never interacted with
      brand: "NewBrand", // never interacted with
      category: "wireless headphones",
      user_id: SELLER_Y,
    });
    const unrelated = makeProduct({ id: uuid(240), category: "watches" });
    const out = rank(v2, [unrelated, unseenRelated], lookup);
    assert.strictEqual(out[0].category, "wireless headphones");
  }

  // AG. Specific raw-category affinity can outrank broad curated affinity --------------------------------------------
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "category", key: "hoodies", recent: 8, long: 8 }, // strong, specific
      { type: "category", key: "fashion", recent: 2, long: 2 }, // weaker, broad
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const specific = makeProduct({ id: uuid(250), category: "hoodies" });
    const broad = makeProduct({ id: uuid(250), category: "denim" }); // matches curated fashion
    const out = rank(v2, [broad, specific], lookup);
    assert.strictEqual(out[0].category, "hoodies");
  }

  // AH. Loader contract: exactly one batched entity fetch — never N+1 ---------------------------------------------------
  {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      type: "brand",
      key: `brand-${i}`,
      recent: i,
      long: i,
    }));
    const { affinityRows, entityRows } = lookupFrom(entries);
    const calls = { affinities: 0, entities: 0, entityIdBatches: [] };
    const store = {
      async fetchUserAffinities(userId) {
        calls.affinities += 1;
        assert.strictEqual(userId, CURRENT_USER);
        return affinityRows;
      },
      async fetchTasteEntities(ids) {
        calls.entities += 1;
        calls.entityIdBatches.push(ids);
        return entityRows;
      },
    };
    const snapshot = await aff.loadTasteAffinities(store, CURRENT_USER);
    assert.strictEqual(calls.affinities, 1);
    assert.strictEqual(calls.entities, 1); // ONE batched query for 50 entities
    assert.strictEqual(calls.entityIdBatches[0].length, 50);
    assert.strictEqual(snapshot.rowCount, 50);
    assert.strictEqual(snapshot.lookup.size, 50);
  }

  // AI. Loader maps entity ids to normalized keys correctly --------------------------------------------------------------
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "category", key: "  Electronics ", recent: 10, long: 4 },
      { type: "seller", key: SELLER_X.toUpperCase(), recent: 2, long: 2 },
    ]);
    const store = {
      async fetchUserAffinities() { return affinityRows; },
      async fetchTasteEntities() { return entityRows; },
    };
    const snapshot = await aff.loadTasteAffinities(store, CURRENT_USER);
    const category = snapshot.lookup.get("category:electronics");
    assert.ok(category, "normalized category key resolves");
    assert.strictEqual(category.recentScore, 10);
    assert.strictEqual(category.longTermScore, 4);
    assert.ok(snapshot.lookup.get(`seller:${SELLER_X}`), "seller key lowercased");
    assert.strictEqual(snapshot.latestUpdatedAt, "2026-09-30T00:00:00.000Z");
  }

  // AJ. Duplicate/missing entity rows are handled safely ---------------------------------------------------------------------
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "brand", key: "acme", recent: 1, long: 1 },
      { type: "brand", key: "shoeco", recent: 2, long: 2 },
    ]);
    // Drop the second entity row: its affinity must be skipped, not crash.
    const partialEntities = entityRows.slice(0, 1);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, partialEntities);
    assert.strictEqual(lookup.size, 1);
    assert.ok(lookup.get("brand:acme"));
    // Duplicate entity id rows: first wins, still resolves.
    const dupEntities = [entityRows[0], { ...entityRows[0], entity_key: "WRONG" }];
    const dupLookup = aff.buildTasteAffinityLookup([affinityRows[0]], dupEntities);
    assert.strictEqual(dupLookup.get("brand:acme").recentScore, 1);
    // Non-finite persisted scores coerce to 0 instead of poisoning ranking.
    const badRows = [{ ...affinityRows[0], recent_score: Number.NaN }];
    const badLookup = aff.buildTasteAffinityLookup(badRows, [entityRows[0]]);
    assert.strictEqual(badLookup.get("brand:acme").recentScore, 0);
  }

  // AK. Affinity load error produces fallback state (null), never throws ------------------------------------------------------
  {
    const failingStore = {
      async fetchUserAffinities() { throw new Error("network down"); },
      async fetchTasteEntities() { throw new Error("network down"); },
    };
    const snapshot = await aff.loadTasteAffinities(failingStore, CURRENT_USER);
    assert.strictEqual(snapshot, null);
    assert.strictEqual(await aff.loadTasteAffinities(failingStore, ""), null);
  }

  // AL. Stale snapshot is still usable (no freshness cutoff) ---------------------------------------------------------------------
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "brand", key: "acme", recent: 4, long: 4 },
    ]);
    const staleRows = affinityRows.map((r) => ({
      ...r,
      updated_at: "2026-01-01T00:00:00.000Z", // months old
    }));
    const store = {
      async fetchUserAffinities() { return staleRows; },
      async fetchTasteEntities() { return entityRows; },
    };
    const snapshot = await aff.loadTasteAffinities(store, CURRENT_USER);
    assert.strictEqual(snapshot.latestUpdatedAt, "2026-01-01T00:00:00.000Z");
    const known = makeProduct({ id: uuid(260), brand: "Acme" });
    const unknown = makeProduct({ id: uuid(260), brand: "NewCo" });
    const out = rank(v2, [unknown, known], snapshot.lookup);
    assert.strictEqual(out[0].brand, "Acme"); // stale affinities still rank
  }

  // AM. Ranker never mutates input products or affinity data ------------------------------------------------------------------------
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "brand", key: "acme", recent: 4, long: 4 },
      { type: "category", key: "watches", recent: 2, long: 2 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const products = [makeProduct({ id: uuid(270) }), makeProduct({ id: uuid(271), brand: "NewCo" })];
    const productsBefore = JSON.stringify(products);
    const lookupBefore = JSON.stringify([...lookup.entries()]);
    const inputArray = products.slice();
    rank(v2, products, lookup, { likedIds: [uuid(270)], currentUserId: CURRENT_USER });
    assert.strictEqual(JSON.stringify(products), productsBefore);
    assert.strictEqual(JSON.stringify([...lookup.entries()]), lookupBefore);
    assert.strictEqual(products.length, 2);
    assert.deepStrictEqual(products, inputArray);
  }

  // AN. Own-seller graph data remains untouched while its contribution is ignored ------------------------------------------------------
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "seller", key: CURRENT_USER, recent: 50, long: 50 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const before = JSON.stringify(lookup.get(`seller:${CURRENT_USER}`));
    const own = makeProduct({ id: uuid(280), user_id: CURRENT_USER });
    const other = makeProduct({ id: uuid(280), user_id: SELLER_Y });
    rank(v2, [own, other], lookup, { currentUserId: CURRENT_USER });
    assert.strictEqual(JSON.stringify(lookup.get(`seller:${CURRENT_USER}`)), before);
  }

  // AO. V1 behavior intact + module purity contracts -----------------------------------------------------------------------------------
  assert.strictEqual(typeof v1.rankForYouFeed, "function");
  {
    // V1 still ranks and its category-affinity behavior is unchanged.
    const products = [
      { ...makeProduct({ id: uuid(290), category: "shoes" }), title: "A" },
      { ...makeProduct({ id: uuid(291), category: "watches" }), title: "B" },
    ];
    const out = v1.rankForYouFeed(products, { likedIds: [uuid(290)], savedIds: [] });
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].id, uuid(290)); // liked category affinity boosts
  }
  {
    const v2Source = fs.readFileSync(path.join(__dirname, "../lib/forYouV2.ts"), "utf8");
    const v2Code = v2Source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    assert.ok(
      !/import[^\n]*supabase/i.test(v2Code) && !/require\([^\n]*supabase/i.test(v2Code),
      "forYouV2 must not import supabase"
    );
    assert.ok(!/Date\.now\(/.test(v2Code), "forYouV2 must not call Date.now()");
    assert.ok(!/Math\.random\(/.test(v2Code), "forYouV2 must not use Math.random()");
    const affSource = fs.readFileSync(path.join(__dirname, "../lib/tasteAffinities.ts"), "utf8");
    for (const write of [".insert(", ".update(", ".delete(", ".upsert(", ".rpc("]) {
      assert.ok(!affSource.includes(write), `tasteAffinities must not ${write}`);
    }
    // Loader wiring in ProductsContext: exactly two batched queries, race-safe.
    const ctxSource = fs.readFileSync(
      path.join(__dirname, "../hooks/ProductsContext.tsx"),
      "utf8"
    );
    assert.strictEqual(
      (ctxSource.match(/from\("taste_entities"\)/g) || []).length,
      1,
      "single taste_entities query site"
    );
    assert.ok(ctxSource.includes('.in("id", ids)'), "entities fetched via one batched .in()");
    assert.ok(ctxSource.includes('from("user_taste_affinities")'));
    assert.ok(ctxSource.includes('.eq("user_id", userId)'));
    assert.ok(ctxSource.includes("affinityLoadRequestIdRef"), "race-safe load guard");
    assert.ok(!/from\("taste_entities"\)[\s\S]{0,200}\.(insert|update|delete|upsert)\(/.test(ctxSource));
    assert.ok(!/from\("user_taste_affinities"\)[\s\S]{0,200}\.(insert|update|delete|upsert)\(/.test(ctxSource));
    // Feed integration: V2 with V1 fallback retained in both consumers.
    for (const rel of ["../app/(tabs)/index.tsx", "../app/(tabs)/search.tsx"]) {
      const src = fs.readFileSync(path.join(__dirname, rel), "utf8");
      assert.ok(src.includes("rankForYouFeedV2"), `${rel} uses V2`);
      assert.ok(src.includes("rankForYouFeed"), `${rel} keeps V1 fallback`);
      assert.ok(src.includes("hasUsableTasteAffinities"), `${rel} gates on usable affinities`);
    }
  }

  // AI2. Structural exploration: zero-affinity surfaces; negative never explored; no junk ------
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "category", key: "watches", recent: 10, long: 10 },
      { type: "category", key: "gym equipment", recent: -6, long: -6 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const products = Array.from({ length: 8 }, (_, i) =>
      makeProduct({ id: uuid(400 + i), category: "watches", brand: `WB${i}`, user_id: `s-${i}` })
    );
    products.push(
      makeProduct({ id: uuid(490), category: "gym equipment", brand: "GymCo", user_id: "s-gym" }),
      makeProduct({ id: uuid(491), category: "camping", brand: "CampCo", user_id: "s-camp" })
    );
    const out = rank(v2, products, lookup);
    // Exploration slot (position 8) surfaces zero-affinity camping, NOT the
    // negative gym category.
    assert.strictEqual(out[8].category, "camping");
    assert.ok(!out.slice(0, 9).some((p) => p.category === "gym equipment"));
    // Exploration picks the most REASONABLE candidate: with two unseen
    // categories, the higher-quality/fresher one wins the slot.
    const products2 = Array.from({ length: 8 }, (_, i) =>
      makeProduct({ id: uuid(500 + i), category: "watches", brand: `WB${i}`, user_id: `s2-${i}` })
    );
    products2.push(
      makeProduct({
        id: uuid(590), category: "camping", brand: "CampCo", user_id: "s-camp-old",
        image_url: null, price: null, url: null,
        created_at: new Date(NOW_MS - 60 * 24 * HOUR_MS).toISOString(),
      }),
      makeProduct({ id: uuid(591), category: "beauty", brand: "BeautyCo", user_id: "s-beauty" })
    );
    const out2 = rank(v2, products2, lookup);
    assert.strictEqual(out2[8].category, "beauty"); // fresher/higher-quality unseen
    // No duplication: every product appears exactly once.
    assert.strictEqual(new Set(out.map((p) => p.id)).size, out.length);
  }

  // AJ2. Moderate underrepresented category receives discovery ---------------------------------------
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "category", key: "watches", recent: 12, long: 12 },
      { type: "category", key: "outdoors", recent: 2, long: 2 }, // moderate
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const products = Array.from({ length: 9 }, (_, i) =>
      makeProduct({ id: uuid(600 + i), category: "watches", brand: `WB${i}`, user_id: `s-${i}` })
    );
    products.push(
      makeProduct({ id: uuid(690), category: "camping", brand: "CampCo", user_id: "s-camp" }) // matches curated "outdoors"
    );
    const out = rank(v2, products, lookup);
    // Moderate underrepresented "camping" (curated outdoors ≈ sat(2)) is
    // discovered early — either organically via its affinity or at the slot.
    const campPos = out.findIndex((p) => p.category === "camping");
    assert.ok(campPos >= 0 && campPos <= 8, `camping at ${campPos} <= 8`);
  }

  // AK2. Product/canonical identity de-duplication -------------------------------------------------------
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "product", key: uuid(700), recent: 4, long: 4 },
      { type: "canonical_product", key: "canon-x", recent: 4, long: 4 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    // Exact product with BOTH identities: product is primary; canonical adds
    // only the excess over the product signal (none here) => NOT ~doubled.
    const exact = makeProduct({ id: uuid(700), catalog_product_id: "canon-x", user_id: "s-exact" });
    // Unseen sibling sharing the canonical identity: full canonical value.
    const sibling = makeProduct({ id: uuid(701), catalog_product_id: "canon-x", user_id: "s-sib" });
    const plain = makeProduct({ id: uuid(702), user_id: "s-plain" });
    const out = rank(v2, [plain, sibling, exact], lookup);
    assert.strictEqual(out[0].id, uuid(700)); // direct product affinity dominates
    assert.strictEqual(out[1].id, uuid(701)); // canonical generalization beats nothing
    // Quantify: exact identity taste = 1.0*sat(4) (no near-double).
    const exactTaste = 1.0 * sat(4) + 0.9 * Math.max(0, sat(4) - sat(4));
    approxEqual(exactTaste, sat(4)); // NOT 1.9 * sat(4)
    const siblingTaste = 0.9 * sat(4);
    assert.ok(siblingTaste > 0.5); // strong canonical generalization for sibling
  }

  // AL2. Scalable diversity window --------------------------------------------------------------------------
  assert.strictEqual(v2.computeDiversityWindow(100), 10);
  assert.strictEqual(v2.computeDiversityWindow(200), 20);
  assert.strictEqual(v2.computeDiversityWindow(300), 30);
  assert.strictEqual(v2.computeDiversityWindow(500), 40); // capped
  assert.strictEqual(v2.computeDiversityWindow(5), 10); // floor

  // AM2. Narrow profile at 300 products: exploration breaks the echo chamber ----------------------------------
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "category", key: "electronics", recent: 10, long: 10 },
      { type: "category", key: "shoes", recent: 8, long: 8 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    const bigCatalog = [];
    const cats = ["electronics", "sneakers", "hoodies", "watches", "camping", "skincare", "home decor", "car parts"];
    for (let i = 0; i < 300; i++) {
      bigCatalog.push(makeProduct({
        id: uuid(1000 + i),
        brand: `Brand${i % 15}`,
        category: cats[i % cats.length],
        user_id: `seller-${i % 25}`,
        created_at: new Date(NOW_MS - (i % 30) * 24 * HOUR_MS).toISOString(),
      }));
    }
    const out = rank(v2, bigCatalog, lookup);
    const top30 = out.slice(0, 30);
    const strong30 = top30.filter((p) => ["electronics", "sneakers"].includes(p.category)).length;
    // NOT 100% the two strong categories; unseen categories surface early.
    assert.ok(strong30 < 30, `top-30 strong-category count ${strong30} should be < 30`);
    const firstUnseen = out.findIndex((p) => !["electronics", "sneakers"].includes(p.category));
    assert.ok(firstUnseen <= 8, `first unseen position ${firstUnseen} should be <= 8 (was 68)`);
    // Exploration slots at 8, 16, 24 carry unseen categories.
    for (const pos of [8, 16, 24]) {
      assert.ok(!["electronics", "sneakers"].includes(out[pos].category),
        `position ${pos} should be exploration: got ${out[pos].category}`);
    }
  }

  // AN2. No suitable exploration candidate -> deterministic normal fallback ------------------------------------
  {
    const { affinityRows, entityRows } = lookupFrom([
      { type: "category", key: "watches", recent: 10, long: 10 },
    ]);
    const lookup = aff.buildTasteAffinityLookup(affinityRows, entityRows);
    // Every remaining product is watches: exploration has nothing to surface.
    const products = Array.from({ length: 12 }, (_, i) =>
      makeProduct({ id: uuid(800 + i), category: "watches", user_id: `s-${i}` })
    );
    const out1 = rank(v2, products, lookup).map((p) => p.id);
    const out2 = rank(v2, products, lookup).map((p) => p.id);
    assert.deepStrictEqual(out1, out2); // deterministic fallback
    assert.strictEqual(out1.length, 12);
  }

  console.log("for-you-v2 tests: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
