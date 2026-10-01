// lib/tasteGraph.ts
//
// Deterministic Taste Graph affinity engine (PR #34).
//
// Pure and dependency-free (no supabase / react-native imports) so Node
// scripts and offline tests import it directly via native TS type-stripping,
// exactly like lib/catalogMatching.ts.
//
// Core guarantee: the SAME event history replayed with the SAME "as of"
// reference timestamp ALWAYS produces the SAME snapshot. Rebuild correctness
// is preferred over clever incremental optimization: the engine replays the
// user's full event history from public.user_events (the append-only source
// of truth) and emits a complete replacement snapshot.
//
// Reversal semantics: product_unlike / product_unsave / seller_unfollow are
// NOT standalone dislike signals. A reversal removes exactly the contribution
// recorded when its corresponding positive toggle (like / save / follow) was
// applied. Interleaved signals on shared entities (e.g. two products with
// the same brand) stay correct because each recorded delta is subtracted
// individually. Orphan reversals (unlike without a prior like in the
// replayed history) are complete no-ops: they never create negative taste.

import {
  getSignalDefinition,
  isMeaningfulDwell,
  normalizeEntityKey,
  entityDisplayName,
  decayFactor,
  PROPAGATION_MULTIPLIERS,
  RECENT_SCORE_HALF_LIFE_DAYS,
  LONG_TERM_SCORE_HALF_LIFE_DAYS,
  TASTE_SIGNAL_VERSION,
} from "./tasteSignals.ts";
import type { TasteEntityType } from "./tasteSignals.ts";

// Raw public.user_events row (only the columns the engine reads).
export type TasteEventRow = {
  id: string;
  user_id?: string | null;
  session_id?: string | null;
  event_type: string;
  product_id?: string | null;
  seller_id?: string | null;
  category?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
};

// Trustworthy product context resolved from public.products. Mirrors the
// fields the app's Product type actually exposes; nothing is inferred.
export type TasteProductContext = {
  id: string;
  title?: string | null;
  brand?: string | null;
  category?: string | null;
  user_id?: string | null;
  catalog_product_id?: string | null;
};

export type TasteEntityRef = {
  entity_type: TasteEntityType;
  entity_key: string;
  display_name: string | null;
};

export type TasteAffinityRow = {
  entity_type: TasteEntityType;
  entity_key: string;
  long_term_score: number;
  recent_score: number;
  positive_signal_count: number;
  negative_signal_count: number;
  last_interaction_at: string | null;
};

export type TasteSnapshotStats = {
  // Every input row examined.
  eventsProcessed: number;
  // Events that produced at least one taste contribution (positives and
  // matched reversals).
  tasteEvents: number;
  // Defined-as-none or unknown event types (impressions, search_query,
  // catalog_match_*, reports, etc.).
  skippedNonTasteEvents: number;
  // Rows that could not be replayed safely (bad created_at, missing
  // event_type/id, unresolvable required target).
  malformedEvents: number;
  // Reversal events with no matching prior positive toggle in history.
  orphanReversals: number;
  // Product ids referenced by events but missing from product context
  // (deleted/unresolvable products). Sorted, de-duplicated.
  unresolvedProducts: string[];
};

export type TasteSnapshot = {
  version: number;
  // Injected reference timestamp (ISO) used for all decay math.
  asOf: string;
  // Deterministic order: (entity_type, entity_key).
  entities: TasteEntityRef[];
  // Deterministic order: (entity_type, entity_key). One row per entity that
  // received at least one contribution.
  affinities: TasteAffinityRow[];
  stats: TasteSnapshotStats;
};

export type BuildTasteSnapshotOptions = {
  // Required explicit reference time (ISO string or Date). The engine never
  // reads Date.now() itself — callers inject "now" so replays are testable
  // and deterministic.
  asOf: string | Date;
  // product_id -> trustworthy product context.
  productContext?: Map<string, TasteProductContext>;
};

// Convenience for scripts/tests: build the context map from product rows.
export function buildProductContextMap(
  rows: readonly TasteProductContext[]
): Map<string, TasteProductContext> {
  const map = new Map<string, TasteProductContext>();
  for (const row of rows) {
    if (row && typeof row.id === "string" && row.id.length > 0) {
      map.set(row.id, row);
    }
  }
  return map;
}

