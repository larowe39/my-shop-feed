#!/usr/bin/env node
const assert = require("assert");

const SEEDS = [0x31, 0x30, 0x31a0beef];
const CASES_PER_SEED = 2000;

function randomForSeed(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random, values) {
  return values[Math.floor(random() * values.length)];
}

function chance(random, probability) {
  return random() < probability;
}

function product(id, brandName, name, modelNumber, aliases, variants) {
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

function variant(productId, index, name, alias, color) {
  return {
    variant: {
      id: `${productId}-variant-${index}`,
      product_id: productId,
      slug: `${productId}-variant-${index}`,
      name,
      sku: null,
      upc: null,
      gtin: null,
      color,
      size: null,
      attributes: {},
      created_at: "",
    },
    aliases: alias ? [alias] : [],
  };
}

function decorate(random, value) {
  return pick(random, [
    value,
    value.toUpperCase(),
    `  ${value}  `,
    value.replace(/ /g, "-"),
    value.replace(/e/g, "e\u0301"),
    value.replace(/1/g, "１"),
  ]);
}

function generateCase(random, caseIndex) {
  const brands = ["Acme", "Other", "Sony", "New Balance", "", "   ", "---", null, undefined];
  const roots = ["Widget", "Runner", "Headphones", "Camera", "Alpha Beta", "Café"];
  const models = ["X1", "X2", "990v5", "990v6", "WH-1000XM4", "12", null, ""];
  const suffixes = ["Max", "Plus", "Pro", "Ultra", "Sport Edition"];
  const count = 1 + Math.floor(random() * 6);
  const inputBrand = pick(random, ["Acme", "Sony", "New Balance", "Other"]);
  const root = pick(random, roots);
  const model = pick(random, models.filter(Boolean));
  const suffix = pick(random, suffixes);
  const mode = caseIndex % 8;
  let inputTitle = `${inputBrand} ${root} ${model}`;
  if (mode === 0 || mode === 1) inputTitle += ` ${suffix}`;
  if (mode === 2) inputTitle = `${inputBrand} ${root}`;
  if (mode === 3) inputTitle = `${root} ${model}`;
  if (mode === 4) inputTitle = `${inputBrand} ${root} Red`;
  inputTitle = decorate(random, inputTitle);

  const catalog = [];
  for (let index = 0; index < count; index += 1) {
    let candidateBrand = pick(random, brands);
    let candidateRoot = chance(random, 0.7) ? root : pick(random, roots);
    let candidateModel = chance(random, 0.65) ? model : pick(random, models);
    let name = [candidateRoot, candidateModel].filter(Boolean).join(" ");
    if ((mode === 0 || mode === 1) && index === 1) {
      candidateBrand = "Other";
      name = `${root} ${model} ${suffix}`;
    }
    if (mode === 2 && index === 0) {
      candidateBrand = pick(random, ["", "   ", "---", null, undefined]);
      name = root;
      candidateModel = chance(random, 0.5) ? root : null;
    }
    if (mode === 5 && index > 0) name = catalog[0].product.name;
    const id = mode === 6 && index > 0 ? "duplicate-id" : `seed-product-${caseIndex}-${index}`;
    const aliases = Array.from({ length: Math.floor(random() * 4) }, (_, aliasIndex) => {
      if (aliasIndex > 0 && chance(random, 0.35)) return name;
      return decorate(random, chance(random, 0.6) ? `${candidateBrand ?? ""} ${name}`.trim() : `${candidateRoot} ${candidateModel ?? ""}`.trim());
    });
    const variants = Array.from({ length: Math.floor(random() * 3) }, (_, variantIndex) => {
      const color = pick(random, ["Red", "Blue", null]);
      return variant(id, variantIndex, color ?? `Edition ${variantIndex}`, chance(random, 0.5) ? `${inputBrand} ${name} ${color ?? `Edition ${variantIndex}`}` : null, color);
    });
    catalog.push(product(id, candidateBrand, decorate(random, name), candidateModel, aliases, variants));
  }

  if (catalog.length === 1 && (mode === 0 || mode === 1)) {
    catalog.push(product(`specificity-${caseIndex}`, "Other", `${root} ${model} ${suffix}`, null, [], []));
  }
  return { input: { title: inputTitle, brand: inputBrand }, catalog };
}

function canonicalCatalog(catalog) {
  return catalog.map((entry) => ({
    brand: entry.brandName,
    productName: entry.product.name,
    modelNumber: entry.product.model_number,
    aliases: entry.aliases,
  }));
}

function classificationCandidates(catalog) {
  return catalog.map((entry, index) => product(
    `canonical-${index}`,
    entry.brandName,
    entry.product.name,
    entry.product.model_number,
    entry.aliases,
    []
  ));
}

function resolvedResults(matcher, input, catalog, matches) {
  if (new Set(catalog.map((entry) => entry.product.id)).size !== catalog.length) return null;
  return matches.map((match) => matcher.addVariantMatch(
    input,
    catalog.find((entry) => entry.product.id === match.productId),
    match
  ));
}

async function main() {
  const matcher = await import("../lib/catalogMatching.ts");
  const acquisition = await import("../lib/catalogAcquisition.ts");
  let casesRun = 0;

  for (const seed of SEEDS) {
    const random = randomForSeed(seed);
    for (let caseIndex = 0; caseIndex < CASES_PER_SEED; caseIndex += 1) {
      const fixture = generateCase(random, caseIndex);
      const index = matcher.createCatalogMatcherIndex(fixture.catalog);
      const reference = matcher.findCatalogMatches(fixture.input, fixture.catalog);
      try {
        for (const safeBrandPool of [false, true]) {
          const optimized = matcher.findCatalogMatchesWithIndex(fixture.input, index, undefined, safeBrandPool);
          assert.deepStrictEqual(optimized, reference);
          assert.deepStrictEqual(
            optimized.filter((match) => match.confidence >= 0.9).map((match) => match.productId),
            reference.filter((match) => match.confidence >= 0.9).map((match) => match.productId)
          );
          assert.strictEqual(matcher.hasAmbiguousHighConfidenceMatch(optimized), matcher.hasAmbiguousHighConfidenceMatch(reference));
          assert.deepStrictEqual(resolvedResults(matcher, fixture.input, fixture.catalog, optimized), resolvedResults(matcher, fixture.input, fixture.catalog, reference));
        }
        const record = {
          brand: fixture.input.brand,
          productName: fixture.input.title,
          sourceExternalId: `seed-${seed}-case-${caseIndex}`,
          raw: {},
        };
        assert.strictEqual(
          acquisition.classifyCandidateWithIndex(
            record,
            canonicalCatalog(fixture.catalog),
            matcher.createCatalogMatcherIndex(classificationCandidates(fixture.catalog))
          ),
          acquisition.classifyCandidate(record, canonicalCatalog(fixture.catalog))
        );
      } catch (error) {
        console.error(JSON.stringify({ seed, caseIndex, fixture, reference }, null, 2));
        throw error;
      }
      casesRun += 1;
    }
  }

  console.log(`Matcher differential testing passed ${casesRun} cases (${CASES_PER_SEED} per seed: ${SEEDS.map((seed) => `0x${seed.toString(16)}`).join(", ")}).`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});