#!/usr/bin/env node
const path = require("path");
const { loadAndValidateCatalogData } = require("./lib/catalogDataLoader");

const examples = [
  ["Sony WH-1000XM5 Wireless Noise Cancelling Headphones", "Sony", "sony-wh-1000xm5", 0.74],
  ["Apple AirPods Max Space Gray", "Apple", "apple-airpods-max", 0.78],
  ["Fujifilm X100VI Digital Rangefinder Camera", "Fujifilm", "fujifilm-x100vi", 0.74],
  ["New Balance 990v6 Made in USA Core Grey", "New Balance", "new-balance-990v6", 0.74],
  ["Salomon XT-6 Advanced Trail Runners", "Salomon", "salomon-xt-6", 0.74],
  ["Tudor Black Bay 58 Automatic Diver 39mm", "Tudor", "tudor-black-bay-58", 0.78],
  ["NOCO Boost HD GB70 2000A UltraSafe Jump Starter", "NOCO", "noco-boost-hd-gb70", 0.74],
  ["Thule Motion XT Rooftop Cargo Box", "Thule", "thule-motion-xt", 0.74],
  ["Herman Miller Eames Lounge Chair and Ottoman in Walnut", "Herman Miller", "herman-miller-eames-lounge-chair", 0.74],
  ["Fellow Stagg EKG Electric Pour-Over Kettle", "Fellow", "fellow-stagg-ekg", 0.74],
  ["Yeti Tundra 45 Hard Cooler Desert Tan", "Yeti", "yeti-tundra-45", 0.74],
  ["Le Labo Santal 33 Eau de Parfum 100ml", "Le Labo", "le-labo-santal-33", 0.74],
  ["Birkenstock Boston Soft Footbed Suede Clogs", "Birkenstock", "birkenstock-boston-soft-footbed", 0.78],
];

function toCandidate(product, brandName) {
  return {
    product: {
      id: product.slug,
      brand_id: product.brandSlug,
      family_id: product.family ?? null,
      subcategory_id: null,
      slug: product.slug,
      name: product.name,
      model_number: product.modelNumber ?? null,
      release_year: product.releaseYear ?? null,
      description: product.description ?? null,
      upc: product.upc ?? null,
      gtin: product.gtin ?? null,
      mpn: product.mpn ?? null,
      status: product.status ?? "active",
      attributes: product.attributes ?? {},
      created_at: "",
      updated_at: "",
    },
    brandName,
    aliases: product.aliases ?? [],
  };
}

async function main() {
  const { normalizeCatalogText, findCatalogMatches } = await import("../lib/catalogMatching.ts");
  const loaded = loadAndValidateCatalogData(path.join(process.cwd(), "catalog-data"), normalizeCatalogText);
  if (loaded.errors.length) throw new Error(`Catalog validation failed with ${loaded.errors.length} error(s)`);
  const brands = new Map(loaded.brands.map((brand) => [brand.slug, brand.name]));

  console.log("LISTING | OLD | NEW | CANONICAL CANDIDATE | MATCH REASON");
  for (const [title, brand, expectedSlug, oldScore] of examples) {
    const expectedProduct = loaded.products.find((product) => product.slug === expectedSlug);
    if (!expectedProduct) throw new Error(`Missing expected catalog product: ${expectedSlug}`);
    const candidates = loaded.products
      .filter((product) => product.brandSlug === expectedProduct.brandSlug)
      .map((product) => toCandidate(product, brands.get(product.brandSlug)));
    const expected = candidates.find((item) => item.product.id === expectedSlug);
    const match = findCatalogMatches({ title, brand }, candidates).find(
      (item) => item.productId === expected.product.id
    );
    console.log(`${title} | ${oldScore.toFixed(2)} | ${match.confidence.toFixed(2)} | ${brand} ${expected.product.name} | ${match.reason}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});