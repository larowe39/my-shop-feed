#!/usr/bin/env node
// PRODUCTION default backend: Supabase staging tables -> Supabase canonical
// catalog tables via the atomic promote_catalog_staged_product() RPC. Pass
// --backend=local for tests/dev (uses in-memory mock canonical store; never
// touches real production data). --apply is required to write; otherwise
// this reports exactly what would happen with zero canonical writes.
require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });

const { getFlagValue } = require("./lib/cliArgs");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const backend = getFlagValue(args, "--backend") || process.env.CATALOG_STAGING_BACKEND || undefined;

(async () => {
  const { resolveStagingStore } = await import("../lib/stagingStore.ts");
  const { resolveCanonicalPromotionStore } = await import("../lib/catalogPromotion.ts");
  const { promoteApprovedCandidates } = await import("../lib/catalogAcquisition.ts");

  const stagingStore = resolveStagingStore({ backend });
  const canonicalStore = resolveCanonicalPromotionStore({ backend });
  console.log(`STAGING BACKEND: ${stagingStore.kind}`);
  console.log(`CANONICAL PROMOTION BACKEND: ${canonicalStore.kind}`);

  const result = await promoteApprovedCandidates(stagingStore, canonicalStore, { dryRun: !apply });
  console.log(result.message);
  for (const entry of result.entries) {
    console.log(`  [${entry.ok ? "OK" : "SKIP"}] ${entry.candidateId}: ${entry.message}`);
  }
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
