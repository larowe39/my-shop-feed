#!/usr/bin/env node
const { performance } = require("perf_hooks");

function candidate(index) {
  const brand = `Brand ${index % 50}`;
  const model = `MODEL-${index}`;
  return {
    product: {
      id: `product-${index}`,
      brand_id: `brand-${index % 50}`,
      family_id: null,
      subcategory_id: null,
      slug: `product-${index}`,
      name: `${brand} Product ${model}`,
      model_number: model,
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
    brandName: brand,
    aliases: [`${brand} Alias ${model}`],
  };
}

async function main() {
  const matcher = await import("../lib/catalogMatching.ts");
  const { createCatalogMatcherIndex, findCatalogMatches, findCatalogMatchesWithIndex } = matcher;
  const scales = [
    { name: "current", incoming: 10, canonical: 1096 },
    { name: "medium", incoming: 100, canonical: 10000 },
    { name: "larger-bounded", incoming: 1000, canonical: 1000 },
  ];

  for (const scale of scales) {
    const catalog = Array.from({ length: scale.canonical }, (_, index) => candidate(index));
    const records = Array.from({ length: scale.incoming }, (_, index) => ({
      title: `Brand ${index % 50} Product MODEL-${index % scale.canonical}`,
      brand: `Brand ${index % 50}`,
    }));
    const measureReference = scale.name === "current";
    const referenceStartedAt = performance.now();
    if (measureReference) {
      for (const record of records) findCatalogMatches(record, catalog);
    }
    const referenceMs = measureReference ? performance.now() - referenceStartedAt : null;
    const buildStartedAt = performance.now();
    const index = createCatalogMatcherIndex(catalog);
    const indexBuildMs = performance.now() - buildStartedAt;
    const metrics = { candidatesConsidered: 0, scoringOperations: 0 };
    const optimizedStartedAt = performance.now();
    for (const record of records) findCatalogMatchesWithIndex(record, index, metrics, true);
    const optimizedMs = performance.now() - optimizedStartedAt;
    const comparisons = scale.incoming * scale.canonical;
    console.log(JSON.stringify({
      scale: scale.name,
      incoming: scale.incoming,
      canonical: scale.canonical,
      indexBuildMs: Number(indexBuildMs.toFixed(2)),
      productsIndexed: index.productsIndexed,
      aliasesIndexed: index.aliasesIndexed,
      referenceComparisons: comparisons,
      optimizedCandidatesConsidered: metrics.candidatesConsidered,
      optimizedScoringOperations: metrics.scoringOperations,
      referenceMeasured: measureReference,
      referenceMs: referenceMs === null ? null : Number(referenceMs.toFixed(2)),
      optimizedMs: Number(optimizedMs.toFixed(2)),
      wallClockRatio: referenceMs === null ? null : Number((referenceMs / Math.max(optimizedMs, 0.001)).toFixed(2)),
    }));
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});