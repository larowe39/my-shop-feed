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
  const { showCandidate } = await import("../lib/catalogAcquisition.ts");
  const candidate = {
    id: candidateId,
    status: "pending",
    classification: "NEW",
    productName: "Example staged candidate",
    brand: "Example Brand",
  };
  const result = showCandidate(candidateId, [candidate]);
  if (!result.found) {
    console.error(result.message);
    process.exit(1);
  }
  console.log(result.message);
  console.log(JSON.stringify(result.candidate, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
