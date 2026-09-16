#!/usr/bin/env node
require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });
const fs = require("fs");
const path = require("path");
const { getFlagValue } = require("./lib/cliArgs");

const args = process.argv.slice(2);
const runId = getFlagValue(args, "--run-id") || null;
const planPath = getFlagValue(args, "--plan") || path.join(__dirname, "..", "docs", "catalog-taxonomy-mapping-plan.json");
const backend = getFlagValue(args, "--backend") || process.env.CATALOG_STAGING_BACKEND || undefined;

function normalizePlan(raw) {
  if (!raw || typeof raw !== "object") return { mappings: [], unresolved: [] };
  const mappings = Array.isArray(raw.mappings) ? raw.mappings : [];
  const unresolved = Array.isArray(raw.unresolved) ? raw.unresolved : [];
  return {
    mappings: mappings.map((row) => ({
      provider: String(row.provider || "").trim().toLowerCase(),
      externalId: String(row.externalId || "").trim(),
      externalName: row.externalName || null,
      canonicalPath: row.canonicalPath || null,
      canonicalCategory: row.canonicalCategory || null,
      canonicalSubcategory: row.canonicalSubcategory || null,
      status: String(row.status || "review").trim().toLowerCase(),
    })),
    unresolved: unresolved.map((row) => ({
      provider: String(row.provider || "").trim().toLowerCase(),
      externalId: String(row.externalId || "").trim(),
      externalName: row.externalName || null,
      reason: row.reason || "review-required",
    })),
  };
}

function loadPlan(planFile) {
  if (!planFile || !fs.existsSync(planFile)) {
    throw new Error(`Mapping plan file not found: ${planFile}`);
  }
  const parsed = JSON.parse(fs.readFileSync(planFile, "utf8"));
  return normalizePlan(parsed);
}

async function loadCanonicalTree() {
  const { loadAndValidateCatalogData } = require("./lib/catalogDataLoader");
  const { normalizeCatalogText } = await import("../lib/catalogMatching.ts");
  const loaded = loadAndValidateCatalogData(path.join(__dirname, "..", "catalog-data"), normalizeCatalogText);
  const nodes = new Map();
  for (const [key, value] of loaded.taxonomy.subcategoryByPath.entries()) {
    nodes.set(key, { key, categorySlug: value.categorySlug, path: value.path, name: value.name });
  }
  return { loaded, nodes };
}

async function resolveRunCandidates(stagingStore, runId) {
  const rows = await stagingStore.listStagedCandidates();
  const filtered = rows.filter((candidate) => !runId || candidate.importRunId === runId);
  return filtered.filter((candidate) => {
    const identity = candidate.externalTaxonomy || candidate.rawPayload?.externalTaxonomy;
    return identity && typeof identity === "object" && String(identity.provider || "").trim();
  });
}

async function computeCoverage({ runId, backend, planFile, logger = console } = {}, extra = {}) {
  const store = extra.store || null;
  const resolvedPlanFile = planFile || extra.planFile || extra.planPath || planPath;
  const normalizedPlan = loadPlan(resolvedPlanFile);
  const planByKey = new Map(normalizedPlan.mappings.map((entry) => [`${entry.provider}:${entry.externalId}`, entry]));
  const resolved = [];
  const unresolved = [];
  let candidateRows = [];

  if (store && typeof store.listStagedCandidates === "function") {
    candidateRows = await store.listStagedCandidates();
  }

  const sourceRows = candidateRows.filter((candidate) => !runId || candidate.importRunId === runId);
  const byId = new Map();
  for (const candidate of sourceRows) {
    const identity = candidate.externalTaxonomy || candidate.rawPayload?.externalTaxonomy;
    if (!identity || typeof identity !== "object") continue;
    const provider = String(identity.provider || "").trim().toLowerCase();
    const externalId = String(identity.externalId || "").trim();
    const key = `${provider}:${externalId}`;
    const mapping = planByKey.get(key);
    const match = candidate.category && candidate.subcategory ? { category: candidate.category, subcategory: candidate.subcategory } : null;
    const currentResolved = Boolean(
      (candidate.category && candidate.subcategory) ||
      (candidate.rawPayload && candidate.rawPayload.taxonomyMapping && candidate.rawPayload.taxonomyMapping.status === "verified") ||
      (candidate.externalTaxonomy && candidate.rawPayload && candidate.rawPayload.externalTaxonomy && candidate.rawPayload.externalTaxonomy.provider === candidate.externalTaxonomy.provider && String(candidate.rawPayload.externalTaxonomy.externalId || "") === String(candidate.externalTaxonomy.externalId || "") && candidate.rawPayload.taxonomyMapping && candidate.rawPayload.taxonomyMapping.status === "verified")
    );
    byId.set(key, {
      provider,
      externalId,
      externalName: identity.name || null,
      path: identity.path || null,
      currentResolved,
      wouldResolve: Boolean(mapping),
      destination: mapping ? mapping.canonicalPath || mapping.canonicalSubcategory || mapping.canonicalCategory : null,
      candidateCount: (byId.get(key)?.candidateCount ?? 0) + 1,
      sampleProducts: [...(byId.get(key)?.sampleProducts ?? []), candidate.productName].slice(0, 3),
      resolvedByCurrentMapping: currentResolved,
      resolved: currentResolved || Boolean(mapping),
      match,
    });
  }

  const byExternalCategory = [...byId.values()].sort((left, right) => right.candidateCount - left.candidateCount);
  const currentlyResolved = byExternalCategory.filter((row) => row.currentResolved).length;
  const proposedResolved = byExternalCategory.filter((row) => row.currentResolved || row.wouldResolve).length;
  const currentlyUnresolved = byExternalCategory.length - currentlyResolved;
  const stillUnresolved = byExternalCategory.filter((row) => !row.currentResolved && !row.wouldResolve).length;
  const result = {
    total: sourceRows.length,
    currentlyResolved,
    currentlyUnresolved,
    proposedResolved,
    stillUnresolved,
    byExternalCategory,
    plan: normalizedPlan,
  };
  if (logger) {
    logger.log(`Run: ${runId || "n/a"}`);
    logger.log(`Total run products: ${result.total}`);
    logger.log(`Currently resolved: ${result.currentlyResolved}`);
    logger.log(`Currently unresolved: ${result.currentlyUnresolved}`);
    logger.log(`Would resolve under proposed mappings: ${result.proposedResolved}`);
    logger.log(`Still unresolved: ${result.stillUnresolved}`);
    for (const row of result.byExternalCategory) {
      logger.log(`${row.provider}:${row.externalId} | ${row.externalName || "-"} | current=${row.currentResolved ? "yes" : "no"} | wouldResolve=${row.wouldResolve ? "yes" : "no"} | dest=${row.destination || "-"}`);
    }
  }
  return result;
}

