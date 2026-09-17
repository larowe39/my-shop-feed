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
  const matcher = await import("../lib/catalogMatching.ts");
  const { createCatalogMatcherIndex, findCatalogMatches, findCatalogMatchesWithIndex, hasAmbiguousHighConfidenceMatch } = matcher;
  const acquisition = await import("../lib/catalogAcquisition.ts");
  const catalog = [
    candidate("iphone-15-pro", "Apple", "iPhone 15 Pro", null, ["Apple iPhone 15 Pro"]),
    candidate("iphone-15-pro-max", "Apple", "iPhone 15 Pro Max"),
    candidate("sony-xm4", "Sony", "WH-1000XM4", "WH-1000XM4"),
    candidate("sony-xm5", "Sony", "WH-1000XM5", "WH-1000XM5", ["WH1000XM5"]),
    candidate("gopro-12", "GoPro", "HERO12 Black", "HERO12", ["GoPro Hero 12"]),
    candidate("gopro-13", "GoPro", "HERO13 Black", "HERO13", ["GoPro Hero 13"]),
    candidate("new-balance-990v5", "New Balance", "990v5", "990v5"),
    candidate("new-balance-990v6", "New Balance", "990v6", "990v6"),
    candidate("dewalt-dcd998", "DeWalt", "DCD998", "DCD998"),
    candidate("dewalt-dcd999", "DeWalt", "DCD999", "DCD999"),
    candidate("brembo-high-performance", "Brembo", "High Performance 6-Piston Kit", "HP-6P", ["Brembo GT Gran Turismo 6-Piston Big Brake Kit"]),
    candidate("brembo-gt", "Brembo", "GT Gran Turismo", "GT-GT"),
  ];
  const index = createCatalogMatcherIndex(catalog);
  const canonicalCatalog = catalog.map((entry) => ({
    brand: entry.brandName,
    productName: entry.product.name,
    modelNumber: entry.product.model_number,
    aliases: entry.aliases,
  }));
  const corpus = [
    { title: "Apple iPhone 15 Pro", brand: "Apple" },
    { title: "apple iphone 15 pro max", brand: "APPLE" },
    { title: "Sony WH1000XM5", brand: "Sony" },
    { title: "Sony WH-1000XM4", brand: "Sony" },
    { title: "GoPro Hero 13", brand: "GoPro" },
    { title: "New Balance 990v6", brand: "New Balance" },
    { title: "DeWalt DCD999", brand: "DeWalt" },
    { title: "Brembo GT Gran Turismo 6-Piston Big Brake Kit", brand: "Brembo" },
    { title: "WH-1000XM5 headphones", brand: "Sony" },
    { title: "Sony generic wireless headphones", brand: "Sony" },
    { title: "Unknown product", brand: "Unknown" },
    { title: "Apple iPhone 15 Pro", brand: null },
    { title: "", brand: null },
  ];

  for (const input of corpus) {
    const reference = findCatalogMatches(input, catalog);
    const optimized = findCatalogMatchesWithIndex(input, index);
    assert.deepStrictEqual(optimized, reference, `Matcher output mismatch for ${JSON.stringify(input)}`);
    const record = {
      brand: input.brand || "",
      productName: input.title,
      sourceExternalId: `equivalence-${corpus.indexOf(input)}`,
      raw: {},
    };
    const referenceClassification = acquisition.classifyCandidate(record, canonicalCatalog);
    const optimizedClassification = acquisition.classifyCandidateWithIndex(record, canonicalCatalog, index);
    assert.strictEqual(optimizedClassification, referenceClassification, `Classification mismatch for ${JSON.stringify(input)}`);
  }

  const brembo = findCatalogMatchesWithIndex(corpus[7], index);
  assert.strictEqual(hasAmbiguousHighConfidenceMatch(brembo), true, "Brembo must remain ambiguous");
  assert.strictEqual(index.productsIndexed, catalog.length);
  assert.strictEqual(index.aliasesIndexed, 5);
  console.log(`Matcher equivalence passed for ${corpus.length} corpus cases and ${catalog.length} canonical products.`);
  console.log("Reference and indexed outputs matched all decision-relevant fields.");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});