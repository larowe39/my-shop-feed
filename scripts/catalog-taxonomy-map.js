#!/usr/bin/env node
require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });
const { getFlagValue } = require("./lib/cliArgs");
const args = process.argv.slice(2);
const provider = getFlagValue(args, "--source") || getFlagValue(args, "--provider");
const externalId = getFlagValue(args, "--external-id");
const categoryId = getFlagValue(args, "--category-id") || null;
const subcategoryId = getFlagValue(args, "--subcategory-id") || null;
const externalName = getFlagValue(args, "--external-name") || null;
const externalPath = getFlagValue(args, "--external-path") || null;
const status = getFlagValue(args, "--status") || (args.includes("--verified") ? "verified" : "suggested");
const backend = getFlagValue(args, "--backend") || process.env.CATALOG_STAGING_BACKEND || undefined;
if (!provider || !externalId || (!categoryId && !subcategoryId)) {
  console.error("Usage: npm run catalog:taxonomy:map -- --source <provider> --external-id <id> --subcategory-id <id> [--category-id <id>] [--status suggested|verified|rejected] [--apply]");
  process.exit(1);
}
(async () => {
  const { resolveTaxonomyMappingStore } = await import("../lib/catalogTaxonomyMappings.ts");
  const store = resolveTaxonomyMappingStore({ backend });
  const target = await store.validateCanonicalTarget(categoryId, subcategoryId);
  const input = {
    identity: { provider, externalId, name: externalName, path: externalPath },
    status,
    method: "manual",
    evidence: { operator: "catalog:taxonomy:map" },
  };
  console.log(`TAXONOMY MAPPING BACKEND: ${store.kind}`);
  console.log(`External: ${provider}:${externalId} (${externalName || "name unavailable"})`);
  console.log(`Canonical category: ${target.categoryName || "-"}`);
  console.log(`Canonical subcategory: ${target.subcategoryName || "-"}`);
  console.log(`Status: ${status}`);
  console.log(`Trusted for automatic reuse: ${status === "verified" ? "yes" : "no"}`);
  if (!args.includes("--apply")) {
    console.log("DRY RUN -- ZERO WRITES");
    return;
  }
  const mapping = await store.upsertMapping(input, target);
  console.log(`APPLY -- mapping ${mapping.id} saved; no candidates approved or promoted.`);
})().catch((error) => { console.error(error.message || error); process.exit(1); });
