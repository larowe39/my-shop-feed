#!/usr/bin/env node
const assert = require("assert");

function candidate(id, brandName, name, modelNumber = null, aliases = []) {
  return {
    product: {
      id,
      brand_id: `${id}-brand`,
      family_id: null,
      subcategory_id: null,
      slug: id,
      name,
      model_number: modelNumber,
      release_year: null,
      description: null,
      upc: null,
      gtin: null,
      mpn: null,
      status: "active",
      attributes: {},
      created_at: "",
      updated_at: "",
    },
    brandName,
    aliases,
  };
}

async function main() {
  const { CATALOG_CONFIDENCE_THRESHOLDS, findCatalogMatches, hasAmbiguousHighConfidenceMatch } = await import("../lib/catalogMatching.ts");
  const high = CATALOG_CONFIDENCE_THRESHOLDS.high;
  const positives = [
    ["Sony WH-1000XM5 Wireless Noise Cancelling Headphones", "Sony", candidate("sony-wh-1000xm5", "Sony", "Sony WH-1000XM5", "WH-1000XM5")],
    ["Fujifilm X100VI Digital Rangefinder Camera", "Fujifilm", candidate("fujifilm-x100vi", "Fujifilm", "Fujifilm X100VI", "X100VI")],
    ["NOCO Boost HD GB70 2000A UltraSafe Jump Starter", "NOCO", candidate("noco-gb70", "NOCO", "NOCO Boost HD GB70", "GB70")],
    ["Yeti Tundra 45 Hard Cooler Desert Tan", "Yeti", candidate("yeti-tundra-45", "Yeti", "Yeti Tundra 45", "Tundra 45")],
    ["Fellow Stagg EKG Electric Pour-Over Kettle", "Fellow", candidate("fellow-stagg-ekg", "Fellow", "Fellow Stagg EKG", "Stagg EKG")],
    ["New Balance 990v6 Made in USA Core Grey", "New Balance", candidate("new-balance-990v6", "New Balance", "New Balance 990v6", "990v6")],
    ["Salomon XT-6 Advanced Trail Runners", "Salomon", candidate("salomon-xt-6", "Salomon", "Salomon XT-6", "XT-6")],
    ["Apple AirPods Max Space Gray", "Apple", candidate("apple-airpods-max", "Apple", "Apple AirPods Max")],
    ["Le Labo Santal 33 Eau de Parfum 100ml", "Le Labo", candidate("le-labo-santal-33", "Le Labo", "Le Labo Santal 33", "Santal 33")],
    ["Birkenstock Boston Soft Footbed Suede Clogs", "Birkenstock", candidate("birkenstock-boston-soft-footbed", "Birkenstock", "Birkenstock Boston Soft Footbed")],
  ];

  for (const [title, brand, expected] of positives) {
    const match = findCatalogMatches({ title, brand }, [expected])[0];
    assert.strictEqual(match.productId, expected.product.id, title);
    assert.ok(match.confidence >= high, `${title}: expected >= ${high}, got ${match.confidence}`);
  }

  const negatives = [
    ["Sony WH-1000XM4", "Sony", candidate("sony-wh-1000xm5", "Sony", "Sony WH-1000XM5", "WH-1000XM5")],
    ["iPhone 15 Pro", "Apple", candidate("iphone-15-pro-max", "Apple", "iPhone 15 Pro Max")],
    ["iPhone 15 Pro Max", "Apple", candidate("iphone-15-pro", "Apple", "iPhone 15 Pro")],
    ["Galaxy S24", "Samsung", candidate("galaxy-s24-ultra", "Samsung", "Galaxy S24 Ultra")],
    ["New Balance 990v5", "New Balance", candidate("new-balance-990v6", "New Balance", "New Balance 990v6", "990v6")],
    ["GoPro HERO12", "GoPro", candidate("gopro-hero13", "GoPro", "GoPro HERO13", "HERO13")],
    ["DeWalt DCD998", "DeWalt", candidate("dewalt-dcd999", "DeWalt", "DeWalt DCD999", "DCD999")],
    ["Rolex 124060", "Rolex", candidate("rolex-126610ln", "Rolex", "Rolex Submariner 126610LN", "126610LN")],
    ["Ford F-150", "Ford", candidate("ford-f-250", "Ford", "Ford F-250", "F-250")],
    ["Sony Wireless Headphones", "Sony", candidate("sony-wh-1000xm5", "Sony", "Sony WH-1000XM5", "WH-1000XM5")],
    ["Apple Headphones", "Apple", candidate("apple-airpods-max", "Apple", "Apple AirPods Max")],
    ["Bose WH-1000XM5", "Bose", candidate("sony-wh-1000xm5", "Sony", "Sony WH-1000XM5", "WH-1000XM5")],
    ["Samsung AirPods Max", "Samsung", candidate("apple-airpods-max", "Apple", "Apple AirPods Max")],
    ["Nike 990v6", "Nike", candidate("new-balance-990v6", "New Balance", "New Balance 990v6", "990v6")],
    ["Makita DCD999", "Makita", candidate("dewalt-dcd999", "DeWalt", "DeWalt DCD999", "DCD999")],
    ["Rolex Watch", "Rolex", candidate("rolex-submariner", "Rolex", "Rolex Submariner 126610LN", "126610LN")],
    ["Nike Running Shoes", "Nike", candidate("nike-pegasus", "Nike", "Nike Air Zoom Pegasus 41")],
    ["DeWalt Drill", "DeWalt", candidate("dewalt-dcd999", "DeWalt", "DeWalt DCD999", "DCD999")],
    ["Yeti Cooler", "Yeti", candidate("yeti-tundra-45", "Yeti", "Yeti Tundra 45", "Tundra 45")],
    ["Dyson Vacuum", "Dyson", candidate("dyson-v15", "Dyson", "Dyson V15 Detect")],
    ["Canon Camera", "Canon", candidate("canon-r5", "Canon", "Canon EOS R5")],
  ];

  for (const [title, brand, incorrect] of negatives) {
    const match = findCatalogMatches({ title, brand }, [incorrect])[0];
    assert.ok(match.confidence < high, `${title}: incorrect ${incorrect.product.name} scored ${match.confidence}`);
  }

  const descriptive = findCatalogMatches(
    { title: "Snow Peak Titanium Trek 900 Ultra-Light Cookset", brand: "Snow Peak" },
    [candidate("snow-peak-trek-900", "Snow Peak", "Titanium Trek 900")]
  )[0];
  assert.ok(descriptive.confidence >= high, `descriptive suffix scored ${descriptive.confidence}`);

  const overlapping = [
    candidate("iphone-15", "Apple", "iPhone 15"),
    candidate("iphone-15-pro", "Apple", "iPhone 15 Pro"),
    candidate("iphone-15-pro-max", "Apple", "iPhone 15 Pro Max"),
  ];
  const best = findCatalogMatches(
    { title: "Apple iPhone 15 Pro Max 256GB Natural Titanium", brand: "Apple" },
    overlapping
  )[0];
  assert.strictEqual(best.productId, "iphone-15-pro-max");
  assert.ok(best.confidence >= high);

  const ambiguous = findCatalogMatches(
    { title: "Acme ZX-100", brand: "Acme" },
    [
      candidate("acme-zx-100-black", "Acme", "Acme ZX-100", "ZX-100"),
      candidate("acme-zx-100-white", "Acme", "Acme ZX-100", "ZX-100"),
    ]
  );
  assert.ok(hasAmbiguousHighConfidenceMatch(ambiguous));

  console.log("Catalog matcher regression tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});