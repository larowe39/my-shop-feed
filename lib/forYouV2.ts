// lib/forYouV2.ts
//
// FOR YOU V2 — pure, deterministic Taste-Graph-aware feed ranker (PR #36).
//
// Consumes the PERSISTED, service-side-materialized Taste Graph
// (public.user_taste_affinities + public.taste_entities) as resolved by the
// batched client loader (lib/tasteAffinities.ts) and makes taste the PRIMARY
// preference model, while preserving the useful V1 signals (quality,
// freshness, followed-seller relevance, direct engagement, own-item penalty,
// deterministic tie jitter, diversity interleaving).
//
// Purity contract (same convention as lib/tasteSignals.ts / lib/tasteGraph.ts
// / lib/tasteOnboarding.ts):
//   - NO supabase / react-native imports — offline-testable via native TS
//     type-stripping in scripts/test-for-you-v2.js.
//   - `nowMs` is INJECTED — this module never calls Date.now().
//   - Identical inputs (including nowMs) ALWAYS produce identical ordering.
//   - Inputs are never mutated (products array, lookup map, option arrays).
//
// Fallback contract: when no usable affinities exist (signed out, empty
// snapshot, load failure), callers use the unchanged V1 rankForYouFeed. This
// module ranks with whatever affinity data it is given; an empty lookup
// simply yields zero taste contribution (safe), but the V1 fallback decision
// lives at the integration boundary via hasUsableTasteAffinities().

import { normalizeEntityKey } from "./tasteSignals.ts";
import type { TasteEntityType } from "./tasteSignals.ts";
import { CATEGORIES, matchProductCategory } from "../constants/categories.ts";
import { isDiscoveryCategoryVisible } from "./discoveryTaxonomy.ts";
import {
  computeQualityScore,
  computeRecencyScore,
  hashStringToFloat,
} from "./feedRanking.ts";
import type { TasteAffinityLookup } from "./tasteAffinities.ts";

// Minimal structural product shape the ranker needs (the app's Product type
// satisfies it). Everything except id is optional and missing values simply
// contribute nothing — never invented.
export type ForYouProduct = {
  id: string;
  brand?: string | null;
  category?: string | null;
  user_id?: string | null;
  catalog_product_id?: string | null;
  image_url?: string | null;
  price?: string | null;
  url?: string | null;
  created_at?: string | null;
};

// ---------------------------------------------------------------------------
// Scoring constants (all documented in docs/for-you-v2.md)
// ---------------------------------------------------------------------------

export const FOR_YOU_V2_BASE_SCORE = 1.0;

// Temporal blend: recent interest dominates, long-term preference stabilizes.
export const TASTE_BLEND_RECENT = 0.65;
export const TASTE_BLEND_LONG_TERM = 0.35;

// Saturation scale for 1 - exp(-|x| / k). k = 4 matches current signal
// magnitudes (single onboarding select = 4, strong category ≈ 8–10):
//   x=2  -> 0.393   (0→2 matters substantially)
//   x=4  -> 0.632   (2→4 still matters)
//   x=8  -> 0.865   (8→10 matters much less: 0.865 vs 0.918)
//   x=10 -> 0.918
//   x→∞  -> 1.0     (finite ceiling, never unbounded)
export const AFFINITY_SATURATION_K = 4;

// Bounded per-dimension contribution caps. Exact/canonical identity are the
// strongest individual matches; brand/category are generalization; seller is
// deliberately moderate so seller taste cannot dominate product taste. A
// product matching EVERY dimension is still bounded by their sum (≤ 3.6).
export const DIMENSION_WEIGHTS: Record<TasteEntityType, number> = {
  product: 1.0,
  canonical_product: 0.9,
  brand: 0.6,
  category: 0.7,
  seller: 0.4,
};

// Category namespace bridge: the strongest matching category signal (raw
// product category OR curated discovery category) is primary; each additional
// distinct category signal contributes only this fraction, and the combined
// result is clamped to [-1, 1] so correlated namespaces never double-count.
export const CATEGORY_SECONDARY_FACTOR = 0.25;

