#!/usr/bin/env node
require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });
const { getFlagValue } = require("./lib/cliArgs");

const args = process.argv.slice(2);
const source = (getFlagValue(args, "--source") || "").toLowerCase();
const externalId = getFlagValue(args, "--external-id");
const refreshCache = args.includes("--refresh-cache");

(async () => {
  if (source !== "open-icecat" || !externalId) {
    console.error("Usage: npm run catalog:taxonomy:external -- --source open-icecat --external-id <ID> [--refresh-cache]");
    process.exit(1);
  }

  const taxonomy = await import("../lib/catalogProviderTaxonomy.ts");
  if (refreshCache) {
    const { buildIcecatAuthHeaders } = await import("../lib/catalogProviders.ts");
    const headers = buildIcecatAuthHeaders({
      apiToken: process.env.ICECAT_API_TOKEN,
      username: process.env.ICECAT_USERNAME,
      password: process.env.ICECAT_PASSWORD,
    });
    const identities = await taxonomy.fetchOpenIcecatTaxonomy({ headers });
    taxonomy.saveOpenIcecatTaxonomyCache(identities);
  }

  const identity = taxonomy.loadOpenIcecatTaxonomyCache().get(externalId);
  if (!identity) {
    throw new Error(`Open Icecat external category ${externalId} is unavailable in the local authoritative cache. Run again with --refresh-cache.`);
  }

  console.log("Provider: open-icecat");
  console.log(`External ID: ${identity.externalId}`);
  console.log(`Name: ${identity.name ?? "unavailable"}`);
  console.log(`Parent ID: ${identity.parentId ?? "unavailable"}`);
  console.log(`Parent name: ${identity.parentName ?? "unavailable"}`);
  console.log(`Parent path: ${identity.parentPath ?? "unavailable"}`);
  console.log(`Path: ${identity.path ?? "unavailable"}`);
  console.log("PENCHANT mapping: not inspected or created");
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