type EntityAccumulator = {
  entity_type: TasteEntityType;
  entity_key: string;
  display_name: string | null;
  longTerm: number;
  recent: number;
  positive: number;
  negative: number;
  lastInteractionMs: number | null;
};

// One applied positive contribution, recorded so a later reversal can remove
// EXACTLY it (per entity) without disturbing interleaved contributions.
type AppliedContribution = {
  entityRef: string;
  longTermDelta: number;
  recentDelta: number;
};

type ParsedEvent = {
  id: string;
  event_type: string;
  product_id: string | null;
  seller_id: string | null;
  category: string | null;
  metadata: Record<string, unknown>;
  timeMs: number;
  created_at: string;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function refOf(entityType: TasteEntityType, entityKey: string): string {
  return `${entityType}:${entityKey}`;
}

function round6(value: number): number {
  // Stable storage values: 6 decimal places, and -0 normalized to 0.
  const rounded = Math.round(value * 1e6) / 1e6;
  return rounded === 0 ? 0 : rounded;
}

function parseEvent(raw: TasteEventRow): ParsedEvent | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  if (typeof raw.event_type !== "string" || raw.event_type.length === 0) {
    return null;
  }
  const timeMs = new Date(raw.created_at).getTime();
  if (!Number.isFinite(timeMs)) return null;
  const metadata =
    raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
      ? (raw.metadata as Record<string, unknown>)
      : {};
  return {
    id: raw.id,
    event_type: raw.event_type,
    product_id: typeof raw.product_id === "string" ? raw.product_id : null,
    seller_id: typeof raw.seller_id === "string" ? raw.seller_id : null,
    category: typeof raw.category === "string" ? raw.category : null,
    metadata,
    timeMs,
    created_at: new Date(timeMs).toISOString(),
  };
}

