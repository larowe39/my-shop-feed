export type CatalogStatus = "active" | "discontinued" | "upcoming" | "unknown";

export type CatalogAttributes = Record<string, unknown>;

export type CatalogCategory = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  sort_order: number;
  created_at: string;
};

export type CatalogSubcategory = {
  id: string;
  category_id: string;
  parent_subcategory_id: string | null;
  slug: string;
  name: string;
  description: string | null;
  sort_order: number;
  created_at: string;
};

export type CatalogBrand = {
  id: string;
  slug: string;
  name: string;
  website_url: string | null;
  logo_url: string | null;
  description: string | null;
  created_at: string;
};

export type CatalogProductFamily = {
  id: string;
  brand_id: string;
  subcategory_id: string | null;
  slug: string;
  name: string;
  description: string | null;
  created_at: string;
};

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

export type CatalogMatchCandidate = {
  product: CatalogProduct;
  brandName: string;
  categoryName?: string | null;
  aliases?: string[];
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
  const categoryMatches = Boolean(category && categoryName && category === categoryName);

  if (brandMatches && (title === productName || (modelNumber && title === modelNumber))) {
    return {
      productId: candidate.product.id,
      confidence: 0.98,
      reason: modelNumber && title === modelNumber ? "Exact brand + model number" : "Exact brand + product name",
    };
  }

  if (aliases.includes(title)) {
    return {
      productId: candidate.product.id,
      confidence: brandMatches ? 0.95 : 0.86,
      reason: brandMatches ? "Exact brand + alias" : "Exact alias",
    };
  }

  if (title === productName || (modelNumber && title === modelNumber)) {
    return {
      productId: candidate.product.id,
      confidence: categoryMatches ? 0.93 : 0.9,
      reason: modelNumber && title === modelNumber ? "Exact model number" : "Exact product name",
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
  return candidates
    .map((candidate) => scoreCandidate(input, candidate))
    .sort((left, right) => right.confidence - left.confidence || left.productId.localeCompare(right.productId));
}