// Retained V1 signals (unchanged values).
export const FOLLOWED_SELLER_BONUS = 0.3;
export const ENGAGEMENT_BONUS = 0.08;
export const OWN_ITEM_PENALTY = -0.15;
export const TIE_JITTER_WEIGHT = 0.08;

// Deterministic exploration pressure: products whose combined category signal
// is weak/absent receive a small stable bonus derived from the product id, so
// unseen/weak categories periodically enter the candidate window without
// Math.random(), reshuffles, or render instability. Bounded to [0, 0.2).
export const EXPLORATION_WEIGHT = 0.2;
export const EXPLORATION_CATEGORY_THRESHOLD = 0.05;

// Diversity interleaving penalties (identical to V1's greedy pass).
export const DIVERSITY_WINDOW_SIZE = 10;
export const CATEGORY_PREV1_PENALTY = 0.5;
export const CATEGORY_PREV2_PENALTY = 0.22;
export const SELLER_BRAND_PREV1_PENALTY = 0.6;
export const SELLER_BRAND_PREV2_PENALTY = 0.25;

export type RankForYouV2Options = {
  // Resolved Taste Graph lookup from lib/tasteAffinities.ts. May be empty
  // (zero taste contribution) — the V1 fallback decision is the caller's.
  affinityLookup: TasteAffinityLookup;
  likedIds?: readonly string[];
  savedIds?: readonly string[];
  followingIds?: readonly string[];
  currentUserId?: string | null;
  // REQUIRED injected reference time. The ranker never reads Date.now().
  nowMs: number;
};

// Integration-boundary predicate: when false, callers keep the unchanged V1
// rankForYouFeed (guests, empty snapshots, load failures).
export function hasUsableTasteAffinities(
  lookup: TasteAffinityLookup | null | undefined
): boolean {
  return !!lookup && lookup.size > 0;
}

// Temporal blend of one entity's persisted scores.
export function blendAffinityScores(recentScore: number, longTermScore: number): number {
  const recent = Number.isFinite(recentScore) ? recentScore : 0;
  const longTerm = Number.isFinite(longTermScore) ? longTermScore : 0;
  return TASTE_BLEND_RECENT * recent + TASTE_BLEND_LONG_TERM * longTerm;
}

// Monotonic saturating magnitude transform, sign-preserving:
//   x >= 0 ->  +(1 - exp(-x / k))   in [0, 1)
//   x <  0 ->  -(1 - exp(-|x| / k)) in (-1, 0]
// Affinity 0 contributes exactly 0; extremely large magnitudes approach ±1;
// negative affinity stays bounded-negative and can never become positive
// relevance. Non-finite input safely yields 0.
export function saturateAffinity(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const magnitude = 1 - Math.exp(-Math.abs(value) / AFFINITY_SATURATION_K);
  return value < 0 ? -magnitude : magnitude;
}

// Blended + saturated affinity for one entity, or null when the entity has
// no persisted affinity at all (distinction matters for category bridging:
// "no evidence" is not "zero evidence").
function lookupSaturated(
  lookup: TasteAffinityLookup,
  entityType: TasteEntityType,
  rawKey: unknown
): number | null {
  const key = normalizeEntityKey(entityType, rawKey);
  if (!key) return null;
  const entry = lookup.get(`${entityType}:${key}`);
  if (!entry) return null;
  return saturateAffinity(
    blendAffinityScores(entry.recentScore, entry.longTermScore)
  );
}

// ---------------------------------------------------------------------------
// Category namespace bridge.
//
// The Taste Graph legitimately contains TWO category namespaces:
//   A. raw product categories ("hoodies", "sneakers") from organic signals
//   B. curated discovery categories ("fashion", "shoes") from onboarding
// For each candidate we collect BOTH: the raw category's affinity plus the
// affinity of every curated discovery category the product matches via the
// EXISTING matchProductCategory semantics. Keys are de-duplicated (a raw
// "shoes" product and the curated "shoes" slug resolve to the same key).
// ---------------------------------------------------------------------------

