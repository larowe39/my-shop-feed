#!/usr/bin/env node
// scripts/test-taste-graph.js
//
// Deterministic offline test suite for the Taste Graph foundation (PR #34).
// No Supabase, no network: the engine is pure and the rebuild path is
// exercised against an in-memory fake TasteGraphStore.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const AS_OF = "2026-10-01T00:00:00.000Z";
const AS_OF_MS = Date.parse(AS_OF);
const DAY_MS = 24 * 60 * 60 * 1000;

const P1 = "11111111-1111-1111-1111-111111111111"; // watch product
const P2 = "22222222-2222-2222-2222-222222222222"; // shoe product
const P3 = "33333333-3333-3333-3333-333333333333"; // deleted/missing product
const C1 = "44444444-4444-4444-4444-444444444444"; // canonical watch
const S1 = "55555555-5555-5555-5555-555555555555"; // watch seller
const S2 = "66666666-6666-6666-6666-666666666666"; // shoe seller
const USER_A = "77777777-7777-7777-7777-777777777777";
const USER_B = "88888888-8888-8888-8888-888888888888";

const PRODUCTS = [
  {
    id: P1,
    title: "Vintage Chronograph Watch",
    brand: "Acme Watches",
    category: "watches",
    user_id: S1,
    catalog_product_id: C1,
  },
  {
    id: P2,
    title: "Trail Runner Shoes",
    brand: "ShoeCo",
    category: "shoes",
    user_id: S2,
    catalog_product_id: null,
  },
  // P3 intentionally absent: simulates a deleted/unresolvable product.
];

function iso(offsetMs = 0) {
  return new Date(AS_OF_MS + offsetMs).toISOString();
}

let eventSeq = 0;
function evt(eventType, overrides = {}) {
  eventSeq += 1;
  return {
    id: overrides.id ?? `event-${String(eventSeq).padStart(4, "0")}`,
    user_id: overrides.user_id ?? USER_A,
    session_id: "session-test",
    event_type: eventType,
    product_id: overrides.product_id ?? null,
    seller_id: overrides.seller_id ?? null,
    category: overrides.category ?? null,
    metadata: overrides.metadata ?? {},
    created_at: overrides.created_at ?? iso(),
  };
}

