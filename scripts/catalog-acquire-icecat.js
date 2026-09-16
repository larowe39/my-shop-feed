#!/usr/bin/env node
require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });

const fs = require("fs");
const path = require("path");
const { getFlagValue } = require("./lib/cliArgs");

function args() {
  const raw = process.argv.slice(2);
  return {
    apply: raw.includes("--apply"),
    discover: raw.includes("--discover"),
    mode: (getFlagValue(raw, "--mode") || "initial").toLowerCase(),
    source: getFlagValue(raw, "--source"),
    backend: getFlagValue(raw, "--backend") || process.env.CATALOG_STAGING_BACKEND || null,
    limit: Number(getFlagValue(raw, "--limit") || 10),
    pages: Number(getFlagValue(raw, "--pages") || 1),
    pageSize: Number(getFlagValue(raw, "--page-size") || 25),
    brand: getFlagValue(raw, "--brand") || null,
    category: getFlagValue(raw, "--category") || null,
    country: getFlagValue(raw, "--country") || null,
    onMarket: getFlagValue(raw, "--on-market") || null,
    updatedSince: getFlagValue(raw, "--updated-since") || null,
    productCodes: raw.flatMap((arg, index) => arg === "--product-code" && raw[index + 1] ? [raw[index + 1]] : []).concat(
      raw.filter((arg) => arg.startsWith("--product-code=")).map((arg) => arg.slice("--product-code=".length))
    ),
  };
}

async function main() {
  const options = args();
  const { OpenIcecatProvider, parseIcecatProductsXml, assertProviderSupports } = await import("../lib/catalogProviders.ts");
  const { acquireDiscoveredProducts, acquireFromRecords, calculateAcquisitionQualityMetrics, printAcquisitionSummary } = await import("../lib/catalogAcquisition.ts");
  const provider = new OpenIcecatProvider({
    apiToken: process.env.ICECAT_API_TOKEN,
    username: process.env.ICECAT_USERNAME,
    password: process.env.ICECAT_PASSWORD,
    indexBaseUrl: process.env.ICECAT_INDEX_URL || undefined,
  });
  if (options.discover) {
    assertProviderSupports(provider, "discovery");
  }

  const { resolveCanonicalCatalogEntries } = await import("../lib/catalogCanonicalLookup.ts");
  const canonicalCatalog = await resolveCanonicalCatalogEntries({ backend: options.backend || undefined });
  let store;
  if (options.apply) {
    const { resolveStagingStore } = await import("../lib/stagingStore.ts");
    store = resolveStagingStore({ backend: options.backend || undefined });
  }
  const metadata = provider.getSourceMetadata();
  const { resolveTaxonomyMappingStore } = await import("../lib/catalogTaxonomyMappings.ts");
  const taxonomyStore = resolveTaxonomyMappingStore({ backend: options.backend || undefined });

  let records = [];
  let providerErrors = [];
  let fetched = 0;
  let enriched = 0;
  let pages = 0;
  let run;
  const startedAt = Date.now();

  if (options.discover) {
    const discoveryOptions = {
      mode: options.mode,
      limit: options.limit,
      pageSize: options.pageSize,
      brand: options.brand || undefined,
      category: options.category || undefined,
      country: options.country || undefined,
      onMarket: options.onMarket === null ? undefined : options.onMarket,
      updatedSince: options.updatedSince || undefined,
    };
    const discoveryRun = await acquireDiscoveredProducts(provider, discoveryOptions, canonicalCatalog, metadata, {
      apply: options.apply,
      adapter: "open-icecat",
      sourcePath: options.source,
      taxonomyResolver: (identity) => taxonomyStore.resolveTrustedMapping(identity),
    }, store);
    fetched = discoveryRun.fetched;
    pages = discoveryRun.pages;
    providerErrors = discoveryRun.providerErrors;
    enriched = discoveryRun.enriched;
    run = discoveryRun;
  } else if (options.source) {
    const sourcePath = path.resolve(options.source);
    const xml = fs.readFileSync(sourcePath, "utf8");
    const products = parseIcecatProductsXml(xml).slice(0, Math.max(0, Math.min(options.limit, 100)));
    fetched = products.length;
    pages = 1;
    for (const product of products) {
      try { records.push(provider.normalizeProduct(product)); }
      catch (error) { providerErrors.push({ message: error instanceof Error ? error.message : String(error) }); }
    }
  } else {
    const productCodes = options.productCodes.length ? options.productCodes : (process.env.ICECAT_PRODUCT_CODES || "").split(",").map((value) => value.trim()).filter(Boolean);
    const result = await provider.fetchProducts({ limit: options.limit, pages: options.pages, productCodes });
    fetched = result.fetched;
    pages = result.pages;
    providerErrors = result.errors;
    for (const product of result.records) {
      try { records.push(provider.normalizeProduct(product)); }
      catch (error) { providerErrors.push({ message: error instanceof Error ? error.message : String(error) }); }
    }
  }

  if (!run) {
    run = await acquireFromRecords(records, canonicalCatalog, metadata, {
      apply: options.apply,
      adapter: "open-icecat",
      sourcePath: options.source,
      taxonomyResolver: (identity) => taxonomyStore.resolveTrustedMapping(identity),
    }, store);
  }
  if (!run.summary.qualityMetrics) {
    run.summary.qualityMetrics = calculateAcquisitionQualityMetrics(records, run.summary, { discovered: fetched, providerErrors: providerErrors.length });
  }
  console.log(`PROVIDER: open-icecat`);
  console.log(`MODE: ${options.discover ? options.mode : "lookup"}`);
  console.log(`REQUESTED LIMIT: ${options.limit}`);
  console.log(`RECORDS FETCHED: ${fetched}`);
  console.log(`RECORDS ENRICHED: ${options.discover ? enriched : records.length}`);
  console.log(`PAGES: ${pages}`);
  console.log(`PROVIDER ERRORS: ${providerErrors.length}`);
  console.log(`ELAPSED MS: ${Date.now() - startedAt}`);
  console.log(`IMPORT RUN ID: ${run.runId || "none (dry-run)"}`);
  for (const error of providerErrors) console.log(`ERROR: ${error.message}`);
  console.log(printAcquisitionSummary(run));
  console.log(options.apply ? "APPLY -- staging data written; no approval or promotion performed." : "DRY RUN -- ZERO Supabase staging/canonical writes");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
