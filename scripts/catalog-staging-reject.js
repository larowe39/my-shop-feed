#!/usr/bin/env node
// PRODUCTION default backend: Supabase. Pass --backend=local for tests/dev.
require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });

const { getFlagValue } = require("./lib/cliArgs");
const usage = `Usage: npm run catalog:staging:reject -- --id <candidate-id> [--apply] [--raw] [--backend local|supabase]`;
const args = process.argv.slice(2);
const candidateId = getFlagValue(args, "--id");
if (!candidateId) {
  console.error(usage);
  process.exit(1);
}
const dryRun = !args.includes("--apply");
const backend = getFlagValue(args, "--backend") || process.env.CATALOG_STAGING_BACKEND || undefined;

(async () => {
  const { resolveStagingStore } = await import("../lib/stagingStore.ts");
  const { candidateReviewView, rejectCandidate } = await import("../lib/catalogAcquisition.ts");
  const store = resolveStagingStore({ backend });
  console.log(`STAGING BACKEND: ${store.kind}`);
  const result = await rejectCandidate(store, candidateId, { dryRun });
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  console.log(result.message);
  console.log(JSON.stringify(args.includes("--raw") ? result.candidate : candidateReviewView(result.candidate), null, 2));
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
