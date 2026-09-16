#!/usr/bin/env node
// PRODUCTION default backend: Supabase. Pass --backend=local for tests/dev.
require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });

const { getFlagValue } = require("./lib/cliArgs");
const args = process.argv.slice(2);
const backend = getFlagValue(args, "--backend") || process.env.CATALOG_STAGING_BACKEND || undefined;
const status = getFlagValue(args, "--status");
const runId = getFlagValue(args, "--run-id");
const classification = getFlagValue(args, "--classification");
const sourceId = getFlagValue(args, "--source-id");
const limit = Math.max(1, Number(getFlagValue(args, "--limit") || 25));

(async () => {
  const { resolveStagingStore } = await import("../lib/stagingStore.ts");
  const { candidateReviewView } = await import("../lib/catalogAcquisition.ts");
  const store = resolveStagingStore({ backend });
  let candidates = await store.listStagedCandidates();
  candidates = candidates
    .filter((candidate) => !status || candidate.status === status)
    .filter((candidate) => !runId || candidate.importRunId === runId)
    .filter((candidate) => !classification || candidate.classification === classification)
    .filter((candidate) => !sourceId || candidate.sourceId === sourceId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit);
  console.log(`STAGING BACKEND: ${store.kind}`);
  console.log(`CANDIDATES: ${candidates.length}`);
  if (args.includes("--json")) {
    console.log(JSON.stringify(candidates.map(candidateReviewView), null, 2));
    return;
  }
  for (const candidate of candidates) {
    console.log([
      candidate.id,
      candidate.status,
      candidate.classification,
      candidate.brand,
      candidate.productName,
      candidate.modelNumber || candidate.mpn || "-",
      candidate.sourceExternalId || "-",
      candidate.importRunId || "-",
    ].join(" | "));
  }
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
