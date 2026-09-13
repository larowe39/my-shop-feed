import type { Product, SellerProfile } from "../hooks/ProductsContext";

export function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function words(value: string): string[] {
  return normalizeSearchQuery(value).split(/\s+/).filter(Boolean);
}

function fieldScore(field: string, query: string): number {
  const normalizedField = normalizeSearchQuery(field);
  if (!normalizedField || !query) return 0;
  if (normalizedField === query) return 100;
  if (normalizedField.startsWith(query)) return 75;
  if (words(normalizedField).some((word) => word.startsWith(query))) return 55;
  if (normalizedField.includes(query)) return 35;
  return 0;
}

export function rankSearchProducts(products: Product[], query: string): Product[] {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) return [];

  return products
    .map((product, index) => ({
      product,
      score:
        fieldScore(product.title, normalizedQuery) * 3 +
        fieldScore(product.brand, normalizedQuery) * 2 +
        fieldScore(product.category, normalizedQuery) +
        (products.length - index) / Math.max(1, products.length),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ product }) => product);
}

export function rankSearchSellers(sellers: SellerProfile[], query: string): SellerProfile[] {
  const normalizedQuery = normalizeSearchQuery(query);
  return sellers
    .map((seller, index) => ({
      seller,
      score:
        fieldScore(seller.display_name, normalizedQuery) * 2 +
        fieldScore(seller.bio ?? "", normalizedQuery) +
        (sellers.length - index) / Math.max(1, sellers.length),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ seller }) => seller);
}