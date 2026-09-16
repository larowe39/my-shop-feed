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

function canonicalSegmentSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function destinationExists(mapping, canonicalTree) {
  if (!mapping || !mapping.canonicalPath || !canonicalTree) return false;
  const segments = mapping.canonicalPath.split(">").map((segment) => canonicalSegmentSlug(segment));
  if (segments.length < 2) return false;
  return [...canonicalTree.loaded.taxonomy.categories.values()].some((category) => {
    if (canonicalSegmentSlug(category.name) !== segments[0]) return false;
    return [...canonicalTree.nodes.values()].some((node) => {
      if (node.categorySlug !== category.slug || node.path.length !== segments.length - 1) return false;
      return node.path.every((part, index) => part === segments[index + 1]);
    });
  });
}

function mappingKey(provider, externalId) {
  return `${String(provider || "").trim().toLowerCase()}:${String(externalId || "").trim()}`;
}

async function resolveRunCandidates(stagingStore, runId) {
  const rows = await stagingStore.listStagedCandidates();
  const filtered = rows.filter((candidate) => !runId || candidate.importRunId === runId);
  return filtered.filter((candidate) => {
    const identity = candidate.externalTaxonomy || candidate.rawPayload?.externalTaxonomy;
    return identity && typeof identity === "object" && String(identity.provider || "").trim();
  });
}

async function buildCoverageReport({ runId, planFile, logger = console } = {}, sourceRows, normalizedPlan, canonicalTree, persistedMappings = []) {
  const planByKey = new Map(normalizedPlan.mappings.map((entry) => [`${entry.provider}:${entry.externalId}`, entry]));
  const persistedVerifiedByKey = new Map(
    persistedMappings
      .filter((entry) => String(entry.status || "").trim().toLowerCase() === "verified")
      .map((entry) => [mappingKey(entry.provider, entry.externalTaxonomyId), entry])
  );
  const byId = new Map();

  for (const candidate of sourceRows) {
    const identity = candidate.externalTaxonomy || candidate.rawPayload?.externalTaxonomy;
    if (!identity || typeof identity !== "object") continue;
    const provider = String(identity.provider || "").trim().toLowerCase();
    const externalId = String(identity.externalId || "").trim();
    const key = `${provider}:${externalId}`;
    const mapping = planByKey.get(key) || null;
    const persistedMapping = persistedVerifiedByKey.get(key) || null;
    const currentResolved = Boolean(
      (candidate.category && candidate.subcategory) ||
      (candidate.rawPayload && candidate.rawPayload.taxonomyMapping && candidate.rawPayload.taxonomyMapping.status === "verified") ||
      persistedMapping
    );
    const row = byId.get(key) || {
      provider,
      externalId,
      externalName: identity.name || null,
      path: identity.path || null,
      sourceCount: 0,
      currentResolvedCount: 0,
      newlyResolvedCount: 0,
      resolvedAfterPlanCount: 0,
      unresolvedAfterPlanCount: 0,
      currentResolved: false,
      wouldResolve: Boolean(mapping),
      persistedMapping: Boolean(persistedMapping),
      destination: (mapping || persistedMapping) ? (mapping?.canonicalPath || mapping?.canonicalSubcategory || mapping?.canonicalCategory || persistedMapping?.canonicalSubcategoryName || persistedMapping?.canonicalCategoryName) : null,
      destinationExists: destinationExists(mapping, canonicalTree) || Boolean(persistedMapping?.canonicalSubcategoryId || persistedMapping?.canonicalCategoryId),
      sampleProducts: [],
      resolved: false,
      afterPlanState: "unresolved",
    };
    row.sourceCount += 1;
    row.currentResolvedCount += currentResolved ? 1 : 0;
    row.newlyResolvedCount += !currentResolved && mapping ? 1 : 0;
    row.resolvedAfterPlanCount += currentResolved || mapping ? 1 : 0;
    row.unresolvedAfterPlanCount += !currentResolved && !mapping ? 1 : 0;
    row.sampleProducts = [...new Set([...row.sampleProducts, candidate.productName])].slice(0, 3);
    byId.set(key, row);
  }

  const byExternalCategory = [...byId.values()]
    .map((row) => ({
      ...row,
      currentResolved: row.currentResolvedCount === row.sourceCount,
      resolved: row.resolvedAfterPlanCount === row.sourceCount,
      currentResolution: row.currentResolvedCount === row.sourceCount ? "resolved" : row.currentResolvedCount ? "partial" : "unresolved",
      afterPlanState: row.resolvedAfterPlanCount === row.sourceCount ? "resolved" : row.resolvedAfterPlanCount ? "partial" : "unresolved",
    }))
    .sort((left, right) => right.sourceCount - left.sourceCount);
  const currentlyResolvedProducts = byExternalCategory.reduce((sum, row) => sum + row.currentResolvedCount, 0);
  const currentlyUnresolvedProducts = byExternalCategory.reduce((sum, row) => sum + (row.sourceCount - row.currentResolvedCount), 0);
  const newlyResolvedProducts = byExternalCategory.reduce((sum, row) => sum + row.newlyResolvedCount, 0);
  const resolvedAfterPlanProducts = byExternalCategory.reduce((sum, row) => sum + row.resolvedAfterPlanCount, 0);
  const unresolvedAfterPlanProducts = byExternalCategory.reduce((sum, row) => sum + row.unresolvedAfterPlanCount, 0);
  const mappedExternalTaxonomyIds = byExternalCategory.filter((row) => row.wouldResolve).length;
  const unresolvedExternalTaxonomyIds = byExternalCategory.filter((row) => !row.wouldResolve).length;
  const result = {
    runId,
    totalRunProducts: sourceRows.length,
    currentlyResolvedProducts,
    currentlyUnresolvedProducts,
    newlyResolvedProducts,
    resolvedAfterPlanProducts,
    unresolvedAfterPlanProducts,
    mappedExternalTaxonomyIds,
    unresolvedExternalTaxonomyIds,
    byExternalCategory,
    plan: normalizedPlan,
  };
  if (logger) {
    logger.log(`RUN: ${runId || "n/a"}`);
    logger.log(`Total run products: ${result.totalRunProducts}`);
    logger.log(`Currently resolved products: ${result.currentlyResolvedProducts}`);
    logger.log(`Currently unresolved products: ${result.currentlyUnresolvedProducts}`);
    logger.log(`Proposed newly resolved products: ${result.newlyResolvedProducts}`);
    logger.log(`Resolved products after plan: ${result.resolvedAfterPlanProducts}`);
    logger.log(`Unresolved products after plan: ${result.unresolvedAfterPlanProducts}`);
    logger.log(`Mapped external taxonomy IDs: ${result.mappedExternalTaxonomyIds}`);
    logger.log(`Unresolved external taxonomy IDs: ${result.unresolvedExternalTaxonomyIds}`);
    for (const row of result.byExternalCategory) {
      logger.log(`${row.provider}:${row.externalId} | sourceCount=${row.sourceCount} | current=${row.currentResolution} | proposed=${row.wouldResolve ? "yes" : "no"} | afterPlan=${row.afterPlanState} | destinationExists=${row.destinationExists ? "yes" : "no"} | destination=${row.destination || "-"}`);
    }
  }
  return result;
}

