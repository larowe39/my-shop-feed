#!/usr/bin/env node
require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });
const { getFlagValue } = require("./lib/cliArgs");
const args = process.argv.slice(2);
const runId = getFlagValue(args, "--run-id");
const backend = getFlagValue(args, "--backend") || process.env.CATALOG_STAGING_BACKEND || undefined;
const limit = Math.max(1, Number(getFlagValue(args, "--limit") || 10));

(async () => {
  if (!runId) {
    console.error("Usage: npm run catalog:taxonomy:gaps -- --run-id <RUN_ID> [--backend local|supabase] [--limit 10]");
    process.exit(1);
  }

  const { resolveStagingStore } = await import("../lib/stagingStore.ts");
  const store = resolveStagingStore({ backend });
  const { resolveTaxonomyMappingStore } = await import("../lib/catalogTaxonomyMappings.ts");
  const mappingStore = resolveTaxonomyMappingStore({ backend });
  const { rankTaxonomyGaps } = await import("../lib/catalogAcquisition.ts");

  const candidates = (await store.listStagedCandidates()).filter((candidate) => candidate.importRunId === runId);
  const mappings = await mappingStore.listMappings();
  const gaps = rankTaxonomyGaps(runId, candidates, mappings);
  console.log("UNRESOLVED TAXONOMY");
  console.log(`Provider       External ID    Name              Candidates  Official path`);
  for (const gap of gaps.slice(0, limit)) {
    const name = gap.name || "-";
    const provider = gap.provider.padEnd(13, " ");
    const externalId = String(gap.externalId).padEnd(14, " ");
    const count = String(gap.candidateCount).padEnd(10, " ");
    console.log(`${provider} ${externalId} ${name.padEnd(16, " ")} ${count} ${gap.path || "-"}`);
  }
  if (!gaps.length) console.log("No unresolved taxonomy gaps for this run.");
})();
