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
    source: getFlagValue(raw, "--source"),
    backend: getFlagValue(raw, "--backend") || process.env.CATALOG_STAGING_BACKEND || null,
    limit: Number(getFlagValue(raw, "--limit") || 10),
    pages: Number(getFlagValue(raw, "--pages") || 1),
    productCodes: raw.flatMap((arg, index) => arg === "--product-code" && raw[index + 1] ? [raw[index + 1]] : []).concat(
      raw.filter((arg) => arg.startsWith("--product-code=")).map((arg) => arg.slice("--product-code=".length))
    ),
  };
}

async function main() {
  const options = args();
  const { OpenIcecatProvider, parseIcecatProductsXml } = await import("../lib/catalogProviders.ts");
  const provider = new OpenIcecatProvider();
  let records = [];
  let providerErrors = [];
  let fetched = 0;
  let pages = 0;

  if (options.source) {
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

  const { resolveCanonicalCatalogEntries } = await import("../lib/catalogCanonicalLookup.ts");
  const canonicalCatalog = await resolveCanonicalCatalogEntries({ backend: options.backend || undefined });
  const { acquireFromRecords, printAcquisitionSummary } = await import("../lib/catalogAcquisition.ts");
  let store;
  if (options.apply) {
    const { resolveStagingStore } = await import("../lib/stagingStore.ts");
    store = resolveStagingStore({ backend: options.backend || undefined });
  }
  const metadata = provider.getSourceMetadata();
  const run = await acquireFromRecords(records, canonicalCatalog, metadata, {
    apply: options.apply,
    adapter: "open-icecat",
    sourcePath: options.source,
  }, store);
  console.log(`PROVIDER: open-icecat`);
  console.log(`RECORDS FETCHED: ${fetched}`);
  console.log(`PAGES: ${pages}`);
  console.log(`PROVIDER ERRORS: ${providerErrors.length}`);
  for (const error of providerErrors) console.log(`ERROR: ${error.message}`);
  console.log(printAcquisitionSummary(run));
  console.log(options.apply ? "APPLY -- staging data written; no approval or promotion performed." : "DRY RUN -- ZERO Supabase staging/canonical writes");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
