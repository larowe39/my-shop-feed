#!/usr/bin/env node
const usage = `Usage: npm run catalog:staging:show -- --id <candidate-id>`;
const args = process.argv.slice(2);
const idIndex = args.indexOf("--id");
if (idIndex === -1 || !args[idIndex + 1]) {
  console.error(usage);
  process.exit(1);
}
const candidateId = args[idIndex + 1];
(async () => {
  const { getStagedCandidateById, listStagedCandidates } = await import("../lib/catalogAcquisition.ts");
  const candidate = getStagedCandidateById(candidateId) ?? listStagedCandidates().find((row) => row.id === candidateId) ?? null;
  if (!candidate) {
    console.error(`Candidate ${candidateId} not found.`);
    process.exit(1);
  }
  console.log(JSON.stringify(candidate, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
