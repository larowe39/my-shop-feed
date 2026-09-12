import type { Product } from "../hooks/ProductsContext";

export type CategoryItem = {
  id: string;
  name: string;
  subtitle: string;
  imageUrl: string;
  keywords: string[];
};

export const CATEGORIES: CategoryItem[] = [
  {
    id: "fashion",
    name: "Fashion",
    subtitle: "Apparel, streetwear & outerwear",
    imageUrl:
      "https://images.unsplash.com/photo-1490481651871-ab68de25d43d?auto=format&fit=crop&w=800&q=80",
    keywords: [
      "fashion",
      "hoodies",
      "hoodie",
      "apparel",
      "clothing",
      "streetwear",
      "shirt",
      "shirts",
      "t-shirt",
      "tshirt",
      "pants",
      "jacket",
      "jackets",
      "outerwear",
      "tops",
      "sweater",
      "sweatshirt",
      "denim",
      "jeans",
      "vintage",
    ],
  },
  {
    id: "shoes",
    name: "Shoes",
    subtitle: "Sneakers, boots & footwear",
    imageUrl:
      "https://images.unsplash.com/photo-1552346154-21d32810aba3?auto=format&fit=crop&w=800&q=80",
    keywords: [
      "shoes",
      "shoe",
      "sneakers",
      "sneaker",
      "footwear",
      "boots",
      "boot",
      "kicks",
      "runners",
      "loafers",
      "sandals",
      "slides",
    ],
  },
  {
    id: "watches",
    name: "Watches",
    subtitle: "Timepieces, luxury & vintage",
    imageUrl:
      "https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?auto=format&fit=crop&w=800&q=80",
    keywords: [
      "watches",
      "watch",
      "timepiece",
      "timepieces",
      "horology",
      "chronograph",
      "diver",
      "automatic",
    ],
  },
  {
    id: "automotive",
    name: "Automotive",
    subtitle: "Vehicles, parts & garage gear",
    imageUrl:
      "https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=800&q=80",
    keywords: [
      "automotive",
      "auto",
      "car",
      "cars",
      "motorcycle",
      "moto",
      "vehicle",
      "vehicles",
      "parts",
      "racing",
      "garage",
    ],
  },
  {
    id: "home",
    name: "Home",
    subtitle: "Living, interior & decor",
    imageUrl:
      "https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?auto=format&fit=crop&w=800&q=80",
    keywords: [
      "home",
      "interior",
      "decor",
      "furniture",
      "living",
      "kitchen",
      "art",
      "lighting",
      "architecture",
      "ceramics",
    ],
  },
  {
    id: "electronics",
    name: "Electronics",
    subtitle: "Audio, gadgets & tech essentials",
    imageUrl:
      "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=800&q=80",
    keywords: [
      "electronics",
      "tech",
      "audio",
      "gadgets",
      "gadget",
      "headphones",
      "earbuds",
      "speakers",
      "speaker",
      "camera",
      "keyboard",
      "computer",
      "phone",
    ],
  },
  {
    id: "outdoors",
    name: "Outdoors",
    subtitle: "Trail, camp & adventure gear",
    imageUrl:
      "https://images.unsplash.com/photo-1501555088652-021faa106b9b?auto=format&fit=crop&w=800&q=80",
    keywords: [
      "outdoors",
      "outdoor",
      "camping",
      "camp",
      "hiking",
      "hike",
      "trail",
      "climbing",
      "adventure",
      "backpacking",
      "trekking",
    ],
  },
  {
    id: "beauty",
    name: "Beauty",
    subtitle: "Skincare, grooming & fragrance",
    imageUrl:
      "https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=800&q=80",
    keywords: [
      "beauty",
      "skincare",
      "grooming",
      "fragrance",
      "cologne",
      "perfume",
      "cosmetics",
      "wellness",
      "body",
    ],
  },
  {
    id: "fitness",
    name: "Fitness",
    subtitle: "Activewear, equipment & training",
    imageUrl:
      "https://images.unsplash.com/photo-1517838277536-f5f99be501cd?auto=format&fit=crop&w=800&q=80",
    keywords: [
      "fitness",
      "gym",
      "workout",
      "training",
      "activewear",
      "sports",
      "sport",
      "athletic",
      "running",
      "exercise",
      "weights",
    ],
  },
  {
    id: "accessories",
    name: "Accessories",
    subtitle: "Bags, eyewear & jewelry",
    imageUrl:
      "https://images.unsplash.com/photo-1548036328-c9fa89d128fa?auto=format&fit=crop&w=800&q=80",
    keywords: [
      "accessories",
      "accessory",
      "bags",
      "bag",
      "tote",
      "backpack",
      "jewelry",
      "wallet",
      "sunglasses",
      "eyewear",
      "glasses",
      "hat",
      "hats",
      "cap",
      "belt",
      "belts",
    ],
  },
];

export function matchProductCategory(
  productCategory: string | undefined | null,
  targetCategorySlugOrName: string
): boolean {
  if (!productCategory) return false;
  const prodCatNorm = productCategory.trim().toLowerCase();
  const targetNorm = targetCategorySlugOrName.trim().toLowerCase();

  if (targetNorm === "all") {
    return true;
  }

  // 1. Exact match
  if (prodCatNorm === targetNorm) {
    return true;
  }

  // 2. Curated category alias match
  const curated = CATEGORIES.find(
    (c) =>
      c.id.toLowerCase() === targetNorm || c.name.toLowerCase() === targetNorm
  );

  if (curated) {
    if (
      curated.keywords.some(
        (kw) => prodCatNorm === kw || prodCatNorm.includes(kw) || kw.includes(prodCatNorm)
      )
    ) {
      return true;
    }
  }

  // 3. Fallback substring match
  return prodCatNorm.includes(targetNorm) || targetNorm.includes(prodCatNorm);
}

export function getCategoryInfo(slugOrName: string): CategoryItem {
  const normalized = (slugOrName ?? "").trim().toLowerCase();
  const found = CATEGORIES.find(
    (c) =>
      c.id.toLowerCase() === normalized ||
      c.name.toLowerCase() === normalized
  );
  if (found) return found;

  const displayName = slugOrName
    ? slugOrName.charAt(0).toUpperCase() + slugOrName.slice(1)
    : "Category";

  return {
    id: normalized || "category",
    name: displayName,
    subtitle: "Curated collection",
    imageUrl:
      "https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=800&q=80",
    keywords: [normalized],
  };
}

export function getCategoryProductCount(
  products: Product[],
  categoryId: string
): number {
  return products.filter((p) => matchProductCategory(p.category, categoryId)).length;
}