export type CategorySignal = {
  key: string;
  value: number;
};

export function collectCategorySignals(
  product: ForYouProduct,
  lookup: TasteAffinityLookup
): CategorySignal[] {
  const signals: CategorySignal[] = [];
  const seen = new Set<string>();

  const push = (rawKey: unknown) => {
    const key = normalizeEntityKey("category", rawKey);
    if (!key || seen.has(key)) return;
    const value = lookupSaturated(lookup, "category", rawKey);
    if (value === null) return;
    seen.add(key);
    signals.push({ key, value });
  };

  // 1. Raw product category namespace (organic affinity).
  push(product.category);

  // 2. Curated discovery category namespace (onboarding affinity): every
  //    visible curated category the product matches.
  for (const curated of CATEGORIES) {
    if (!isDiscoveryCategoryVisible(curated.id)) continue;
    if (!matchProductCategory(product.category, curated.id)) continue;
    push(curated.id);
  }

  return signals;
}

// Combine distinct category signals without naive double counting: the
// strongest signal is primary at full strength, every additional distinct
// signal contributes CATEGORY_SECONDARY_FACTOR, and the total is clamped to
// the per-dimension saturation bound [-1, 1].
export function combineCategorySignals(
  signals: readonly CategorySignal[]
): number {
  if (!signals || signals.length === 0) return 0;
  const sorted = [...signals].sort((a, b) => b.value - a.value);
  let combined = sorted[0].value;
  for (let i = 1; i < sorted.length; i++) {
    combined += CATEGORY_SECONDARY_FACTOR * sorted[i].value;
  }
  return Math.max(-1, Math.min(1, combined));
}

// Deterministic exploration bonus in [0, EXPLORATION_WEIGHT): applied only
// when the product's combined category signal is weak or absent (never for
// negatively-affinity categories), derived from a salted id hash so it is
// stable across renders and identical for identical inputs. Exported for
// offline tests.
export function computeExplorationBonus(
  productId: string,
  combinedCategorySignal: number
): number {
  if (
    !Number.isFinite(combinedCategorySignal) ||
    combinedCategorySignal < 0 ||
    combinedCategorySignal >= EXPLORATION_CATEGORY_THRESHOLD
  ) {
    return 0;
  }
  return EXPLORATION_WEIGHT * hashStringToFloat(`explore:${productId}`);
}

type ScoredCandidate = {
  product: ForYouProduct;
  score: number;
  category: string;
  sellerId: string;
  brand: string;
};

/**
 * Ranks products for the FOR YOU feed using the persisted Taste Graph as the
 * primary preference model. Pure and deterministic for identical inputs.
 */
