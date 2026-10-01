// lib/tasteSignals.ts
//
// Centralized, versioned, deterministic Taste Graph signal model (PR #34).
//
// Every numerical weight, propagation multiplier, decay constant, and
// event-type classification lives HERE — never scattered across screens or
// components. This module is pure and dependency-free (no supabase /
// react-native imports) so Node scripts and offline tests can import it
// directly via native TS type-stripping, exactly like lib/catalogMatching.ts.
//
// The raw source of truth is always public.user_events; everything derived
// from these definitions is rebuildable.

// Bump when weights, thresholds, multipliers, or decay constants change so
// snapshots built by different model versions are never mixed silently.
//
//   1  PR #34 initial model
//   2  PR #35 adds explicit onboarding signals (onboarding_* event types).
//      Additive only: pre-existing event semantics are unchanged.
export const TASTE_SIGNAL_VERSION = 2;

// Entity dimensions supported by PR #34. Only dimensions that existing
// trustworthy data can actually identify — no subcategory/style/material/
// color/aesthetic/price-band/demographic inference.
export type TasteEntityType =
  | "product"
  | "canonical_product"
  | "brand"
  | "category"
  | "seller";

export const TASTE_ENTITY_TYPES: readonly TasteEntityType[] = [
  "product",
  "canonical_product",
  "brand",
  "category",
  "seller",
];

// ---------------------------------------------------------------------------
// Signal weights (base strength of a positive contribution before propagation
// multipliers). Conservative v1 values; relationships matter more than the
// exact numbers:
//
//   impression     0   exposure/context only — never positive taste
//   open           1   weak positive
//   dwell          2   moderate positive, ONLY when meaningful (see threshold)
//   like           3   strong positive
//   save           5   very strong positive
//   shop_click     6   very strong purchase-intent positive
//   seller_open    1   weak positive to seller
//   seller_follow  4   strong positive to seller
//   search_result_open 3  strong positive to the actual opened target
//
// Explicit onboarding signals (PR #35) — recorded ONLY by the atomic
// complete_taste_onboarding RPC, never by ordinary UI taps:
//
//   onboarding_category_select  4  explicit curated-category preference;
//                                  contributes to the category entity ONLY
//                                  (never invents product/brand/seller)
//   onboarding_product_select   4  explicit product preference; strong cold-
//                                  start seed, deliberately BELOW save (5)
//                                  and shop_click (6) so later organic
//                                  high-intent signals overtake it
//
// product_unlike / product_unsave / seller_unfollow are REVERSALS of their
// corresponding positive signals (weight 0 of their own) — they remove the
// recorded prior contribution instead of creating standalone dislike.
// onboarding_*_deselect are the corresponding onboarding reversals.
// onboarding_complete is lifecycle context only (weight 0, kind "none").
// ---------------------------------------------------------------------------
export const TASTE_WEIGHTS = {
  productOpen: 1,
  productDwell: 2,
  productLike: 3,
  productSave: 5,
  shopClick: 6,
  sellerOpen: 1,
  sellerFollow: 4,
  searchResultOpen: 3,
  onboardingCategorySelect: 4,
  onboardingProductSelect: 4,
} as const;

// A product_dwell event only carries taste when metadata.duration_ms is a
// finite number >= this threshold (the app records elapsed time on the
// product detail screen in metadata.duration_ms — see app/[id].tsx).
// Missing/malformed/short dwell contributes NOTHING rather than guessing.
export const DWELL_MEANINGFUL_THRESHOLD_MS = 2000;

// Propagation multipliers: a product-level positive signal contributes its
// weight × multiplier to each resolvable dimension. Product and canonical
// product are the exact thing interacted with (full strength); brand,
// category, and seller are weaker generalizations (half strength).
// Seller-targeted signals (seller_open / seller_follow) never propagate to
// products — they only touch the seller entity.
export const PROPAGATION_MULTIPLIERS: Record<TasteEntityType, number> = {
  product: 1.0,
  canonical_product: 1.0,
  brand: 0.5,
  category: 0.5,
  seller: 0.5,
};