function approxEqual(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ~${expected}, got ${actual}`
  );
}

function findAffinity(snapshot, entityType, entityKey) {
  return snapshot.affinities.find(
    (row) => row.entity_type === entityType && row.entity_key === entityKey
  );
}

// In-memory TasteGraphStore fake. Deterministic entity ids, write counters
// for dry-run assertions, and per-user affinity rows keyed like the real
// (user_id, taste_entity_id) primary key.
class FakeTasteGraphStore {
  constructor({ events = [], products = [] } = {}) {
    this.events = events;
    this.products = products;
    this.entities = new Map(); // type:key -> { id, entity_type, entity_key, ... }
    this.affinities = new Map(); // userId:tasteEntityId -> row
    this.writeCounts = { entities: 0, affinities: 0, deletes: 0 };
  }

  async fetchUserEvents(userId) {
    return this.events.filter((event) => event.user_id === userId);
  }

  async fetchProductContext(productIds) {
    const wanted = new Set(productIds);
    return this.products.filter((product) => wanted.has(product.id));
  }

  async upsertTasteEntities(rows) {
    this.writeCounts.entities += rows.length;
    return rows.map((row) => {
      const key = `${row.entity_type}:${row.entity_key}`;
      const existing = this.entities.get(key);
      if (existing) {
        this.entities.set(key, { ...existing, ...row, id: existing.id });
        return this.entities.get(key);
      }
      const persisted = { ...row, id: `entity-${key}` };
      this.entities.set(key, persisted);
      return persisted;
    });
  }

  async fetchUserAffinityEntityIds(userId) {
    const prefix = `${userId}:`;
    return [...this.affinities.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => this.affinities.get(key).taste_entity_id);
  }

  async upsertUserAffinities(rows) {
    this.writeCounts.affinities += rows.length;
    for (const row of rows) {
      this.affinities.set(`${row.user_id}:${row.taste_entity_id}`, { ...row });
    }
  }

  async deleteUserAffinitiesNotIn(userId, keepTasteEntityIds) {
    const keep = new Set(keepTasteEntityIds);
    const prefix = `${userId}:`;
    let deleted = 0;
    for (const [key, row] of [...this.affinities.entries()]) {
      if (key.startsWith(prefix) && !keep.has(row.taste_entity_id)) {
        this.affinities.delete(key);
        deleted += 1;
      }
    }
    this.writeCounts.deletes += deleted;
    return deleted;
  }

  affinityRowsFor(userId) {
    const prefix = `${userId}:`;
    return [...this.affinities.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, row]) => row)
      .sort((a, b) =>
        a.taste_entity_id < b.taste_entity_id ? -1 : 1
      );
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const signals = await import("../lib/tasteSignals.ts");
  const graph = await import("../lib/tasteGraph.ts");
  const rebuild = await import("../lib/tasteGraphRebuild.ts");

  const {
    normalizeEntityKey,
    entityDisplayName,
    isMeaningfulDwell,
    getSignalDefinition,
    decayFactor,
    TASTE_WEIGHTS,
    PROPAGATION_MULTIPLIERS,
    DWELL_MEANINGFUL_THRESHOLD_MS,
    RECENT_SCORE_HALF_LIFE_DAYS,
  } = signals;
  const { buildProductContextMap, buildTasteSnapshot } = graph;
  const { rebuildUserTasteGraph, formatSnapshotTable } = rebuild;

  const CONTEXT = buildProductContextMap(PRODUCTS);
  const snap = (events, options = {}) =>
    buildTasteSnapshot(events, {
      asOf: options.asOf ?? AS_OF,
      productContext: options.productContext ?? CONTEXT,
    });

  // 1. Entity normalization ---------------------------------------------
  assert.strictEqual(normalizeEntityKey("brand", "  Acme   Watches "), "acme watches");
  assert.strictEqual(normalizeEntityKey("brand", "ACME WATCHES"), "acme watches");
  assert.strictEqual(normalizeEntityKey("category", "Watches\t\n Shoes"), "watches shoes");
  assert.strictEqual(normalizeEntityKey("brand", "   "), null);
  assert.strictEqual(normalizeEntityKey("brand", ""), null);
  assert.strictEqual(normalizeEntityKey("brand", null), null);
  assert.strictEqual(normalizeEntityKey("brand", 42), null);
  assert.strictEqual(normalizeEntityKey("product", P1.toUpperCase()), P1);
  // Deterministic: same semantics -> same key, every time.
  assert.strictEqual(
    normalizeEntityKey("brand", "Acme Watches"),
    normalizeEntityKey("brand", "acme  watches")
  );
  // Distinct brands never merge.
  assert.notStrictEqual(
    normalizeEntityKey("brand", "Acme Watches"),
    normalizeEntityKey("brand", "Acme Watch")
  );
  // display_name preserves trimmed original casing, separate from identity.
  assert.strictEqual(entityDisplayName("  Acme   Watches "), "Acme Watches");
  assert.strictEqual(entityDisplayName("   "), null);

  // 2. product_open weak positive ----------------------------------------
  {
    const s = snap([evt("product_open", { product_id: P1 })]);
    const product = findAffinity(s, "product", P1);
    assert.ok(product, "open creates product affinity");
    approxEqual(product.long_term_score, TASTE_WEIGHTS.productOpen);
    approxEqual(product.recent_score, TASTE_WEIGHTS.productOpen);
    assert.strictEqual(product.positive_signal_count, 1);
  }

  // 3. product_like strong positive (> open) ------------------------------
  {
    const s = snap([evt("product_like", { product_id: P1 })]);
    approxEqual(findAffinity(s, "product", P1).long_term_score, TASTE_WEIGHTS.productLike);
    assert.ok(TASTE_WEIGHTS.productLike > TASTE_WEIGHTS.productOpen);
  }

  // 4. product_save stronger than like ------------------------------------
  assert.ok(TASTE_WEIGHTS.productSave > TASTE_WEIGHTS.productLike);

  // 5. shop_click strong purchase-intent (> save) --------------------------
  {
    assert.ok(TASTE_WEIGHTS.shopClick >= TASTE_WEIGHTS.productSave);
    const s = snap([evt("shop_click", { product_id: P1 })]);
    approxEqual(findAffinity(s, "product", P1).long_term_score, TASTE_WEIGHTS.shopClick);
  }

  // 6. impression produces no positive affinity ----------------------------
  {
    const s = snap([evt("product_impression", { product_id: P1 })]);
    assert.strictEqual(s.affinities.length, 0);
    assert.strictEqual(s.entities.length, 0);
    assert.strictEqual(s.stats.skippedNonTasteEvents, 1);
  }

  // 7. seller_open only affects seller taste -------------------------------
  {
    const s = snap([evt("seller_open", { seller_id: S1 })]);
    assert.strictEqual(s.affinities.length, 1);
    const seller = findAffinity(s, "seller", S1);
    assert.ok(seller, "seller affinity exists");
    approxEqual(seller.long_term_score, TASTE_WEIGHTS.sellerOpen);
    assert.strictEqual(findAffinity(s, "brand", "acme watches"), undefined);
    assert.strictEqual(findAffinity(s, "category", "watches"), undefined);
  }

  // 8. seller_follow strong seller signal ----------------------------------
  {
    const s = snap([evt("seller_follow", { seller_id: S1 })]);
    approxEqual(findAffinity(s, "seller", S1).long_term_score, TASTE_WEIGHTS.sellerFollow);
    assert.ok(TASTE_WEIGHTS.sellerFollow > TASTE_WEIGHTS.sellerOpen);
  }

  // 9. like -> unlike reversal returns to pre-like state -------------------
  {
    const s = snap([
      evt("product_open", { product_id: P1, created_at: iso(-2 * DAY_MS) }),
      evt("product_like", { product_id: P1, created_at: iso(-DAY_MS) }),
      evt("product_unlike", { product_id: P1 }),
    ]);
    const product = findAffinity(s, "product", P1);
    // Score equals the open-only baseline (the like contribution was removed).
    const baseline = snap([evt("product_open", { product_id: P1, created_at: iso(-2 * DAY_MS) })]);
    const baselineProduct = findAffinity(baseline, "product", P1);
    approxEqual(product.long_term_score, baselineProduct.long_term_score);
    approxEqual(product.recent_score, baselineProduct.recent_score);
    assert.strictEqual(product.positive_signal_count, 2);
    assert.strictEqual(product.negative_signal_count, 1);
  }

  // 10. save -> unsave reversal --------------------------------------------
  {
    const s = snap([
      evt("product_save", { product_id: P1 }),
      evt("product_unsave", { product_id: P1 }),
    ]);
    const product = findAffinity(s, "product", P1);
    approxEqual(product.long_term_score, 0);
    approxEqual(product.recent_score, 0);
    assert.strictEqual(product.positive_signal_count, 1);
    assert.strictEqual(product.negative_signal_count, 1);
  }

  // 11. follow -> unfollow reversal -----------------------------------------
  {
    const s = snap([
      evt("seller_follow", { seller_id: S1 }),
      evt("seller_unfollow", { seller_id: S1 }),
    ]);
    approxEqual(findAffinity(s, "seller", S1).long_term_score, 0);
  }

  // 12. repeated toggle cycles do not drift ---------------------------------
  {
    const oneCycle = snap([
      evt("product_like", { product_id: P1 }),
      evt("product_unlike", { product_id: P1 }),
    ]);
    const manyCycles = snap([
      evt("product_like", { product_id: P1, created_at: iso(-6 * DAY_MS) }),
      evt("product_unlike", { product_id: P1, created_at: iso(-5 * DAY_MS) }),
      evt("product_like", { product_id: P1, created_at: iso(-4 * DAY_MS) }),
      evt("product_unlike", { product_id: P1, created_at: iso(-3 * DAY_MS) }),
      evt("product_like", { product_id: P1, created_at: iso(-2 * DAY_MS) }),
      evt("product_unlike", { product_id: P1, created_at: iso(-DAY_MS) }),
    ]);
    const product = findAffinity(manyCycles, "product", P1);
    approxEqual(product.long_term_score, 0, 1e-6);
    approxEqual(product.recent_score, 0, 1e-6);
    approxEqual(findAffinity(oneCycle, "product", P1).long_term_score, 0, 1e-6);
    // Duplicate like without an intervening unlike is a no-op (no double count).
    const dup = snap([
      evt("product_like", { product_id: P1 }),
      evt("product_like", { product_id: P1 }),
    ]);
    approxEqual(findAffinity(dup, "product", P1).long_term_score, TASTE_WEIGHTS.productLike);
  }

  // 13. unlike without previous like: no arbitrary negative -----------------
  {
    const s = snap([evt("product_unlike", { product_id: P1 })]);
    assert.strictEqual(s.affinities.length, 0, "orphan unlike creates nothing");
    assert.strictEqual(s.stats.orphanReversals, 1);
  }

  // 14. unsave without previous save behaves safely --------------------------
  {
    const s = snap([evt("product_unsave", { product_id: P1 })]);
    assert.strictEqual(s.affinities.length, 0);
    assert.strictEqual(s.stats.orphanReversals, 1);
  }

  // 15. unfollow without previous follow behaves safely ----------------------
  {
    const s = snap([evt("seller_unfollow", { seller_id: S1 })]);
    assert.strictEqual(s.affinities.length, 0);
    assert.strictEqual(s.stats.orphanReversals, 1);
  }

  // 16. meaningful dwell contributes -----------------------------------------
  {
    const s = snap([
      evt("product_dwell", { product_id: P1, metadata: { duration_ms: 5000 } }),
    ]);
    approxEqual(findAffinity(s, "product", P1).long_term_score, TASTE_WEIGHTS.productDwell);
  }

  // 17. malformed/short/missing dwell does not contribute --------------------
  {
    for (const metadata of [
      {},
      { duration_ms: "5000" },
      { duration_ms: null },
      { duration_ms: Number.NaN },
      { duration_ms: -100 },
      { duration_ms: DWELL_MEANINGFUL_THRESHOLD_MS - 1 },
    ]) {
      const s = snap([evt("product_dwell", { product_id: P1, metadata })]);
      assert.strictEqual(
        s.affinities.length,
        0,
        `dwell metadata ${JSON.stringify(metadata)} must not contribute`
      );
    }
    assert.ok(isMeaningfulDwell({ duration_ms: DWELL_MEANINGFUL_THRESHOLD_MS }));
    assert.ok(!isMeaningfulDwell({ duration_ms: DWELL_MEANINGFUL_THRESHOLD_MS - 1 }));
  }

  // 18. search_result_open product -------------------------------------------
  {
    const s = snap([
      evt("search_result_open", {
        product_id: P1,
        metadata: { query: "vintage watch", result_type: "product", target_id: P1 },
      }),
    ]);
    approxEqual(findAffinity(s, "product", P1).long_term_score, TASTE_WEIGHTS.searchResultOpen);
    // propagates upward too
    approxEqual(
      findAffinity(s, "brand", "acme watches").long_term_score,
      TASTE_WEIGHTS.searchResultOpen * PROPAGATION_MULTIPLIERS.brand
    );
  }

  // 19. search_result_open seller ---------------------------------------------
  {
    const s = snap([
      evt("search_result_open", {
        seller_id: S1,
        metadata: { query: "acme", result_type: "seller", target_id: S1 },
      }),
    ]);
    assert.strictEqual(s.affinities.length, 1);
    approxEqual(findAffinity(s, "seller", S1).long_term_score, TASTE_WEIGHTS.searchResultOpen);
  }

  // 20. search_query excluded --------------------------------------------------
  {
    const s = snap([
      evt("search_query", { metadata: { query: "vintage watch" } }),
    ]);
    assert.strictEqual(s.affinities.length, 0);
    assert.strictEqual(getSignalDefinition("search_query").kind, "none");
  }

  // 21. product_report excluded -------------------------------------------------
  {
    const s = snap([evt("product_report", { product_id: P1 })]);
    assert.strictEqual(s.affinities.length, 0);
  }

  // 22. sensitive_content_reveal excluded ---------------------------------------
  {
    const s = snap([evt("sensitive_content_reveal", { product_id: P1 })]);
    assert.strictEqual(s.affinities.length, 0);
  }

  // 23. catalog events excluded --------------------------------------------------
  {
    const catalogTypes = [
      "catalog_match_attempt",
      "catalog_match_high_confidence",
      "catalog_match_suggested",
      "catalog_match_accepted",
      "catalog_match_rejected",
      "catalog_match_none",
      "catalog_variant_matched",
    ];
    const s = snap(catalogTypes.map((type) => evt(type, { product_id: P1 })));
    assert.strictEqual(s.affinities.length, 0);
    assert.strictEqual(s.stats.skippedNonTasteEvents, catalogTypes.length);
  }

  // 24. unknown event excluded safely --------------------------------------------
  {
    const s = snap([evt("some_future_event", { product_id: P1 })]);
    assert.strictEqual(s.affinities.length, 0);
    assert.strictEqual(s.stats.skippedNonTasteEvents, 1);
    assert.strictEqual(getSignalDefinition("some_future_event").kind, "none");
  }

  // 25-29. Propagation multipliers ------------------------------------------------
  {
    const s = snap([evt("product_like", { product_id: P1 })]);
    const w = TASTE_WEIGHTS.productLike;
    approxEqual(findAffinity(s, "product", P1).long_term_score, w * PROPAGATION_MULTIPLIERS.product);
    approxEqual(findAffinity(s, "canonical_product", C1).long_term_score, w * PROPAGATION_MULTIPLIERS.canonical_product);
    approxEqual(findAffinity(s, "brand", "acme watches").long_term_score, w * PROPAGATION_MULTIPLIERS.brand);
    approxEqual(findAffinity(s, "category", "watches").long_term_score, w * PROPAGATION_MULTIPLIERS.category);
    approxEqual(findAffinity(s, "seller", S1).long_term_score, w * PROPAGATION_MULTIPLIERS.seller);
    // P2 has no canonical match: no canonical entity for a like on P2.
    const s2 = snap([evt("product_like", { product_id: P2 })]);
    assert.strictEqual(findAffinity(s2, "canonical_product", C1), undefined);
    assert.ok(PROPAGATION_MULTIPLIERS.brand < PROPAGATION_MULTIPLIERS.product);
  }

  // 30. missing/deleted product context -------------------------------------------
  {
    const s = snap([
      evt("product_like", { product_id: P3, seller_id: S2, category: "watches" }),
    ]);
    // Product identity itself is still known from the event.
    assert.ok(findAffinity(s, "product", P3), "product entity kept for deleted product");
    // Safe event-local dimensions preserved.
    assert.ok(findAffinity(s, "category", "watches"));
    assert.ok(findAffinity(s, "seller", S2));
    // Never invent brand/canonical identity.
    assert.strictEqual(findAffinity(s, "brand", "acme watches"), undefined);
    assert.strictEqual(s.affinities.some((a) => a.entity_type === "canonical_product"), false);
    assert.deepStrictEqual(s.stats.unresolvedProducts, [P3]);
  }

  // 31. recent decay ----------------------------------------------------------------
  {
    const fresh = snap([evt("product_like", { product_id: P1, created_at: iso() })]);
    const aged = snap([
      evt("product_like", { product_id: P1, created_at: iso(-RECENT_SCORE_HALF_LIFE_DAYS * DAY_MS) }),
    ]);
    approxEqual(
      findAffinity(aged, "product", P1).recent_score,
      findAffinity(fresh, "product", P1).recent_score * 0.5,
      1e-6
    );
    // Half-life math sanity: decayFactor(14, 14) === 0.5
    approxEqual(decayFactor(14, 14), 0.5);
    approxEqual(decayFactor(0, 14), 1);
  }

  // 32. deterministic explicit as-of -------------------------------------------------
  {
    const events = [
      evt("product_like", { product_id: P1, created_at: iso(-3 * DAY_MS) }),
      evt("product_save", { product_id: P1, created_at: iso(-DAY_MS) }),
    ];
    const a = snap(events, { asOf: "2026-09-15T12:00:00.000Z" });
    const b = snap(events, { asOf: "2026-09-15T12:00:00.000Z" });
    assert.deepStrictEqual(a, b, "same history + same as-of => identical snapshot");
    const c = snap(events, { asOf: "2026-10-15T12:00:00.000Z" });
    assert.notDeepStrictEqual(
      a.affinities,
      c.affinities,
      "different as-of changes decayed scores"
    );
  }

  // 33. stable same-timestamp ordering -------------------------------------------------
  {
    // Same created_at for a like and its reversal: id order decides replay.
    const t = iso();
    const ordered = snap([
      evt("product_like", { id: "a-like", product_id: P1, created_at: t }),
      evt("product_unlike", { id: "b-unlike", product_id: P1, created_at: t }),
    ]);
    approxEqual(findAffinity(ordered, "product", P1).long_term_score, 0, 1e-9);
    // Reversed id order: unlike lands first (orphan), like applies after.
    const reversed = snap([
      evt("product_like", { id: "b-like", product_id: P1, created_at: t }),
      evt("product_unlike", { id: "a-unlike", product_id: P1, created_at: t }),
    ]);
    approxEqual(
      findAffinity(reversed, "product", P1).long_term_score,
      TASTE_WEIGHTS.productLike,
      1e-9
    );
    // Input array order must not matter: the engine sorts internally.
    const events = [
      evt("product_save", { id: "c", product_id: P1, created_at: iso(-DAY_MS) }),
      evt("product_open", { id: "a", product_id: P1, created_at: iso(-2 * DAY_MS) }),
      evt("product_like", { id: "b", product_id: P1, created_at: iso(-DAY_MS) }),
    ];
    assert.deepStrictEqual(snap(events), snap([...events].reverse()));
  }

  // 34 + 35. rebuild idempotency / apply-twice convergence -----------------------------
  {
    const events = [
      evt("product_open", { product_id: P1, created_at: iso(-2 * DAY_MS) }),
      evt("product_like", { product_id: P1, created_at: iso(-DAY_MS) }),
      evt("product_save", { product_id: P1, created_at: iso(-DAY_MS) }),
    ];
    const store = new FakeTasteGraphStore({ events, products: PRODUCTS });
    const first = await rebuildUserTasteGraph(store, USER_A, { asOf: AS_OF, apply: true });
    const stateAfterFirst = JSON.stringify(store.affinityRowsFor(USER_A));
    const second = await rebuildUserTasteGraph(store, USER_A, { asOf: AS_OF, apply: true });
    const stateAfterSecond = JSON.stringify(store.affinityRowsFor(USER_A));
    assert.strictEqual(stateAfterFirst, stateAfterSecond, "applying twice converges");
    assert.strictEqual(first.affinitiesDeleted, 0);
    assert.strictEqual(second.affinitiesDeleted, 0);
    assert.ok(first.affinitiesUpserted > 0);
    assert.deepStrictEqual(first.snapshot, second.snapshot, "rebuild is deterministic");
  }

  // Rebuild removes stale affinities when history changes.
  {
    const store = new FakeTasteGraphStore({
      events: [evt("product_like", { product_id: P1 })],
      products: PRODUCTS,
    });
    await rebuildUserTasteGraph(store, USER_A, { asOf: AS_OF, apply: true });
    assert.ok(store.affinityRowsFor(USER_A).length > 0);
    store.events = []; // history removed: replacement must clear derived state
    const cleared = await rebuildUserTasteGraph(store, USER_A, { asOf: AS_OF, apply: true });
    assert.strictEqual(store.affinityRowsFor(USER_A).length, 0);
    assert.ok(cleared.affinitiesDeleted > 0);
  }

  // 36. user isolation -------------------------------------------------------------------
  {
    const events = [
      evt("product_like", { product_id: P1, user_id: USER_A }),
      evt("product_like", { product_id: P2, user_id: USER_B }),
    ];
    const store = new FakeTasteGraphStore({ events, products: PRODUCTS });
    await rebuildUserTasteGraph(store, USER_A, { asOf: AS_OF, apply: true });
    await rebuildUserTasteGraph(store, USER_B, { asOf: AS_OF, apply: true });
    const aEntityKeys = store
      .affinityRowsFor(USER_A)
      .map((row) => row.taste_entity_id);
    assert.ok(aEntityKeys.includes(`entity-product:${P1}`));
    assert.ok(!aEntityKeys.includes(`entity-product:${P2}`));
    const bEntityKeys = store
      .affinityRowsFor(USER_B)
      .map((row) => row.taste_entity_id);
    assert.ok(bEntityKeys.includes(`entity-product:${P2}`));
    assert.ok(!bEntityKeys.includes(`entity-product:${P1}`));
  }

  // 37. RLS migration intent --------------------------------------------------------------
  {
    const migration = fs.readFileSync(
      path.join(__dirname, "..", "supabase", "migrations", "20261001_add_taste_graph_foundation.sql"),
      "utf8"
    );
    assert.match(migration, /alter table public\.taste_entities enable row level security/);
    assert.match(migration, /alter table public\.user_taste_affinities enable row level security/);
    assert.match(migration, /for select\s+to authenticated\s+using \(auth\.uid\(\) = user_id\)/);
    // Affinities: clients get NO write policies at all.
    const affinitiesSection = migration.split("user_taste_affinities")[0];
    assert.ok(affinitiesSection.length > 0);
    const writePolicies = migration.match(
      /on public\.user_taste_affinities\s+for (insert|update|delete)/g
    );
    assert.strictEqual(writePolicies, null, "no client write policies on affinities");
    const entityWritePolicies = migration.match(
      /on public\.taste_entities\s+for (insert|update|delete)/g
    );
    assert.strictEqual(entityWritePolicies, null, "no client write policies on entities");
    // user_events migration must remain untouched / insert-only.
    const userEventsMigration = fs.readFileSync(
      path.join(__dirname, "..", "supabase", "migrations", "20260912_add_user_events.sql"),
      "utf8"
    );
    assert.match(userEventsMigration, /for insert\s+to authenticated\s+with check \(auth\.uid\(\) = user_id\)/);
    assert.doesNotMatch(userEventsMigration, /for update/);
    assert.doesNotMatch(userEventsMigration, /for delete/);
  }

  // 38. dry-run performs zero writes ---------------------------------------------------------
  {
    const store = new FakeTasteGraphStore({
      events: [evt("product_like", { product_id: P1 })],
      products: PRODUCTS,
    });
    const result = await rebuildUserTasteGraph(store, USER_A, { asOf: AS_OF });
    assert.strictEqual(result.dryRun, true);
    assert.deepStrictEqual(store.writeCounts, { entities: 0, affinities: 0, deletes: 0 });
    assert.strictEqual(result.entitiesUpserted, 0);
    assert.strictEqual(result.affinitiesUpserted, 0);
    assert.ok(result.snapshot.affinities.length > 0, "dry-run still computes the snapshot");
  }

  // 39. malformed event handling --------------------------------------------------------------
  {
    const s = snap([
      evt("product_like", { product_id: P1, created_at: "not-a-date" }),
      { id: "", event_type: "product_like", created_at: iso() },
      { id: "x", event_type: "", created_at: iso() },
      { id: "y", created_at: iso() },
      null,
      "garbage",
      evt("product_like", { product_id: null }), // positive with no target
      evt("product_open", { product_id: P1 }), // one good event
    ]);
    assert.strictEqual(s.stats.malformedEvents, 7);
    assert.strictEqual(s.affinities.length > 0, true, "valid events still process");
    assert.ok(findAffinity(s, "product", P1));
  }

  // 40. empty event history ---------------------------------------------------------------------
  {
    const s = snap([]);
    assert.strictEqual(s.entities.length, 0);
    assert.strictEqual(s.affinities.length, 0);
    assert.strictEqual(s.stats.eventsProcessed, 0);
    const store = new FakeTasteGraphStore({ events: [], products: [] });
    const result = await rebuildUserTasteGraph(store, USER_A, { asOf: AS_OF, apply: true });
    assert.strictEqual(result.affinitiesUpserted, 0);
    assert.strictEqual(result.entitiesUpserted, 0);
  }

  // 41. realistic multi-event journey --------------------------------------------------------------
  {
    const events = [
      evt("product_impression", { product_id: P1, created_at: iso(-50) }),
      evt("product_open", { product_id: P1, created_at: iso(-40) }),
      evt("product_dwell", { product_id: P1, created_at: iso(-30), metadata: { duration_ms: 8000 } }),
      evt("product_like", { product_id: P1, created_at: iso(-20) }),
      evt("product_save", { product_id: P1, created_at: iso(-10) }),
      evt("shop_click", { product_id: P1, created_at: iso() }),
      evt("product_open", { product_id: P2, created_at: iso() }),
      evt("seller_follow", { seller_id: S1, created_at: iso() }),
      evt("product_unsave", { product_id: P1, created_at: iso() }),
    ];
    const s = snap(events);

    const watch = findAffinity(s, "product", P1);
    const shoes = findAffinity(s, "product", P2);
    // open(1) + dwell(2) + like(3) + save(5) - save(5) + shop_click(6) = 12
    approxEqual(watch.long_term_score, 12, 1e-9);
    approxEqual(shoes.long_term_score, 1, 1e-9);
    assert.ok(watch.long_term_score > shoes.long_term_score);

    // Propagated dimensions make conceptual sense.
    const watchBrand = findAffinity(s, "brand", "acme watches");
    const shoeBrand = findAffinity(s, "brand", "shoeco");
    approxEqual(watchBrand.long_term_score, 6, 1e-9);
    approxEqual(shoeBrand.long_term_score, 0.5, 1e-9);
    assert.ok(watchBrand.long_term_score > shoeBrand.long_term_score);

    const watchSeller = findAffinity(s, "seller", S1);
    // product propagation (12 * 0.5) + follow (4)
    approxEqual(watchSeller.long_term_score, 10, 1e-9);
    // The unsave left reversal evidence but did not create dislike.
    assert.strictEqual(watch.negative_signal_count, 1);
    assert.strictEqual(watch.positive_signal_count, 5);
    // Impression contributed nothing extra: only 8 of 9 events were taste events.
    assert.strictEqual(s.stats.tasteEvents, 8);
    assert.strictEqual(s.stats.skippedNonTasteEvents, 1);
    // Canonical product picked up the full-strength watch interactions.
    approxEqual(findAffinity(s, "canonical_product", C1).long_term_score, 12, 1e-9);
    // Table formatter renders something readable for the debug CLI.
    const table = formatSnapshotTable(s);
    assert.ok(table.length > 2);
    assert.ok(table.some((line) => line.includes("product")));
  }

  console.log("taste-graph tests: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
