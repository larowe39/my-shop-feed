#!/usr/bin/env node
const assert = require("assert");
const path = require("path");
const fs = require("fs");

async function main() {
  const mod = await import("../lib/catalogAcquisition.ts");
  const {
    normalizeAcquisitionText,
    parseJsonAdapterRecords,
    parseCsvAdapterRecords,
    validateCatalogCandidate,
    classifyCandidate,
    sourceFingerprint,
    acquireFromRecords,
  } = mod;

  const jsonSource = path.join(__dirname, "__fixtures__", "catalog-acquisition", "sample-products.json");
  const jsonRows = parseJsonAdapterRecords(fs.readFileSync(jsonSource, "utf8"));
  assert.ok(jsonRows.length >= 4);
  assert.strictEqual(jsonRows[0].brand, "Sony");

  const csvSource = path.join(__dirname, "__fixtures__", "catalog-acquisition", "sample-products.csv");
  const csvRows = parseCsvAdapterRecords(fs.readFileSync(csvSource, "utf8"));
  assert.ok(csvRows.length >= 4);
  assert.strictEqual(csvRows[0].brand, "JBL");

  assert.strictEqual(normalizeAcquisitionText("WH-1000XM4"), "wh 1000xm4");
  assert.notStrictEqual(normalizeAcquisitionText("WH-1000XM4"), normalizeAcquisitionText("WH-1000XM5"));
  assert.notStrictEqual(normalizeAcquisitionText("990v5"), normalizeAcquisitionText("990v6"));
  assert.notStrictEqual(normalizeAcquisitionText("DCD998"), normalizeAcquisitionText("DCD999"));
  assert.notStrictEqual(normalizeAcquisitionText("HERO12"), normalizeAcquisitionText("HERO13"));
  assert.notStrictEqual(normalizeAcquisitionText("iPhone 15 Pro"), normalizeAcquisitionText("iPhone 15 Pro Max"));

  const invalid = validateCatalogCandidate({ brand: "", productName: "", sourceExternalId: "", raw: {} });
  assert.strictEqual(invalid.valid, false);

  const duplicateCandidate = { brand: "Sony", productName: "Sony WH-1000XM5", modelNumber: "WH-1000XM5", family: "Wireless Headphones", category: "Electronics", aliases: ["WH1000XM5"], sourceExternalId: "sony-1" };
  const duplicateClassification = classifyCandidate(duplicateCandidate, [{ brand: "Sony", productName: "Sony WH-1000XM5", modelNumber: "WH-1000XM5", family: "Wireless Headphones" }]);
  assert.strictEqual(duplicateClassification, "EXACT_EXISTING");

  const likelyCandidate = { brand: "Sony", productName: "WH1000XM5", modelNumber: "WH-1000XM5", family: "Wireless Headphones", category: "Electronics", sourceExternalId: "sony-2" };
  const likelyClassification = classifyCandidate(likelyCandidate, [{ brand: "Sony", productName: "Sony WH-1000XM5", modelNumber: "WH-1000XM5", family: "Wireless Headphones" }]);
  assert.ok(["LIKELY_EXISTING", "EXACT_EXISTING"].includes(likelyClassification));

  const newCandidate = { brand: "GoPro", productName: "GoPro HERO13", modelNumber: "HERO13", family: "Action Cameras", category: "Electronics", sourceExternalId: "gopro-hero13" };
  const newClassification = classifyCandidate(newCandidate, [{ brand: "GoPro", productName: "GoPro HERO12", modelNumber: "HERO12" }]);
  assert.strictEqual(newClassification, "NEW");

  const fpA = sourceFingerprint({ sourceId: "src-1", sourceExternalId: "abc", brand: "JBL", productName: "Boombox 3" });
  const fpB = sourceFingerprint({ sourceId: "src-1", sourceExternalId: "abc", brand: "JBL", productName: "Boombox 3" });
  const fpC = sourceFingerprint({ sourceId: "src-1", sourceExternalId: "abc-2", brand: "JBL", productName: "Boombox 3" });
  assert.strictEqual(fpA, fpB);
  assert.notStrictEqual(fpA, fpC);

  const run = acquireFromRecords(
    [
      { sourceExternalId: "new-1", brand: "JBL", productName: "Boombox 3", modelNumber: "Boombox 3", family: "Portable Speakers", category: "Electronics", raw: { source: "fixture" } },
      { sourceExternalId: "dup-1", brand: "Sony", productName: "Sony WH-1000XM5", modelNumber: "WH-1000XM5", family: "Headphones", category: "Electronics", raw: { source: "fixture" } },
      { sourceExternalId: "bad-1", brand: "", productName: "", raw: { source: "fixture" } },
    ],
    [{ brand: "Sony", productName: "Sony WH-1000XM5", modelNumber: "WH-1000XM5" }],
    { sourceId: "fixture-source", sourceName: "Fixture source", sourceType: "manual import" }
  );
  assert.strictEqual(run.summary.valid, 2);
  assert.strictEqual(run.summary.invalid, 1);
  assert.strictEqual(run.summary.new, 1);
  assert.strictEqual(run.summary.exactExisting, 1);
  assert.ok(run.staged.length >= 1);

  console.log("Catalog acquisition tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
