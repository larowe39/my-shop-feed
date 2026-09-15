#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const DEFAULT_SOURCE = { name: "fixture-source", type: "manual import" };

function parseArgs() {
  const args = { apply: false, dryRun: true, adapter: "json", source: null };
  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index];
    if (value === "--apply") args.apply = true;
    if (value === "--dry-run") args.dryRun = true;
    if (value === "--adapter") args.adapter = process.argv[++index] || "json";
    if (value === "--source") args.source = process.argv[++index] || null;
  }
  args.dryRun = !args.apply;
  return args;
}

async function main() {
  const args = parseArgs();
  const { acquireFromRecords, parseJsonAdapterRecords, parseCsvAdapterRecords, printAcquisitionSummary } = await import("../lib/catalogAcquisition.ts");

  const sourcePath = args.source || path.join(__dirname, "__fixtures__", "catalog-acquisition", "sample-products.json");
  const raw = fs.readFileSync(sourcePath, "utf8");

  const records = args.adapter === "csv" ? parseCsvAdapterRecords(raw) : parseJsonAdapterRecords(raw);
  const run = acquireFromRecords(records, [], { ...DEFAULT_SOURCE, name: path.basename(sourcePath), type: args.adapter });

  console.log(printAcquisitionSummary(run));
  if (args.apply) {
    console.log("APPLY — WRITING STAGING DATA");
  } else {
    console.log("DRY RUN — NO WRITES");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
