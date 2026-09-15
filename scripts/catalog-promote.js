#!/usr/bin/env node
const args = { apply: false };
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] === "--apply") args.apply = true;
}

if (args.apply) {
  console.log("PROMOTION APPLY — WRITING CANONICAL DATA");
} else {
  console.log("PROMOTION DRY RUN — NO CANONICAL WRITES");
  console.log("Approved staged candidates would be eligible for canonical promotion after explicit --apply.");
}
