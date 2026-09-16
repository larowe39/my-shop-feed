#!/usr/bin/env node
require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });
const { getFlagValue } = require("./lib/cliArgs");
const args = process.argv.slice(2);
const runId = getFlagValue(args, "--run-id");
const backend = getFlagValue(args, "--backend") || process.env.CATALOG_STAGING_BACKEND || undefined;

(async () => {
  if (!runId) {
    console.error("Usage: npm run catalog:run:report -- --run-id <RUN_ID> [--backend local|supabase]");
    process.exit(1);
  }

  const { resolveStagingStore } = await import("../lib/stagingStore.ts");
  const store = resolveStagingStore({ backend });
  const runs = await store.listImportRuns();
  const candidates = await store.listStagedCandidates();
  const { buildCatalogRunReport, formatCatalogRunReport } = await import("../lib/catalogAcquisition.ts");
  const report = buildCatalogRunReport(runId, runs, candidates);
  console.log(formatCatalogRunReport(report));
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
