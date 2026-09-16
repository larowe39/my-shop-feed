#!/usr/bin/env node
// Sequential staging review. Defaults to dry-run; pass --apply for explicit state changes.
require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });

const readline = require("readline");
const { getFlagValue } = require("./lib/cliArgs");
const args = process.argv.slice(2);
const backend = getFlagValue(args, "--backend") || process.env.CATALOG_STAGING_BACKEND || undefined;
const runId = getFlagValue(args, "--run-id");
const limit = Math.max(1, Number(getFlagValue(args, "--limit") || 10));
const apply = args.includes("--apply");

function ask(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

(async () => {
  const { resolveStagingStore } = await import("../lib/stagingStore.ts");
  const { candidateReviewView, reviewCandidatesSequentially } = await import("../lib/catalogAcquisition.ts");
  const store = resolveStagingStore({ backend });
  const candidates = (await store.listStagedCandidates())
    .filter((candidate) => ["pending", "needs_review", "duplicate"].includes(candidate.status))
    .filter((candidate) => !runId || candidate.importRunId === runId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit);
  if (!candidates.length) {
    console.log("No pending review candidates found.");
    return;
  }
  console.log(`Reviewing ${candidates.length} candidate(s) on ${store.kind}; ${apply ? "APPLY" : "DRY RUN"}.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const results = await reviewCandidatesSequentially(store, candidates, async (candidate, index) => {
      console.log(`\n[${index + 1}/${candidates.length}]`);
      console.log(JSON.stringify(candidateReviewView(candidate), null, 2));
      const answer = (await ask(rl, "Decision [a]pprove / [r]eject / [s]kip: ")).trim().toLowerCase();
      if (answer === "a" || answer === "approve") return "approve";
      if (answer === "r" || answer === "reject") return "reject";
      return "skip";
    }, { dryRun: !apply });
    for (const result of results) console.log(`${result.id}: ${result.decision} - ${result.result.message}`);
  } finally {
    rl.close();
  }
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