// ---------------------------------------------------------------------------
// Time decay. Both scores use exponential decay with a half-life:
//
//   contribution = weight × multiplier × 0.5 ^ (ageInDays / halfLifeDays)
//
// where ageInDays = max(0, (asOf - event.created_at) / 86400000). Events
// dated after the reference "as of" time are clamped to age 0 (treated as
// just-happened) rather than amplifying.
//
// recent_score decays with a 14-day half-life (current interest).
// long_term_score decays with a 365-day half-life (persistent preference —
// deliberately slow in v1 so long-term taste barely fades).
//
// All decay math depends only on event.created_at and the injected asOf
// reference timestamp — never on Date.now() — so replays are deterministic.
// ---------------------------------------------------------------------------
export const RECENT_SCORE_HALF_LIFE_DAYS = 14;
export const LONG_TERM_SCORE_HALF_LIFE_DAYS = 365;

// How a single event type contributes to the Taste Graph.
export type TasteSignalKind =
  // Positive contribution of TASTE_WEIGHTS weight to the resolved target(s).
  | "positive"
  // Reversal of a previous positive signal: removes the recorded contribution
  // made by `reverses` for the same target instead of adding dislike.
  | "reversal"
  // No taste contribution at all (context, moderation, catalog plumbing).
  | "none";

// What an event's positive/reversal contribution targets.
export type TasteSignalTarget =
  // Resolves through the event's product (product entity + upward propagation
  // to canonical_product / brand / category / seller).
  | "product"
  // Resolves to the seller entity only (event.seller_id).
  | "seller"
  // Resolves via metadata.result_type + metadata.target_id (or the event's
  // product_id / seller_id) to either a product target or a seller target.
  | "search_result"
  // Resolves to the category entity only (event.category — a curated
  // discovery category id for onboarding events). Never propagates to
  // products/brands/sellers.
  | "category"
  | "none";

export type TasteSignalDefinition = {
  kind: TasteSignalKind;
  target: TasteSignalTarget;
  // Base positive weight (0 for reversal/none kinds).
  weight: number;
  // For kind === "reversal": the event type whose prior contribution is
  // removed when the reversal is matched to existing state.
  reverses?: string;
  // For kind === "positive": state-aware toggle. A duplicate of this event
  // on the same scope without an intervening reversal is a no-op, so
  // replays and idempotent re-submits never double-count. A matching
  // reversal event removes exactly the recorded contribution.
  toggle?: boolean;
  // For product_dwell: positive only when dwell metadata is meaningful.
  requiresMeaningfulDwell?: boolean;
};

