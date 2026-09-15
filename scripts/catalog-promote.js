#!/usr/bin/env node
const args = { apply: false };
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] === "--apply") args.apply = true;
}

(async () => {
  const { promoteApprovedCandidates } = await import("../lib/catalogAcquisition.ts");
  const result = promoteApprovedCandidates({ dryRun: !args.apply, apply: args.apply });
  console.log(result.message);
  if (result.promoted.length) {
    console.log(JSON.stringify(result.promoted, null, 2));
  }
})();