export function rankForYouFeedV2<T extends ForYouProduct>(
  products: readonly T[],
  options: RankForYouV2Options
): T[] {
  if (!products || products.length <= 1) {
    return products ? [...products] : [];
  }

  const {
    affinityLookup,
    likedIds = [],
    savedIds = [],
    followingIds = [],
    currentUserId = null,
    nowMs,
  } = options;

  const safeNowMs = Number.isFinite(nowMs) ? nowMs : 0;
  const likedSet = new Set(likedIds);
  const savedSet = new Set(savedIds);
  const followingSet = new Set(followingIds);

  // 1. Score each candidate. Every taste dimension is looked up by the SAME
  //    normalizeEntityKey semantics the rebuild path used; missing dimensions
  //    are simply absent, never invented.
  const scoredCandidates: ScoredCandidate[] = products.map((product) => {
    const isOwn = Boolean(
      currentUserId && product.user_id && product.user_id === currentUserId
    );

    const productSat = lookupSaturated(affinityLookup, "product", product.id) ?? 0;
    const canonicalSat = product.catalog_product_id
      ? lookupSaturated(affinityLookup, "canonical_product", product.catalog_product_id) ?? 0
      : 0;
    const brandSat = lookupSaturated(affinityLookup, "brand", product.brand) ?? 0;
    const categorySat = combineCategorySignals(
      collectCategorySignals(product, affinityLookup)
    );
    // Self-seller protection: a user's own listings NEVER receive their
    // self-seller affinity. The graph itself is untouched (read-only); only
    // this candidate's seller contribution is ignored.
    const sellerSat = isOwn
      ? 0
      : lookupSaturated(affinityLookup, "seller", product.user_id) ?? 0;

    const tasteBonus =
      DIMENSION_WEIGHTS.product * productSat +
      DIMENSION_WEIGHTS.canonical_product * canonicalSat +
      DIMENSION_WEIGHTS.brand * brandSat +
      DIMENSION_WEIGHTS.category * categorySat +
      DIMENSION_WEIGHTS.seller * sellerSat;

    const qualityBonus = computeQualityScore(product);
    const recencyBonus = computeRecencyScore(product.created_at ?? undefined, safeNowMs);

    const isFromFollowedSeller = Boolean(
      product.user_id && followingSet.has(product.user_id)
    );
    const sellerFollowBonus = isFromFollowedSeller ? FOLLOWED_SELLER_BONUS : 0;

    const isEngaged = likedSet.has(product.id) || savedSet.has(product.id);
    const engagementBonus = isEngaged ? ENGAGEMENT_BONUS : 0;

    const ownItemPenalty = isOwn ? OWN_ITEM_PENALTY : 0;

    const tieJitter = hashStringToFloat(String(product.id)) * TIE_JITTER_WEIGHT;

    const explorationBonus = computeExplorationBonus(String(product.id), categorySat);

    const totalScore =
      FOR_YOU_V2_BASE_SCORE +
      qualityBonus +
      recencyBonus +
      tasteBonus +
      sellerFollowBonus +
      engagementBonus +
      ownItemPenalty +
      tieJitter +
      explorationBonus;

    return {
      product,
      score: totalScore,
      category: (product.category ?? "").toLowerCase().trim(),
      sellerId: (product.user_id ?? "").trim(),
      brand: (product.brand ?? "").toLowerCase().trim(),
    };
  });

  scoredCandidates.sort((a, b) => b.score - a.score);

  // 2. Diversity-aware interleaving: the same deterministic greedy
  //    anti-clustering pass as V1 (top-window selection, prev-1/prev-2
  //    category and seller/brand penalties).
  const remaining = [...scoredCandidates];
  const ranked: ScoredCandidate[] = [];

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestAdjustedScore = -Infinity;

    const searchWindowSize = Math.min(DIVERSITY_WINDOW_SIZE, remaining.length);

    const prev1 = ranked[ranked.length - 1];
    const prev2 = ranked[ranked.length - 2];

    for (let i = 0; i < searchWindowSize; i++) {
      const candidate = remaining[i];
      let adjustedScore = candidate.score;

      if (candidate.category && candidate.category === prev1?.category) {
        adjustedScore -= CATEGORY_PREV1_PENALTY;
      } else if (candidate.category && candidate.category === prev2?.category) {
        adjustedScore -= CATEGORY_PREV2_PENALTY;
      }

      const matchesPrev1Seller =
        (candidate.sellerId && candidate.sellerId === prev1?.sellerId) ||
        (candidate.brand && candidate.brand === prev1?.brand);
      const matchesPrev2Seller =
        (candidate.sellerId && candidate.sellerId === prev2?.sellerId) ||
        (candidate.brand && candidate.brand === prev2?.brand);

      if (matchesPrev1Seller) {
        adjustedScore -= SELLER_BRAND_PREV1_PENALTY;
      } else if (matchesPrev2Seller) {
        adjustedScore -= SELLER_BRAND_PREV2_PENALTY;
      }

      if (adjustedScore > bestAdjustedScore) {
        bestAdjustedScore = adjustedScore;
        bestIndex = i;
      }
    }

    const [selected] = remaining.splice(bestIndex, 1);
    ranked.push(selected);
  }

  return ranked.map((candidate) => candidate.product as T);
}
