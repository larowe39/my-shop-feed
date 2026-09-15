// lib/catalogMatching.ts
//
// Pure, dependency-free catalog matching helpers shared by the app (lib/catalog.ts)
// and the offline backfill script (scripts/backfill-catalog-matches.js). Keeping
// these functions free of any supabase/react-native imports lets Node import this
// file directly (no bundler) so both callers always score matches identically.

export type CatalogStatus = "active" | "discontinued" | "upcoming" | "unknown";

export type CatalogAttributes = Record<string, unknown>;

export type CatalogProduct = {
  id: string;
  brand_id: string;
  family_id: string | null;
  subcategory_id: string | null;
  slug: string;
  name: string;
  model_number: string | null;
  release_year: number | null;
  description: string | null;
  upc: string | null;
  gtin: string | null;
  mpn: string | null;
  status: CatalogStatus;
  attributes: CatalogAttributes;
  created_at: string;
  updated_at: string;
};

export type CatalogProductVariant = {
  id: string;
  product_id: string;
  slug: string;
  name: string;
  sku: string | null;
  upc: string | null;
  gtin: string | null;
  color: string | null;
  size: string | null;
  attributes: CatalogAttributes;
  created_at: string;
};

export type CatalogVariantCandidate = {
  variant: CatalogProductVariant;
  aliases?: string[];
};

export type CatalogMatchCandidate = {
  product: CatalogProduct;
  brandName: string;
  categoryName?: string | null;
  aliases?: string[];
  variants?: CatalogVariantCandidate[];
};

export type CatalogMatchInput = {
  title: string;
  brand?: string | null;
  category?: string | null;
};

export type CatalogMatch = {
  productId: string;
  confidence: number;
  reason: string;
};

export type ResolvedCatalogMatch = {
  match: CatalogMatch;
  productName: string;
  variantId: string | null;
  variantName: string | null;
};

export const CATALOG_CONFIDENCE_THRESHOLDS = {
  high: 0.9,
  possible: 0.7,
} as const;

export function normalizeCatalogText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  return normalizeCatalogText(value).split(" ").filter(Boolean);
}