// The complete event-type → signal mapping. Any event type not present here
// (unknown future types) safely contributes nothing.
export const TASTE_SIGNAL_DEFINITIONS: Record<string, TasteSignalDefinition> = {
  // Exposure/context only — never positive taste.
  product_impression: { kind: "none", target: "none", weight: 0 },

  product_open: {
    kind: "positive",
    target: "product",
    weight: TASTE_WEIGHTS.productOpen,
  },
  product_dwell: {
    kind: "positive",
    target: "product",
    weight: TASTE_WEIGHTS.productDwell,
    requiresMeaningfulDwell: true,
  },
  product_like: {
    kind: "positive",
    target: "product",
    weight: TASTE_WEIGHTS.productLike,
    toggle: true,
  },
  product_unlike: {
    kind: "reversal",
    target: "product",
    weight: 0,
    reverses: "product_like",
  },
  product_save: {
    kind: "positive",
    target: "product",
    weight: TASTE_WEIGHTS.productSave,
    toggle: true,
  },
  product_unsave: {
    kind: "reversal",
    target: "product",
    weight: 0,
    reverses: "product_save",
  },
  shop_click: {
    kind: "positive",
    target: "product",
    weight: TASTE_WEIGHTS.shopClick,
  },
  seller_open: {
    kind: "positive",
    target: "seller",
    weight: TASTE_WEIGHTS.sellerOpen,
  },
  seller_follow: {
    kind: "positive",
    target: "seller",
    weight: TASTE_WEIGHTS.sellerFollow,
    toggle: true,
  },
  seller_unfollow: {
    kind: "reversal",
    target: "seller",
    weight: 0,
    reverses: "seller_follow",
  },
  search_result_open: {
    kind: "positive",
    target: "search_result",
    weight: TASTE_WEIGHTS.searchResultOpen,
  },

  // Context only for PR #34 — no semantic NLP classification of queries.
  search_query: { kind: "none", target: "none", weight: 0 },

  // ----------------------------------------------------------------------
  // Explicit onboarding signals (PR #35).
  //
  // These are typed EXPLICIT preferences emitted only by the atomic
  // complete_taste_onboarding RPC — they are never faked equivalents of
  // product_like / product_save / seller_follow and never fire on ordinary
  // browsing. Toggle state makes idempotent completion retries safe: a
  // duplicated select on the same scope is a no-op, and a deselect removes
  // exactly the recorded select contribution.
  onboarding_category_select: {
    kind: "positive",
    target: "category",
    weight: TASTE_WEIGHTS.onboardingCategorySelect,
    toggle: true,
  },
  onboarding_category_deselect: {
    kind: "reversal",
    target: "category",
    weight: 0,
    reverses: "onboarding_category_select",
  },
  onboarding_product_select: {
    kind: "positive",
    target: "product",
    weight: TASTE_WEIGHTS.onboardingProductSelect,
    toggle: true,
  },
  onboarding_product_deselect: {
    kind: "reversal",
    target: "product",
    weight: 0,
    reverses: "onboarding_product_select",
  },
  // Lifecycle/context only: completing onboarding is NOT itself taste.
  onboarding_complete: { kind: "none", target: "none", weight: 0 },

  // Moderation / safety plumbing — never taste.
  product_report: { kind: "none", target: "none", weight: 0 },
  sensitive_content_reveal: { kind: "none", target: "none", weight: 0 },

  // Catalog matching plumbing — never taste.
  catalog_match_attempt: { kind: "none", target: "none", weight: 0 },
  catalog_match_high_confidence: { kind: "none", target: "none", weight: 0 },
  catalog_match_suggested: { kind: "none", target: "none", weight: 0 },
  catalog_match_accepted: { kind: "none", target: "none", weight: 0 },
  catalog_match_rejected: { kind: "none", target: "none", weight: 0 },
  catalog_match_none: { kind: "none", target: "none", weight: 0 },
  catalog_variant_matched: { kind: "none", target: "none", weight: 0 },
};

export function getSignalDefinition(eventType: string): TasteSignalDefinition {
  const def = TASTE_SIGNAL_DEFINITIONS[eventType];
  if (def) return def;
  // Unknown future event types fail safe: no taste contribution, no crash.
  return { kind: "none", target: "none", weight: 0 };
}

// ---------------------------------------------------------------------------
// Deterministic entity identity.
//
// - UUID-backed entities (product / canonical_product / seller) use the
//   stable UUID string, lowercased (UUID hex is case-insensitive).
// - brand / category use a normalized text key: trim → collapse all
//   insignificant whitespace runs to single spaces → lowercase. The same
//   input semantics always produce the same key, while genuinely distinct
//   names ("New Balance" vs "Newbalance Inc") never merge.
// - Empty / blank / non-string values are rejected (null).
//
// display_name is preserved separately (trimmed, original casing) and never
// participates in identity.
// ---------------------------------------------------------------------------
export function normalizeEntityKey(
  entityType: TasteEntityType,
  rawValue: unknown
): string | null {
  if (typeof rawValue !== "string") return null;
  const collapsed = rawValue.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return null;
  return collapsed.toLowerCase();
}

// Trimmed, original-casing label suitable for taste_entities.display_name.
export function entityDisplayName(rawValue: unknown): string | null {
  if (typeof rawValue !== "string") return null;
  const collapsed = rawValue.trim().replace(/\s+/g, " ");
  return collapsed.length === 0 ? null : collapsed;
}

// Meaningful dwell gate: metadata.duration_ms must be a finite number at or
// above the threshold. Anything else (missing key, string, NaN, negative,
// sub-threshold) contributes no dwell taste.
export function isMeaningfulDwell(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  const durationMs = (metadata as Record<string, unknown>).duration_ms;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
    return false;
  }
  return durationMs >= DWELL_MEANINGFUL_THRESHOLD_MS;
}

// Exponential decay multiplier for a contribution made `ageInDays` ago.
export function decayFactor(ageInDays: number, halfLifeDays: number): number {
  const clampedAge = ageInDays > 0 ? ageInDays : 0;
  return Math.pow(0.5, clampedAge / halfLifeDays);
}