async function computeCoverage({ runId, backend, planFile, logger = console } = {}, extra = {}) {
  const store = extra.store || null;
  const resolvedPlanFile = planFile || extra.planFile || extra.planPath || planPath;
  const normalizedPlan = loadPlan(resolvedPlanFile);
  let candidateRows = [];

  if (store && typeof store.listStagedCandidates === "function") {
    candidateRows = await store.listStagedCandidates();
  }

  const sourceRows = candidateRows.filter((candidate) => !runId || candidate.importRunId === runId);
  const canonicalTree = await loadCanonicalTree();
  const mappingStore = extra.mappingStore || (await import("../lib/catalogTaxonomyMappings.ts")).resolveTaxonomyMappingStore({ backend });
  const persistedMappings = await mappingStore.listMappings();
  return buildCoverageReport({ runId, planFile: resolvedPlanFile, logger }, sourceRows, normalizedPlan, canonicalTree, persistedMappings);
}

async function main() {
  const { resolveStagingStore } = await import("../lib/stagingStore.ts");
  const store = resolveStagingStore({ backend });
  const sourceRows = await resolveRunCandidates(store, runId);
  const normalizedPlan = loadPlan(planPath);
  const canonicalTree = await loadCanonicalTree();
  const { resolveTaxonomyMappingStore } = await import("../lib/catalogTaxonomyMappings.ts");
  const mappingStore = resolveTaxonomyMappingStore({ backend });
  const persistedMappings = await mappingStore.listMappings();
  await buildCoverageReport({ runId, planFile: planPath, logger: console }, sourceRows, normalizedPlan, canonicalTree, persistedMappings);
}

module.exports = { computeCoverage: computeCoverage, loadPlan, main };

if (require.main === module) {
  main().catch((error) => { console.error(error.message || error); process.exit(1); });
}
