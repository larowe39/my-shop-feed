// lib/feedRanking.ts
import type { Product } from "../hooks/ProductsContext";

export interface RankFeedOptions {
  likedIds?: string[];
  savedIds?: string[];
  followingIds?: string[];
  currentUserId?: string | null;
}

export interface ProductScoredItem {
  product: Product;
  score: number;
  category: string;
  sellerId: string;
  brand: string;
}

/**
 * Deterministic hash of a string to a pseudo-random float in [0, 1).
 * Ensures stable tie-breaking across renders without arbitrary re-sorting flickers.
 */
function hashStringToFloat(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  const positive = Math.abs(hash);
  return (positive % 10000) / 10000;
}

/**
 * Computes a recency multiplier (0.0 - 0.25) based on product creation timestamp.
 */
function computeRecencyScore(createdAt?: string): number {
  if (!createdAt) return 0.05;
  try {
    const time = new Date(createdAt).getTime();
    if (isNaN(time)) return 0.05;
    const now = Date.now();
    const ageInHours = Math.max(0, (now - time) / (1000 * 60 * 60));
    // Gradual decay over 14 days (336 hours)
    const decay = Math.max(0, 1 - ageInHours / 336);
    return decay * 0.25;
  } catch {
    return 0.05;
  }
}

/**
 * Computes a quality multiplier (0.0 - 0.20) based on completeness of product data.
 */
function computeQualityScore(product: Product): number {
  let score = 0;
  if (product.image_url && product.image_url.trim().length > 0) score += 0.1;
  if (product.brand && product.brand.trim().length > 0) score += 0.04;
  if (product.price && product.price.trim().length > 0) score += 0.03;
  if (product.url && product.url.trim().length > 0) score += 0.03;
  return score;
}

/**
 * Builds normalized user category affinities from liked and saved products.
 */
function computeUserCategoryAffinity(
  products: Product[],
  likedSet: Set<string>,
  savedSet: Set<string>
): Record<string, number> {
  const categoryScores: Record<string, number> = {};
  let maxScore = 0;

  for (const product of products) {
    if (!product.category) continue;
    const cat = product.category.toLowerCase().trim();
    let weight = 0;
    if (likedSet.has(product.id)) weight += 1.0;
    if (savedSet.has(product.id)) weight += 1.5; // Saves indicate higher buying/curation intent

    if (weight > 0) {
      categoryScores[cat] = (categoryScores[cat] || 0) + weight;
      if (categoryScores[cat] > maxScore) {
        maxScore = categoryScores[cat];
      }
    }
  }

  // Normalize scores to [0, 1]
  const normalized: Record<string, number> = {};
  if (maxScore > 0) {
    for (const [cat, raw] of Object.entries(categoryScores)) {
      normalized[cat] = raw / maxScore;
    }
  }

  return normalized;
}

/**
 * Ranks products for the "FOR YOU" feed.
 *
 * Algorithm highlights:
 * 1. Base Quality & Recency: Evaluates freshness and listing completeness.
 * 2. Personalization Affinities: Boosts items from followed sellers, liked/saved categories.
 * 3. Diversity-Aware Interleaving: Uses maximum marginal diversity to avoid consecutive
 *    clumping of identical categories or sellers/brands.
 * 4. Cold-Start Resilient: For guests or new users without activity, produces an evenly
 *    interleaved showcase across all categories and sellers.
 */
