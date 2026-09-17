#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

function candidate(id, brandName, name, modelNumber = null, aliases = [], variants = []) {
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
    variants,
  };
}

function variant(id, productId, name, aliases = [], color = null, size = null) {
  return {
    variant: {
      id,
      product_id: productId,
      slug: id,
      name,
      sku: null,
      upc: null,
      gtin: null,
      color,
      size,
      attributes: {},
      created_at: "",
    },
    aliases,
  };
}

async function main() {
  const matcher = await import("../lib/catalogMatching.ts");
  const { addVariantMatch, createCatalogMatcherIndex, findCatalogMatches, findCatalogMatchesWithIndex, hasAmbiguousHighConfidenceMatch } = matcher;
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

  const emptyBrandCases = ["", "   ", "---", null, undefined];
  for (const [caseIndex, emptyBrand] of emptyBrandCases.entries()) {
    const emptyBrandCatalog = [
      candidate(`empty-brand-name-${caseIndex}`, emptyBrand, "Widget"),
      candidate(`empty-brand-model-${caseIndex}`, emptyBrand, "Unrelated", "Widget"),
      candidate(`empty-brand-alias-${caseIndex}`, emptyBrand, "Also Unrelated", null, ["Widget"]),
      candidate(`acme-widget-${caseIndex}`, "Acme Corporation", "Widget"),
    ];
    const emptyBrandIndex = createCatalogMatcherIndex(emptyBrandCatalog);
    const input = { title: "Acme Corporation Widget", brand: "Acme Corporation" };
    const reference = findCatalogMatches(input, emptyBrandCatalog);
    const optimized = findCatalogMatchesWithIndex(input, emptyBrandIndex);
    assert.deepStrictEqual(optimized, reference, `Empty-brand matcher output mismatch for ${JSON.stringify(emptyBrand)}`);
    assert.strictEqual(hasAmbiguousHighConfidenceMatch(optimized), hasAmbiguousHighConfidenceMatch(reference));

    const canonical = emptyBrandCatalog.slice(0, 1).map((entry) => ({
      brand: entry.brandName,
      productName: entry.product.name,
      modelNumber: entry.product.model_number,
      aliases: entry.aliases,
    }));
    const record = {
      brand: input.brand,
      productName: input.title,
      sourceExternalId: `empty-brand-${caseIndex}`,
      raw: {},
    };
    assert.strictEqual(acquisition.classifyCandidate(record, canonical), "NEW");
    assert.strictEqual(
      acquisition.classifyCandidateWithIndex(record, canonical, createCatalogMatcherIndex(emptyBrandCatalog.slice(0, 1))),
      "NEW",
      `Acme/Widget classification mismatch for ${JSON.stringify(emptyBrand)}`
    );
  }

  const specificityInput = { title: "Acme Widget X1 Sport Edition", brand: "Acme" };
  const specificityCatalog = [
    candidate("base", "Acme", "Widget X1"),
    candidate("specific-other", "Other", "Widget X1 Sport Edition"),
  ];
  for (const orderedCatalog of [specificityCatalog, [...specificityCatalog].reverse()]) {
    const reference = findCatalogMatches(specificityInput, orderedCatalog);
    const metrics = {
      canonicalEntriesExamined: 0,
      scorerInvocations: 0,
      specificityWitnessChecks: 0,
      candidateRetrievalMs: 0,
      scoringMs: 0,
      finalizationMs: 0,
    };
    const optimized = findCatalogMatchesWithIndex(
      specificityInput,
      createCatalogMatcherIndex(orderedCatalog),
      metrics,
      true
    );
    assert.deepStrictEqual(optimized, reference, "Cross-brand specificity witness must survive pruning");
    assert.deepStrictEqual(reference, [
      { productId: "base", confidence: 0.89, reason: "More specific canonical identity is contained in listing" },
      { productId: "specific-other", confidence: 0.2, reason: "Conflicting explicit brand" },
    ]);
    assert.strictEqual(metrics.canonicalEntriesExamined, 2);
    assert.strictEqual(metrics.scorerInvocations, 1, "conflicting-brand witness must not invoke the full scorer");
    const expectedWitnessChecks = orderedCatalog[0].product.id === "base" ? 6 : 5;
    assert.strictEqual(metrics.specificityWitnessChecks, expectedWitnessChecks, "specificity metrics must include witness discovery and short-circuited pair checks");
  }

  const threeCandidateCatalog = [
    ...specificityCatalog,
    candidate("peer", "Acme", "Widget X1 Sport", null, ["Acme Widget X1 Sport Edition"]),
  ];
  for (const orderedCatalog of [threeCandidateCatalog, [threeCandidateCatalog[2], threeCandidateCatalog[0], threeCandidateCatalog[1]]]) {
    const threeCandidateReference = findCatalogMatches(specificityInput, orderedCatalog);
    const threeCandidateMetrics = {
      canonicalEntriesExamined: 0,
      scorerInvocations: 0,
      specificityWitnessChecks: 0,
      candidateRetrievalMs: 0,
      scoringMs: 0,
      finalizationMs: 0,
    };
    const threeCandidateOptimized = findCatalogMatchesWithIndex(
      specificityInput,
      createCatalogMatcherIndex(orderedCatalog),
      threeCandidateMetrics,
      true
    );
    assert.deepStrictEqual(threeCandidateOptimized, threeCandidateReference, "Specificity witnesses must preserve ranking and ambiguity");
    assert.deepStrictEqual(
      threeCandidateOptimized.filter((match) => match.confidence >= 0.9).map((match) => match.productId),
      threeCandidateReference.filter((match) => match.confidence >= 0.9).map((match) => match.productId)
    );
    assert.strictEqual(hasAmbiguousHighConfidenceMatch(threeCandidateOptimized), hasAmbiguousHighConfidenceMatch(threeCandidateReference));
    assert.strictEqual(threeCandidateMetrics.canonicalEntriesExamined, 3);
    assert.strictEqual(threeCandidateMetrics.scorerInvocations, 2);
    assert.ok(threeCandidateMetrics.specificityWitnessChecks >= 10);
  }

  for (const suffix of ["Max", "Plus", "Pro", "Ultra", "Sport Edition"]) {
    const baseName = suffix === "Pro" ? "Widget 1" : suffix === "Ultra" ? "Widget X1" : "Widget X1";
    const suffixInput = { title: `Acme ${baseName} ${suffix}`, brand: "Acme" };
    const suffixCatalog = [
      candidate(`suffix-base-${suffix}`, "Acme", baseName),
      candidate(`suffix-witness-${suffix}`, "Other", `${baseName} ${suffix}`),
    ];
    assert.deepStrictEqual(
      findCatalogMatchesWithIndex(suffixInput, createCatalogMatcherIndex(suffixCatalog), undefined, true),
      findCatalogMatches(suffixInput, suffixCatalog),
      `Specificity suffix mismatch for ${suffix}`
    );
  }

  const duplicateIdCatalog = [
    candidate("duplicate", "Acme", "Widget X1"),
    candidate("duplicate", "Other", "Widget X1 Sport Edition"),
  ];
  for (const orderedCatalog of [duplicateIdCatalog, [...duplicateIdCatalog].reverse()]) {
    assert.deepStrictEqual(
      findCatalogMatchesWithIndex(specificityInput, createCatalogMatcherIndex(orderedCatalog), undefined, true),
      findCatalogMatches(specificityInput, orderedCatalog),
      "Duplicate IDs must preserve reference specificity behavior"
    );
  }

  const edgeCases = [
    {
      input: { title: "ACME   WIDGET-X1", brand: " acme " },
      catalog: [candidate("punctuation", "Acme", "Widget X1"), candidate("equal-b", "", "ACME WIDGET X1"), candidate("equal-a", "", "acme_widget_x1")],
    },
    {
      input: { title: "Café Model １２", brand: "Cafe\u0301" },
      catalog: [candidate("unicode", "Café", "Model 12", "12"), candidate("numeric", null, "12", "12")],
    },
    {
      input: { title: "Acme Alpha Beta", brand: "Acme" },
      catalog: [candidate("threshold-70", "", "Alpha Gamma"), candidate("threshold-62", undefined, "Beta")],
    },
    {
      input: { title: "Acme Runner Red", brand: "Acme" },
      catalog: [
        candidate("runner", "Acme", "Runner", null, ["Runner", "Runner"], [
          variant("runner-red", "runner", "Red", ["Acme Runner Red"], "Red"),
          variant("runner-red-duplicate", "runner", "Red", ["Acme Runner Red"], "Red"),
        ]),
        candidate("runner-duplicate-product", "Acme", "Runner"),
      ],
    },
    {
      input: { title: "Model 12345", brand: null, category: null },
      catalog: [candidate("numeric-model", "", "12345", "12345", ["12345", "12345"])],
    },
  ];

  for (const [caseIndex, edgeCase] of edgeCases.entries()) {
    const reference = findCatalogMatches(edgeCase.input, edgeCase.catalog);
    for (const safeBrandPool of [false, true]) {
      const optimized = findCatalogMatchesWithIndex(
        edgeCase.input,
        createCatalogMatcherIndex(edgeCase.catalog),
        undefined,
        safeBrandPool
      );
      assert.deepStrictEqual(optimized, reference, `Edge-case output mismatch at ${caseIndex}, pruning=${safeBrandPool}`);
      assert.deepStrictEqual(
        optimized.map((match) => addVariantMatch(edgeCase.input, edgeCase.catalog.find((entry) => entry.product.id === match.productId), match)),
        reference.map((match) => addVariantMatch(edgeCase.input, edgeCase.catalog.find((entry) => entry.product.id === match.productId), match)),
        `Variant resolution mismatch at ${caseIndex}, pruning=${safeBrandPool}`
      );
      assert.strictEqual(hasAmbiguousHighConfidenceMatch(optimized), hasAmbiguousHighConfidenceMatch(reference));
    }
  }

  const bremboData = JSON.parse(fs.readFileSync(path.join(__dirname, "../catalog-data/automotive/brembo.json"), "utf8"));
  const actualBremboCatalog = bremboData.products.map((product) => candidate(
    product.slug,
    bremboData.brand.name,
    product.name,
    product.modelNumber,
    product.aliases,
    product.variants
  ));
  const actualBremboInput = { title: "Brembo GT Gran Turismo 6-Piston Big Brake Kit", brand: "Brembo" };
  const actualBremboReference = findCatalogMatches(actualBremboInput, actualBremboCatalog);
  const actualBremboOptimized = findCatalogMatchesWithIndex(actualBremboInput, createCatalogMatcherIndex(actualBremboCatalog), undefined, true);
  assert.deepStrictEqual(actualBremboOptimized, actualBremboReference);
  assert.deepStrictEqual(actualBremboOptimized.slice(0, 2), [
    { productId: "brembo-high-performance-6-piston", confidence: 0.97, reason: "Exact brand + distinctive model identifier" },
    { productId: "brembo-gt-gran-turismo", confidence: 0.96, reason: "Exact normalized alias + brand" },
  ]);
  assert.strictEqual(hasAmbiguousHighConfidenceMatch(actualBremboOptimized), true);

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