function tokenOverlap(left: string, right: string): number {
  const leftTokens = new Set(tokens(left));
  const rightTokens = new Set(tokens(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return shared / Math.max(leftTokens.size, rightTokens.size);
}

function compact(value: string): string {
  return normalizeCatalogText(value).replace(/\s+/g, "");
}

function catalogTextMatches(left: string, right: string): boolean {
  return normalizeCatalogText(left) === normalizeCatalogText(right) || compact(left) === compact(right);
}

const GENERIC_IDENTITY_TOKENS = new Set([
  "classic", "headphones", "max", "pro", "series", "speaker", "ultra", "watch",
]);
const SPECIFICITY_SUFFIXES = new Set(["max", "plus", "pro", "ultra"]);

function containsWholePhrase(title: string, phrase: string): boolean {
  return Boolean(phrase) && ` ${title} `.includes(` ${phrase} `);
}

function hasDistinctiveIdentity(phrase: string): boolean {
  const phraseTokens = tokens(phrase);
  return phraseTokens.some((token) => /(?=.*[a-z])(?=.*\d)/.test(token)) ||
    (phraseTokens.length >= 2 && phraseTokens.some((token) => !GENERIC_IDENTITY_TOKENS.has(token)));
}

function containsModelIdentifier(title: string, modelNumber: string): boolean {
  const model = compact(modelNumber);
  if (!model || !/[a-z]/.test(model) || !/\d/.test(model)) return false;
  return compact(title).includes(model);
}

function hasSpecificityExtension(title: string, identity: string): boolean {
  const index = ` ${title} `.indexOf(` ${identity} `);
  if (index === -1) return false;
  const following = tokens(title.slice(index + identity.length));
  const suffix = following[0];
  const identityTokens = tokens(identity);
  const lastIdentityToken = identityTokens[identityTokens.length - 1] ?? "";
  if (suffix === "max" || suffix === "plus") return true;
  if (suffix === "pro") return /^\d+$/.test(lastIdentityToken);
  return suffix === "ultra" && /[a-z]/.test(lastIdentityToken) && /\d/.test(lastIdentityToken);
}

function scoreCandidate(input: CatalogMatchInput, candidate: CatalogMatchCandidate): CatalogMatch {
  const title = normalizeCatalogText(input.title);
  const brand = normalizeCatalogText(input.brand);
  const category = normalizeCatalogText(input.category);
  const productName = normalizeCatalogText(candidate.product.name);
  const modelNumber = normalizeCatalogText(candidate.product.model_number);
  const brandName = normalizeCatalogText(candidate.brandName);
  const categoryName = normalizeCatalogText(candidate.categoryName);
  const aliases = (candidate.aliases ?? []).map(normalizeCatalogText).filter(Boolean);
  const brandMatches = Boolean(brand && brandName && brand === brandName);
  const brandConflicts = Boolean(brand && brandName && brand !== brandName);
  const categoryMatches = Boolean(category && categoryName && category === categoryName);
  const titleWithoutBrand = brandMatches && title.startsWith(`${brandName} `)
    ? title.slice(brandName.length + 1)
    : title;
  const titleForms = [title, titleWithoutBrand];
  const exactProductMatch = titleForms.some(
    (titleForm) => catalogTextMatches(titleForm, productName) || (modelNumber && catalogTextMatches(titleForm, modelNumber))
  );
  const exactAliasMatch = titleForms.some((titleForm) => aliases.some((alias) => catalogTextMatches(titleForm, alias)));
  const containedProductIdentity = containsWholePhrase(title, productName) && hasDistinctiveIdentity(productName);
  const containedAlias = aliases.find(
    (alias) => containsWholePhrase(title, alias) && hasDistinctiveIdentity(alias)
  );
  const modelIdentifierMatches = containsModelIdentifier(title, modelNumber);
  const hasConflictingSpecificity = hasSpecificityExtension(title, productName) ||
    aliases.some((alias) => hasSpecificityExtension(title, alias));
  const exactVariantMatch = (candidate.variants ?? []).some(
    (variant) => scoreVariant(input, candidate, variant) >= CATALOG_CONFIDENCE_THRESHOLDS.high
  );

  if (brandConflicts) {
    return {
      productId: candidate.product.id,
      confidence: 0.2,
      reason: "Conflicting explicit brand",
    };
  }

  if (hasConflictingSpecificity) {
    return {
      productId: candidate.product.id,
      confidence: 0.3,
      reason: "Listing contains a more specific product identity",
    };
  }

  if (brandMatches && exactVariantMatch) {
    return {
      productId: candidate.product.id,
      confidence: 0.98,
      reason: "Exact brand + product variant",
    };
  }

  if (brandMatches && exactProductMatch) {
    return {
      productId: candidate.product.id,
      confidence: 0.98,
      reason: modelNumber && titleForms.some((titleForm) => catalogTextMatches(titleForm, modelNumber))
        ? "Exact brand + model number"
        : "Exact brand + product name",
    };
  }

  if (exactAliasMatch) {
    return {
      productId: candidate.product.id,
      confidence: brandMatches ? 0.95 : 0.86,
      reason: brandMatches ? "Exact brand + alias" : "Exact alias",
    };
  }

  if (exactProductMatch) {
    return {
      productId: candidate.product.id,
      confidence: categoryMatches ? 0.93 : 0.9,
      reason: modelNumber && titleForms.some((titleForm) => catalogTextMatches(titleForm, modelNumber))
        ? "Exact model number"
        : "Exact product name",
    };
  }

  if (brandMatches && modelIdentifierMatches) {
    return {
      productId: candidate.product.id,
      confidence: 0.97,
      reason: "Exact brand + distinctive model identifier",
    };
  }

  if (brandMatches && containedAlias) {
    return {
      productId: candidate.product.id,
      confidence: 0.96,
      reason: "Exact normalized alias + brand",
    };
  }

  if (brandMatches && containedProductIdentity) {
    return {
      productId: candidate.product.id,
      confidence: 0.95,
      reason: "Complete canonical identity contained in listing",
    };
  }

  const comparableNames = [productName, modelNumber, ...aliases].filter(Boolean);
  const bestOverlap = Math.max(0, ...comparableNames.map((name) => tokenOverlap(title, name)));
  const startsWithMatch = comparableNames.some((name) => name.startsWith(title) || title.startsWith(name));
  const substringMatch = comparableNames.some((name) => name.includes(title) || title.includes(name));
  const confidence = brandMatches && bestOverlap >= 0.5
    ? 0.78
    : startsWithMatch
      ? 0.74
      : bestOverlap >= 0.5
        ? 0.7
        : substringMatch
          ? 0.62
          : Math.min(0.59, bestOverlap * 0.59);

  return {
    productId: candidate.product.id,
    confidence: Number(confidence.toFixed(2)),
    reason: brandMatches && bestOverlap >= 0.5
      ? "Brand + product token overlap"
      : startsWithMatch
        ? "Starts-with product match"
        : bestOverlap >= 0.5
          ? "Product token overlap"
          : substringMatch
            ? "Product substring match"
            : "Weak catalog similarity",
  };
}

export function findCatalogMatches(
  input: CatalogMatchInput,
  candidates: CatalogMatchCandidate[]
): CatalogMatch[] {
  const title = normalizeCatalogText(input.title);
  const scored = candidates.map((candidate) => ({ candidate, match: scoreCandidate(input, candidate) }));
  return scored
    .map(({ candidate, match }) => {
      const productName = normalizeCatalogText(candidate.product.name);
      const hasMoreSpecificIdentity = scored.some(({ candidate: other }) => {
        const otherName = normalizeCatalogText(other.product.name);
        const remainingTokens = tokens(otherName).slice(tokens(productName).length);
        return other.product.id !== candidate.product.id &&
          containsWholePhrase(title, productName) &&
          containsWholePhrase(title, otherName) &&
          otherName.startsWith(`${productName} `) &&
          (remainingTokens.length > 1 || SPECIFICITY_SUFFIXES.has(remainingTokens[0]));
      });
      if (match.confidence >= CATALOG_CONFIDENCE_THRESHOLDS.high && hasMoreSpecificIdentity) {
        return {
          ...match,
          confidence: 0.89,
          reason: "More specific canonical identity is contained in listing",
        };
      }
      return match;
    })
    .sort((left, right) => right.confidence - left.confidence || left.productId.localeCompare(right.productId));
}

export function hasAmbiguousHighConfidenceMatch(matches: CatalogMatch[]): boolean {
  return new Set(
    matches
      .filter((match) => match.confidence >= CATALOG_CONFIDENCE_THRESHOLDS.high)
      .map((match) => match.productId)
  ).size > 1;
}

function scoreVariant(
  input: CatalogMatchInput,
  candidate: CatalogMatchCandidate,
  variant: CatalogVariantCandidate
): number {
  const title = normalizeCatalogText(input.title);
  const brandName = normalizeCatalogText(candidate.brandName);
  const productName = normalizeCatalogText(candidate.product.name);
  const variantName = normalizeCatalogText(variant.variant.name);
  const aliases = (variant.aliases ?? []).map(normalizeCatalogText).filter(Boolean);
  const exactNames = [
    `${brandName} ${productName} ${variantName}`,
    `${productName} ${variantName}`,
    ...aliases,
  ].filter(Boolean);

  if (exactNames.some((name) => catalogTextMatches(title, name))) return 0.98;

  const variantValue = normalizeCatalogText(
    [variant.variant.color, variant.variant.size].filter(Boolean).join(" ")
  );
  if (variantValue && catalogTextMatches(title, `${productName} ${variantValue}`)) return 0.94;
  return 0;
}

export function addVariantMatch(
  input: CatalogMatchInput,
  candidate: CatalogMatchCandidate,
  match: CatalogMatch
): ResolvedCatalogMatch {
  const bestVariant = (candidate.variants ?? [])
    .map((variant) => ({ variant, confidence: scoreVariant(input, candidate, variant) }))
    .filter((item) => item.confidence >= CATALOG_CONFIDENCE_THRESHOLDS.high)
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.variant.variant.id.localeCompare(right.variant.variant.id)
    )[0]?.variant;

  return {
    match,
    productName: candidate.product.name,
    variantId: bestVariant?.variant.id ?? null,
    variantName: bestVariant?.variant.name ?? null,
  };
}
