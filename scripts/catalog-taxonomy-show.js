#!/usr/bin/env node
require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });
const { getFlagValue } = require("./lib/cliArgs");
const args = process.argv.slice(2);
const provider = getFlagValue(args, "--source") || getFlagValue(args, "--provider");
const externalId = getFlagValue(args, "--external-id");
const backend = getFlagValue(args, "--backend") || process.env.CATALOG_STAGING_BACKEND || undefined;
if (!provider || !externalId) { console.error("Usage: npm run catalog:taxonomy:show -- --source <provider> --external-id <id> [--backend local|supabase]"); process.exit(1); }
(async () => {
  const { resolveTaxonomyMappingStore } = await import("../lib/catalogTaxonomyMappings.ts");
  const store = resolveTaxonomyMappingStore({ backend });
  const mapping = await store.getMapping({ provider, externalId });
  if (!mapping) { console.log(`No mapping found for ${provider}:${externalId}`); return; }
  console.log(`TAXONOMY MAPPING BACKEND: ${store.kind}`);
  console.log(`Provider: ${mapping.provider}`);
  console.log(`External ID: ${mapping.externalTaxonomyId}`);
  console.log(`External name: ${mapping.externalName || "-"}`);
  console.log(`External path: ${mapping.externalPath || "-"}`);
  console.log(`Status: ${mapping.status}`);
  console.log(`Canonical category: ${mapping.canonicalCategoryName || "-"}`);
  console.log(`Canonical subcategory: ${mapping.canonicalSubcategoryName || "-"}`);
  console.log(`Trusted for reuse: ${mapping.status === "verified" ? "yes" : "no"}`);
})().catch((error) => { console.error(error.message || error); process.exit(1); });
