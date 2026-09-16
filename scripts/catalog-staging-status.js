#!/usr/bin/env node
// PRODUCTION default backend: Supabase. Pass --backend=local for tests/dev.
require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });

const { getFlagValue } = require("./lib/cliArgs");
const args = process.argv.slice(2);
const backend = getFlagValue(args, "--backend") || process.env.CATALOG_STAGING_BACKEND || undefined;

(async () => {
  const { resolveStagingStore } = await import("../lib/stagingStore.ts");
  const store = resolveStagingStore({ backend });
  const staged = await store.listStagedCandidates();

  const counts = { pending: 0, needs_review: 0, duplicate: 0, approved: 0, rejected: 0, invalid: 0, promoted: 0 };
  for (const candidate of staged) {
    counts[candidate.status] = (counts[candidate.status] ?? 0) + 1;
  }

  console.log(`STAGING BACKEND: ${store.kind}`);
  console.log("STAGING STATUS");
  console.log(`Pending: ${counts.pending}`);
  console.log(`Needs review: ${counts.needs_review}`);
  console.log(`Duplicate: ${counts.duplicate}`);
  console.log(`Approved: ${counts.approved}`);
  console.log(`Rejected: ${counts.rejected}`);
  console.log(`Invalid: ${counts.invalid}`);
  console.log(`Promoted: ${counts.promoted}`);
  console.log(`Total staged rows: ${staged.length}`);
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
