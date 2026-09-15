import type { Product, SellerProfile } from "../hooks/ProductsContext";

export function normalizeSearchQuery(value: string): string {
  return (value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(value: string): string[] {
  return normalizeSearchQuery(value).split(" ").filter(Boolean);
}

function uniqueWords(value: string): string[] {
  return Array.from(new Set(words(value)));
}

function fieldRelevance(field: string, queryTokens: string[]): number {
  const fieldTokens = uniqueWords(field);
  if (!fieldTokens.length || !queryTokens.length) return 0;

  return queryTokens.reduce((score, queryToken) => {
    if (fieldTokens.includes(queryToken)) return score + 30;
    if (fieldTokens.some((fieldToken) => fieldToken.startsWith(queryToken))) return score + 20;
    if (fieldTokens.some((fieldToken) => fieldToken.includes(queryToken))) return score + 8;
    return score;
  }, 0);
}

export function rankSearchProducts(products: Product[], query: string): Product[] {
  const queryTokens = uniqueWords(query);
  if (!queryTokens.length) return [];

  return products
    .map((product, index) => {
      const title = normalizeSearchQuery(product.title);
      const brand = normalizeSearchQuery(product.brand);
      const category = normalizeSearchQuery(product.category);
      const catalogTerms = (product.catalog_search_terms ?? []).join(" ");
      const normalizedQuery = queryTokens.join(" ");
      const combinedTokens = uniqueWords(`${brand} ${title} ${catalogTerms}`);
      const matchedTokenCount = queryTokens.filter((queryToken) =>
        combinedTokens.some(
          (fieldToken) =>
            fieldToken === queryToken ||
            fieldToken.startsWith(queryToken) ||
            fieldToken.includes(queryToken)
        )
      ).length;

      if (!matchedTokenCount) return { product, score: 0 };

      let score = matchedTokenCount * 180;
      if (title === normalizedQuery) score += 1000;
      if (`${brand} ${title}` === normalizedQuery) score += 1200;
      if (brand === normalizedQuery) score += 700;
      score += fieldRelevance(title, queryTokens) * 4;
      score += fieldRelevance(brand, queryTokens) * 5;
      score += fieldRelevance(catalogTerms, queryTokens) * 3;
      score += fieldRelevance(category, queryTokens);

      if (queryTokens.every((queryToken) => uniqueWords(title).includes(queryToken))) score += 300;

      // Feed position can break ties among textual matches, but never create a result.
      score += (products.length - index) / Math.max(1, products.length);
      return { product, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ product }) => product);
}

export function rankSearchSellers(sellers: SellerProfile[], query: string): SellerProfile[] {
  const queryTokens = uniqueWords(query);
  if (!queryTokens.length) return [];

  return sellers
    .map((seller, index) => ({
      seller,
      score:
        fieldRelevance(seller.display_name, queryTokens) * 4 +
        fieldRelevance(seller.bio ?? "", queryTokens) * 2 +
        (sellers.length - index) / Math.max(1, sellers.length),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ seller }) => seller);
}