async function main() {
  const { resolveStagingStore } = await import("../lib/stagingStore.ts");
  const store = resolveStagingStore({ backend });
  const planFile = planPath;
  const normalizedPlan = loadPlan(planFile);
  const sourceRows = await resolveRunCandidates(store, runId);
  const byExternalCategory = new Map();

  for (const candidate of sourceRows) {
    const identity = candidate.externalTaxonomy || candidate.rawPayload?.externalTaxonomy;
    const provider = String(identity.provider || "").trim().toLowerCase();
    const externalId = String(identity.externalId || "").trim();
    const key = `${provider}:${externalId}`;
    const mapping = normalizedPlan.mappings.find((entry) => entry.provider === provider && entry.externalId === externalId);
    const row = byExternalCategory.get(key) || {
      provider,
      externalId,
      externalName: identity.name || null,
      path: identity.path || null,
      candidateCount: 0,
      currentResolved: false,
      wouldResolve: Boolean(mapping),
      destination: mapping ? mapping.canonicalPath || mapping.canonicalSubcategory || mapping.canonicalCategory : null,
      sampleProducts: [],
      resolved: false,
    };
    row.candidateCount += 1;
    row.currentResolved =
      row.currentResolved ||
      Boolean(candidate.category && candidate.subcategory) ||
      Boolean(
        candidate.rawPayload &&
          candidate.rawPayload.taxonomyMapping &&
          candidate.rawPayload.taxonomyMapping.status === "verified"
      );
    row.sampleProducts = [...new Set([...row.sampleProducts, candidate.productName])].slice(0, 3);
    row.resolved = row.currentResolved || row.wouldResolve;
    byExternalCategory.set(key, row);
  }

  const byExternalCategoryList = [...byExternalCategory.values()].sort((left, right) => right.candidateCount - left.candidateCount);
  const total = sourceRows.length;
  const currentlyResolved = byExternalCategoryList.filter((row) => row.currentResolved).length;
  const currentlyUnresolved = total - currentlyResolved;
  const proposedResolved = byExternalCategoryList.filter((row) => row.currentResolved || row.wouldResolve).length;
  const stillUnresolved = byExternalCategoryList.filter((row) => !row.currentResolved && !row.wouldResolve).length;

  const report = {
    runId,
    total,
    currentlyResolved,
    currentlyUnresolved,
    proposedResolved,
    stillUnresolved,
    byExternalCategory: byExternalCategoryList,
    plan: normalizedPlan,
  };

  console.log(`RUN: ${runId || "n/a"}`);
  console.log(`Total run products: ${report.total}`);
  console.log(`Currently resolved: ${report.currentlyResolved}`);
  console.log(`Currently unresolved: ${report.currentlyUnresolved}`);
  console.log(`Proposed mappings resolve: ${report.proposedResolved}`);
  console.log(`Still unresolved: ${report.stillUnresolved}`);
  for (const row of byExternalCategoryList) {
    console.log(`${row.provider}:${row.externalId} | ${row.externalName || "-"} | current=${row.currentResolved ? "yes" : "no"} | wouldResolve=${row.wouldResolve ? "yes" : "no"} | sourceCount=${row.candidateCount} | destination=${row.destination || "-"}`);
  }
}

module.exports = { computeCoverage: computeCoverage, loadPlan, main };

if (require.main === module) {
  main().catch((error) => { console.error(error.message || error); process.exit(1); });
}
