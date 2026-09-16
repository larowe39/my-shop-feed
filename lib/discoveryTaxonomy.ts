export const CURATED_DISCOVERY_CATEGORY_SLUGS = [
  "fashion",
  "shoes",
  "watches",
  "automotive",
  "home",
  "outdoors",
  "beauty",
  "fitness",
  "accessories",
  "electronics",
] as const;

export function isDiscoveryCategoryVisible(slug: string): boolean {
  return CURATED_DISCOVERY_CATEGORY_SLUGS.includes(slug.trim().toLowerCase() as (typeof CURATED_DISCOVERY_CATEGORY_SLUGS)[number]);
}
