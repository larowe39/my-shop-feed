#!/usr/bin/env node
// PRODUCTION default backend: Supabase (catalog_sources/catalog_import_runs/
// catalog_staged_products/catalog_staged_aliases). Pass --backend=local (or
// set CATALOG_STAGING_BACKEND=local) to use the gitignored local JSON ledger
// for tests/dev only. There is NO silent fallback: if the Supabase backend
// is selected (explicitly or by default) and credentials are missing, this
// fails closed with an error instead of writing to the local ledger.
require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });

const fs = require("fs");
const path = require("path");
const { getFlagValue } = require("./lib/cliArgs");

function parseArgs() {
  const raw = process.argv.slice(2);
  return {
    apply: raw.includes("--apply"),
    adapter: getFlagValue(raw, "--adapter") || "json",
    source: getFlagValue(raw, "--source"),
    backend: getFlagValue(raw, "--backend") || process.env.CATALOG_STAGING_BACKEND || null,
  };
}

async function main() {
  const args = parseArgs();
  const acquisition = await import("../lib/catalogAcquisition.ts");
  const { acquireFromRecords, parseJsonAdapterRecords, parseCsvAdapterRecords, printAcquisitionSummary } = acquisition;

  const sourcePath = args.source || path.join(__dirname, "__fixtures__", "catalog-acquisition", "sample-products.json");
  const raw = fs.readFileSync(sourcePath, "utf8");
  const records = args.adapter === "csv" ? parseCsvAdapterRecords(raw) : parseJsonAdapterRecords(raw);

  let store;
  if (args.apply) {
    const { resolveStagingStore } = await import("../lib/stagingStore.ts");
    store = resolveStagingStore({ backend: args.backend ?? undefined });
    console.log(`STAGING BACKEND: ${store.kind}${args.backend ? " (explicit)" : " (default)"}`);
  }

  const run = await acquireFromRecords(
    records,
    [],
    { name: path.basename(sourcePath), type: args.adapter },
    { apply: args.apply, adapter: args.adapter, sourcePath },
    store
  );

  console.log(printAcquisitionSummary(run));
  console.log(args.apply ? "APPLY -- staging data written to the selected backend above." : "DRY RUN -- ZERO staging/canonical writes");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
