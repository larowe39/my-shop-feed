#!/usr/bin/env node
// PRODUCTION default backend: Supabase. Pass --backend=local for tests/dev.
// --apply is required to actually write the approval; otherwise this is a
// dry-run report of what would happen with zero writes.
require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });

const { getFlagValue } = require("./lib/cliArgs");
const usage = `Usage: npm run catalog:staging:approve -- --id <candidate-id> [--apply] [--raw] [--backend local|supabase]`;
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
  const { approveCandidate, candidateReviewView, formatApprovalPreview } = await import("../lib/catalogAcquisition.ts");
  const store = resolveStagingStore({ backend });
  console.log(`STAGING BACKEND: ${store.kind}`);
  const result = await approveCandidate(store, candidateId, { dryRun });
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  const approvalAllowed = ["pending", "needs_review", "duplicate", "approved"].includes(result.candidate.status);
  console.log(formatApprovalPreview(result.candidate, { dryRun, approvalAllowed, approvalBlocker: result.message }));
  if (args.includes("--raw")) console.log(JSON.stringify(result.candidate, null, 2));
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