// Deterministic replay order: created_at, tie-broken by event id so rows
// sharing a timestamp always replay identically.
function compareEvents(a: ParsedEvent, b: ParsedEvent): number {
  if (a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// A resolved entity target plus the strength multiplier for THIS signal.
// Product-level signals propagate upward with PROPAGATION_MULTIPLIERS
// (brand/category/seller at half strength); signals that target a seller
// directly (seller_open / seller_follow / seller search results) apply at
// full strength — the seller is the exact thing interacted with.
type ResolvedTarget = {
  ref: TasteEntityRef;
  multiplier: number;
};

// Resolve the trustworthy dimensions a product interaction contributes to.
// Missing/deleted product context: keep the event-local dimensions that are
// safe (the product identity itself, explicit event category/seller) and
// never invent brand/canonical identity.
function resolveProductTargets(
  productId: string,
  event: ParsedEvent,
  productContext: Map<string, TasteProductContext>,
  unresolvedProducts: Set<string>
): ResolvedTarget[] {
  const targets: ResolvedTarget[] = [];
  const productKey = normalizeEntityKey("product", productId);
  if (!productKey) return targets;

  const product = productContext.get(productId);
  if (!product) {
    unresolvedProducts.add(productId);
  }

  const push = (entityType: TasteEntityType, key: string, display: string | null) => {
    const multiplier = PROPAGATION_MULTIPLIERS[entityType] ?? 0;
    if (multiplier > 0) {
      targets.push({
        ref: { entity_type: entityType, entity_key: key, display_name: display },
        multiplier,
      });
    }
  };

  push("product", productKey, entityDisplayName(product?.title) ?? null);

  const canonicalKey = normalizeEntityKey(
    "canonical_product",
    product?.catalog_product_id ?? null
  );
  if (canonicalKey) {
    push(
      "canonical_product",
      canonicalKey,
      entityDisplayName(product?.catalog_product_id) ?? null
    );
  }

  const brandKey = normalizeEntityKey("brand", product?.brand ?? null);
  if (brandKey) {
    push("brand", brandKey, entityDisplayName(product?.brand) ?? null);
  }

  // Prefer trustworthy product context; fall back to the event-local
  // category the client recorded (safe, explicit dimension).
  const categorySource = product?.category ?? event.category;
  const categoryKey = normalizeEntityKey("category", categorySource);
  if (categoryKey) {
    push("category", categoryKey, entityDisplayName(categorySource) ?? null);
  }

  const sellerSource = product?.user_id ?? event.seller_id;
  const sellerKey = normalizeEntityKey("seller", sellerSource);
  if (sellerKey) {
    // No trustworthy seller name in product context: display stays null.
    push("seller", sellerKey, null);
  }

  return targets;
}

function resolveSellerTarget(sellerId: string | null): ResolvedTarget[] {
  const key = normalizeEntityKey("seller", sellerId);
  if (!key) return [];
  return [
    {
      ref: { entity_type: "seller", entity_key: key, display_name: null },
      multiplier: 1.0,
    },
  ];
}

export function buildTasteSnapshot(
  rawEvents: readonly TasteEventRow[],
  options: BuildTasteSnapshotOptions
): TasteSnapshot {
  const asOfMs = new Date(options.asOf).getTime();
  if (!Number.isFinite(asOfMs)) {
    throw new Error("buildTasteSnapshot requires a valid asOf timestamp");
  }
  const asOfIso = new Date(asOfMs).toISOString();
  const productContext = options.productContext ?? new Map<string, TasteProductContext>();

  const stats: TasteSnapshotStats = {
    eventsProcessed: 0,
    tasteEvents: 0,
    skippedNonTasteEvents: 0,
    malformedEvents: 0,
    orphanReversals: 0,
    unresolvedProducts: [],
  };

  const unresolvedProducts = new Set<string>();
  const parsed: ParsedEvent[] = [];
  for (const raw of rawEvents ?? []) {
    stats.eventsProcessed += 1;
    const event = parseEvent(raw);
    if (!event) {
      stats.malformedEvents += 1;
      continue;
    }
    parsed.push(event);
  }
  parsed.sort(compareEvents);

  const entities = new Map<string, EntityAccumulator>();
  // Toggle state: `${sourceEventType}:${scopeKey}` -> contributions recorded
  // when that toggle was applied. Scope is the product id for product
  // toggles and the seller id for seller follows.
  const toggleState = new Map<string, AppliedContribution[]>();

  const getAcc = (target: TasteEntityRef): EntityAccumulator => {
    const ref = refOf(target.entity_type, target.entity_key);
    let acc = entities.get(ref);
    if (!acc) {
      acc = {
        entity_type: target.entity_type,
        entity_key: target.entity_key,
        display_name: target.display_name,
        longTerm: 0,
        recent: 0,
        positive: 0,
        negative: 0,
        lastInteractionMs: null,
      };
      entities.set(ref, acc);
    } else if (!acc.display_name && target.display_name) {
      acc.display_name = target.display_name;
    }
    return acc;
  };

  const ageDays = (timeMs: number): number =>
    Math.max(0, (asOfMs - timeMs) / MS_PER_DAY);

  const applyPositive = (
    targets: ResolvedTarget[],
    weight: number,
    event: ParsedEvent
  ): AppliedContribution[] => {
    const age = ageDays(event.timeMs);
    const recentDecay = decayFactor(age, RECENT_SCORE_HALF_LIFE_DAYS);
    const longTermDecay = decayFactor(age, LONG_TERM_SCORE_HALF_LIFE_DAYS);
    const applied: AppliedContribution[] = [];
    for (const target of targets) {
      if (target.multiplier <= 0) continue;
      const acc = getAcc(target.ref);
      const longTermDelta = weight * target.multiplier * longTermDecay;
      const recentDelta = weight * target.multiplier * recentDecay;
      acc.longTerm += longTermDelta;
      acc.recent += recentDelta;
      acc.positive += 1;
      if (acc.lastInteractionMs === null || event.timeMs > acc.lastInteractionMs) {
        acc.lastInteractionMs = event.timeMs;
      }
      applied.push({
        entityRef: refOf(target.ref.entity_type, target.ref.entity_key),
        longTermDelta,
        recentDelta,
      });
    }
    return applied;
  };

  const applyReversal = (
    toggleKey: string,
    event: ParsedEvent
  ): boolean => {
    const recorded = toggleState.get(toggleKey);
    if (!recorded) return false; // orphan reversal: complete no-op
    for (const delta of recorded) {
      const acc = entities.get(delta.entityRef);
      if (!acc) continue;
      acc.longTerm -= delta.longTermDelta;
      acc.recent -= delta.recentDelta;
      // Evidence counts are cumulative observations, not score: the positive
      // signal really happened, and the reversal is negative/reversal
      // evidence. Scores return to their pre-toggle state; counts do not.
      acc.negative += 1;
      if (acc.lastInteractionMs === null || event.timeMs > acc.lastInteractionMs) {
        acc.lastInteractionMs = event.timeMs;
      }
    }
    toggleState.delete(toggleKey);
    return true;
  };

  for (const event of parsed) {
    const def = getSignalDefinition(event.event_type);

    if (def.kind === "none") {
      stats.skippedNonTasteEvents += 1;
      continue;
    }

    // Resolve targets for this event.
    let targets: ResolvedTarget[] = [];
    let scopeKey: string | null = null;

    if (def.target === "product") {
      if (!event.product_id) {
        stats.malformedEvents += 1;
        continue;
      }
      targets = resolveProductTargets(
        event.product_id,
        event,
        productContext,
        unresolvedProducts
      );
      scopeKey = `product:${event.product_id}`;
    } else if (def.target === "seller") {
      if (!event.seller_id) {
        stats.malformedEvents += 1;
        continue;
      }
      targets = resolveSellerTarget(event.seller_id);
      scopeKey = `seller:${event.seller_id}`;
    } else if (def.target === "search_result") {
      const resultType = event.metadata.result_type;
      const targetId =
        typeof event.metadata.target_id === "string"
          ? event.metadata.target_id
          : null;
      if (resultType === "product") {
        const productId = targetId ?? event.product_id;
        if (!productId) {
          stats.malformedEvents += 1;
          continue;
        }
        targets = resolveProductTargets(
          productId,
          event,
          productContext,
          unresolvedProducts
        );
        scopeKey = `product:${productId}`;
      } else if (resultType === "seller") {
        const sellerId = targetId ?? event.seller_id;
        if (!sellerId) {
          stats.malformedEvents += 1;
          continue;
        }
        targets = resolveSellerTarget(sellerId);
        scopeKey = `seller:${sellerId}`;
      } else {
        // Unresolvable search result target: no contribution, fail safe.
        stats.malformedEvents += 1;
        continue;
      }
    }

    if (targets.length === 0) {
      stats.malformedEvents += 1;
      continue;
    }

    if (def.kind === "positive") {
      if (def.requiresMeaningfulDwell && !isMeaningfulDwell(event.metadata)) {
        // Missing/short/malformed dwell metadata never creates taste.
        stats.skippedNonTasteEvents += 1;
        continue;
      }
      const toggleKey =
        event.event_type === "product_like" ||
        event.event_type === "product_save" ||
        event.event_type === "seller_follow"
          ? `${event.event_type}:${scopeKey ?? ""}`
          : null;
      if (toggleKey && toggleState.has(toggleKey)) {
        // State-aware toggle: a duplicate like/save/follow without an
        // intervening reversal is a no-op, so replays never double-count.
        stats.tasteEvents += 1;
        continue;
      }
      const applied = applyPositive(targets, def.weight, event);
      if (toggleKey) toggleState.set(toggleKey, applied);
      stats.tasteEvents += 1;
      continue;
    }

    // kind === "reversal"
    const toggleKey = `${def.reverses}:${scopeKey ?? ""}`;
    if (applyReversal(toggleKey, event)) {
      stats.tasteEvents += 1;
    } else {
      stats.orphanReversals += 1;
    }
  }

  // Deterministic output ordering.
  const sortedEntities = [...entities.values()].sort((a, b) => {
    if (a.entity_type !== b.entity_type) {
      return a.entity_type < b.entity_type ? -1 : 1;
    }
    return a.entity_key < b.entity_key ? -1 : a.entity_key > b.entity_key ? 1 : 0;
  });

  const snapshotEntities: TasteEntityRef[] = sortedEntities.map((acc) => ({
    entity_type: acc.entity_type,
    entity_key: acc.entity_key,
    display_name: acc.display_name,
  }));

  const affinities: TasteAffinityRow[] = sortedEntities.map((acc) => ({
    entity_type: acc.entity_type,
    entity_key: acc.entity_key,
    long_term_score: round6(acc.longTerm),
    recent_score: round6(acc.recent),
    positive_signal_count: acc.positive,
    negative_signal_count: acc.negative,
    last_interaction_at:
      acc.lastInteractionMs === null
        ? null
        : new Date(acc.lastInteractionMs).toISOString(),
  }));

  stats.unresolvedProducts = [...unresolvedProducts].sort();

  return {
    version: TASTE_SIGNAL_VERSION,
    asOf: asOfIso,
    entities: snapshotEntities,
    affinities,
    stats,
  };
}