export function rankForYouFeed(
  products: Product[],
  options: RankFeedOptions = {}
): Product[] {
  if (!products || products.length <= 1) {
    return products ? [...products] : [];
  }

  const {
    likedIds = [],
    savedIds = [],
    followingIds = [],
    currentUserId = null,
  } = options;

  const likedSet = new Set(likedIds);
  const savedSet = new Set(savedIds);
  const followingSet = new Set(followingIds);

  const categoryAffinities = computeUserCategoryAffinity(
    products,
    likedSet,
    savedSet
  );

  // 1. Calculate individual affinity score for each product
  const scoredCandidates: ProductScoredItem[] = products.map((product) => {
    const baseScore = 1.0;
    const qualityBonus = computeQualityScore(product);
    const recencyBonus = computeRecencyScore(product.created_at);

    const catKey = (product.category ?? "").toLowerCase().trim();
    const categoryAffinityMultiplier = categoryAffinities[catKey] ?? 0;
    const categoryBonus = categoryAffinityMultiplier * 0.35;

    const isFromFollowedSeller = Boolean(
      product.user_id && followingSet.has(product.user_id)
    );
    const sellerBonus = isFromFollowedSeller ? 0.3 : 0;

    const isEngaged = likedSet.has(product.id) || savedSet.has(product.id);
    const engagementBonus = isEngaged ? 0.08 : 0;

    // Slight discovery de-prioritization of current user's own items in For You
    const ownItemPenalty =
      currentUserId && product.user_id === currentUserId ? -0.15 : 0;

    // Deterministic jitter for tie-breaking and variety balance
    const tieJitter = hashStringToFloat(String(product.id)) * 0.08;

    const totalScore =
      baseScore +
      qualityBonus +
      recencyBonus +
      categoryBonus +
      sellerBonus +
      engagementBonus +
      ownItemPenalty +
      tieJitter;

    return {
      product,
      score: totalScore,
      category: catKey,
      sellerId: (product.user_id ?? "").trim(),
      brand: (product.brand ?? "").toLowerCase().trim(),
    };
  });

  // Sort initially by total affinity score descending
  scoredCandidates.sort((a, b) => b.score - a.score);

  // 2. Diversity-Aware Interleaving (Greedy Anti-Clustering Selection)
  // Prevents consecutive runs of same category or same seller/brand.
  const remaining = [...scoredCandidates];
  const rankedProducts: Product[] = [];

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestAdjustedScore = -Infinity;

    // Consider the top window of candidates for the next slot
    const searchWindowSize = Math.min(10, remaining.length);

    const prev1 = rankedProducts[rankedProducts.length - 1];
    const prev2 = rankedProducts[rankedProducts.length - 2];

    const prev1Category = (prev1?.category ?? "").toLowerCase().trim();
    const prev2Category = (prev2?.category ?? "").toLowerCase().trim();
    const prev1Brand = (prev1?.brand ?? "").toLowerCase().trim();
    const prev2Brand = (prev2?.brand ?? "").toLowerCase().trim();
    const prev1Seller = (prev1?.user_id ?? "").trim();
    const prev2Seller = (prev2?.user_id ?? "").trim();

    for (let i = 0; i < searchWindowSize; i++) {
      const candidate = remaining[i];
      let adjustedScore = candidate.score;

      // Category diversity penalty
      if (candidate.category && candidate.category === prev1Category) {
        adjustedScore -= 0.5; // Strong penalty for back-to-back same category
      } else if (candidate.category && candidate.category === prev2Category) {
        adjustedScore -= 0.22; // Moderate penalty for category seen 2 items ago
      }

      // Seller / Brand diversity penalty
      const matchesPrev1Seller =
        (candidate.sellerId && candidate.sellerId === prev1Seller) ||
        (candidate.brand && candidate.brand === prev1Brand);

      const matchesPrev2Seller =
        (candidate.sellerId && candidate.sellerId === prev2Seller) ||
        (candidate.brand && candidate.brand === prev2Brand);

      if (matchesPrev1Seller) {
        adjustedScore -= 0.6; // Strong penalty for consecutive same seller/brand
      } else if (matchesPrev2Seller) {
        adjustedScore -= 0.25; // Moderate penalty for same seller 2 items ago
      }

      if (adjustedScore > bestAdjustedScore) {
        bestAdjustedScore = adjustedScore;
        bestIndex = i;
      }
    }

    const [selected] = remaining.splice(bestIndex, 1);
    rankedProducts.push(selected.product);
  }

  return rankedProducts;
}
