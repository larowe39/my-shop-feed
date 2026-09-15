#!/usr/bin/env node
const usage = `Usage: npm run catalog:staging:approve -- --id <candidate-id> [--dry-run]`;
const args = process.argv.slice(2);
const idIndex = args.indexOf("--id");
if (idIndex === -1 || !args[idIndex + 1]) {
  console.error(usage);
  process.exit(1);
}
const candidateId = args[idIndex + 1];
const dryRun = args.includes("--dry-run") || !args.includes("--apply");
(async () => {
  const { approveCandidate, getStagedCandidateById } = await import("../lib/catalogAcquisition.ts");
  const candidate = getStagedCandidateById(candidateId);
  if (!candidate) {
    console.error(`Candidate ${candidateId} not found.`);
    process.exit(1);
  }
  const result = approveCandidate(candidate, { dryRun });
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  console.log(result.message);
  console.log(JSON.stringify(result.candidate, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
