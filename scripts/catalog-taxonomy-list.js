#!/usr/bin/env node
require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });
const { getFlagValue } = require("./lib/cliArgs");
const args = process.argv.slice(2);
const backend = getFlagValue(args, "--backend") || process.env.CATALOG_STAGING_BACKEND || undefined;
const provider = getFlagValue(args, "--source") || getFlagValue(args, "--provider");
const status = getFlagValue(args, "--status");
const limit = Math.max(1, Number(getFlagValue(args, "--limit") || 50));
(async () => {
  const { resolveTaxonomyMappingStore } = await import("../lib/catalogTaxonomyMappings.ts");
  const store = resolveTaxonomyMappingStore({ backend });
  if (args.includes("--unmapped")) {
    const { resolveStagingStore } = await import("../lib/stagingStore.ts");
    const stagingStore = resolveStagingStore({ backend });
    const candidates = await stagingStore.listStagedCandidates();
    const counts = new Map();
    for (const candidate of candidates) {
      const identity = candidate.externalTaxonomy || candidate.rawPayload.externalTaxonomy;
      if (!identity) continue;
      const mapping = await store.resolveTrustedMapping(identity);
      if (!mapping) {
        const key = `${identity.provider}:${identity.externalId}`;
        const current = counts.get(key) || { provider: identity.provider, externalId: identity.externalId, name: identity.name || "-", count: 0 };
        current.count += 1;
        counts.set(key, current);
      }
    }
    console.log(`UNMAPPED EXTERNAL TAXONOMY NODES: ${counts.size}`);
    [...counts.values()].sort((left, right) => right.count - left.count).slice(0, limit).forEach((row) => console.log(`${row.provider} ${row.externalId} | ${row.name} | ${row.count} candidate(s)`));
    return;
  }
  const mappings = (await store.listMappings({ provider, status })).slice(0, limit);
  console.log(`TAXONOMY MAPPING BACKEND: ${store.kind}`);
  console.log(`MAPPINGS: ${mappings.length}`);
  for (const mapping of mappings) {
    console.log(`${mapping.provider} ${mapping.externalTaxonomyId} | ${mapping.externalName || "-"} | ${mapping.status} | ${mapping.canonicalSubcategoryName || mapping.canonicalCategoryName || "unresolved"}`);
  }
})().catch((error) => { console.error(error.message || error); process.exit(1); });
