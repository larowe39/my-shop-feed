// lib/catalogAcquisition.ts
//
// Pure parsing/validation/classification helpers plus the orchestration
// functions for the ACQUIRE -> STAGE -> REVIEW -> APPROVE/REJECT -> PROMOTE
// pipeline. Storage is fully delegated to the StagingStore /
// CanonicalPromotionStore abstractions in ./stagingStore and
// ./catalogPromotion -- this file never touches a JSON file or a Supabase
// client directly, so backend selection always goes through one chokepoint.
//
// lib/catalogMatching.ts (Matcher V2) is imported read-only and never modified
// by this file.
import { createHash } from "node:crypto";
import { findCatalogMatches } from "./catalogMatching.ts";
import type {
  CandidateClassification,
  CanonicalCatalogEntry,
  CatalogCandidateInput,
  ReviewStatus,
  StagedCatalogCandidate,
} from "./catalogStagingTypes.ts";
import type { CreateImportRunInput, StagingStore } from "./stagingStore.ts";
import type { AcquisitionSummary, SourceRegistryEntry } from "./catalogStagingTypes.ts";
import type { CanonicalPromotionStore } from "./catalogPromotion.ts";

export type {
  CandidateClassification,
  ReviewStatus,
  SourceRegistryEntry,
  CatalogCandidateInput,
  CanonicalCatalogEntry,
  StagedCatalogCandidate,
  AcquisitionSummary,
} from "./catalogStagingTypes.ts";

export type AcquisitionRunResult = {
  source?: SourceRegistryEntry;
  sourceId?: string;
  runId?: string;
  staged: StagedCatalogCandidate[];
  invalidRecords: Array<{
    candidate: Partial<CatalogCandidateInput>;
    errors: string[];
    classification: CandidateClassification;
  }>;
  summary: AcquisitionSummary;
  persistence: string[];
};

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeAcquisitionText(value: string | null | undefined): string {
  return normalizeText(value);
}

function normalizeAliasList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry : String(entry ?? "")))
      .flatMap((entry) => entry.split(/[;,]/))
      .map((entry) => entry.trim())
      .filter(Boolean)
      .filter((entry, index, list) => list.indexOf(entry) === index)
      .map((entry) => normalizeAcquisitionText(entry));
  }
  if (typeof value === "string") {
    return value
      .split(/[;,]/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .filter((entry, index, list) => list.indexOf(entry) === index)
      .map((entry) => normalizeAcquisitionText(entry));
  }
  return [];
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

function compactComparable(value: string | null | undefined): string {
  return normalizeAcquisitionText(value).replace(/\s+/g, "").trim();
}

export function sourceFingerprint(data: {
  sourceId?: string | null;
  sourceExternalId?: string | null;
  brand?: string | null;
  productName?: string | null;
  modelNumber?: string | null;
  family?: string | null;
  category?: string | null;
  sourceUrl?: string | null;
}): string {
  const payload = {
    sourceId: data.sourceId ?? "",
    sourceExternalId: data.sourceExternalId ?? "",
    brand: normalizeAcquisitionText(data.brand),
    productName: normalizeAcquisitionText(data.productName),
    modelNumber: normalizeAcquisitionText(data.modelNumber),
    family: normalizeAcquisitionText(data.family),
    category: normalizeAcquisitionText(data.category),
    sourceUrl: data.sourceUrl ?? "",
  };
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export function canonicalMatchCandidates(canonical: CanonicalCatalogEntry[]) {
  const now = new Date().toISOString();
  return canonical.map((entry) => ({
    product: {
      id: `${entry.brand}|${entry.productName}|${entry.modelNumber ?? ""}`,
      brand_id: entry.brand,
      family_id: entry.family ?? null,
      subcategory_id: entry.subcategory ?? null,
      slug: normalizeAcquisitionText(entry.productName),
      name: entry.productName,
      model_number: entry.modelNumber ?? null,
      release_year: null,
      description: null,
      upc: null,
      gtin: null,
      mpn: null,
      status: "active" as const,
      attributes: {},
      created_at: now,
      updated_at: now,
    },
    brandName: entry.brand,
    categoryName: entry.category ?? "",
    aliases: entry.aliases ?? [],
  }));
}

export function validateCatalogCandidate(candidate: Partial<CatalogCandidateInput>): {
  valid: boolean;
  errors: string[];
  normalized: {
    brand: string;
    productName: string;
    modelNumber: string;
    family: string;
    category: string;
    subcategory: string;
    aliases: string[];
  };
} {
  const errors: string[] = [];
  const rawBrand = typeof candidate.brand === "string" ? candidate.brand.trim() : "";
  const rawProductName = typeof candidate.productName === "string" ? candidate.productName.trim() : "";
  const normalizedBrand = normalizeAcquisitionText(rawBrand);
  const normalizedProductName = normalizeAcquisitionText(rawProductName);
  const normalizedModel = normalizeAcquisitionText(candidate.modelNumber ?? "");
  const normalizedFamily = normalizeAcquisitionText(candidate.family ?? "");
  const normalizedCategory = normalizeAcquisitionText(candidate.category ?? "");
  const normalizedSubcategory = normalizeAcquisitionText(candidate.subcategory ?? "");
  const aliases = normalizeAliasList(candidate.aliases ?? []);

  if (!normalizedBrand) errors.push("brand is required");
  if (!normalizedProductName) errors.push("productName is required");
  if (!candidate.raw || typeof candidate.raw !== "object") errors.push("raw payload is required");

  const hasSourceReference = Boolean(
    (typeof candidate.sourceExternalId === "string" && candidate.sourceExternalId.trim()) ||
      (typeof candidate.sourceId === "string" && candidate.sourceId.trim())
  );
  if (!hasSourceReference) errors.push("sourceExternalId or sourceId is required");

  return {
    valid: errors.length === 0,
    errors,
    normalized: {
      brand: normalizedBrand,
      productName: normalizedProductName,
      modelNumber: normalizedModel,
      family: normalizedFamily,
      category: normalizedCategory,
      subcategory: normalizedSubcategory,
      aliases,
    },
  };
}

// Deterministic acquisition-candidate identity evidence, distinct from Matcher
// V2's seller-listing fuzzy scoring. compactComparable() strips ALL whitespace
// in addition to punctuation, so "WH-1000XM5" (normalizes with an internal
// space, since the hyphen becomes a separator) and "WH1000XM5" (no separator
// to begin with) compare equal instead of silently missing each other only
// because one source used punctuation and another didn't. This must stay
// exact-token comparison (no fuzzy/substring logic) so near-miss identities
// (990v5 vs 990v6, HERO12 vs HERO13, DCD998 vs DCD999, Pro vs Pro Max) never
// collapse together.
function compactEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = compactComparable(a);
  const right = compactComparable(b);
  return Boolean(left) && Boolean(right) && left === right;
}

function identityTokenMatches(candidateValue: string | null | undefined, canonicalValue: string | null | undefined): boolean {
  return compactEquals(candidateValue, canonicalValue);
}

export function classifyCandidate(
  candidate: Partial<CatalogCandidateInput>,
  canonicalCatalog: CanonicalCatalogEntry[] = []
): CandidateClassification {
  const validation = validateCatalogCandidate(candidate as CatalogCandidateInput);
  if (!validation.valid) return "INVALID";

  const brand = validation.normalized.brand;
  const productName = validation.normalized.productName;
  const modelNumber = validation.normalized.modelNumber;

  const exactMatch = canonicalCatalog.some((entry) => {
    const sameBrand = identityTokenMatches(brand, entry.brand);
    if (!sameBrand) return false;

    // 1. EXACT brand + normalized model/reference -- the strongest signal:
    // two different sellers listing the same brand + model number/SKU are
    // the same real-world product regardless of how the name is phrased.
    if (modelNumber && identityTokenMatches(modelNumber, entry.modelNumber)) return true;

    // 2. EXACT normalized canonical name (brand + name, or name alone --
    // canonical product names in this catalog don't repeat the brand).
    if (identityTokenMatches(productName, entry.productName)) return true;
    if (identityTokenMatches(`${brand} ${productName}`, entry.productName)) return true;

    // 3. EXACT normalized alias -- catalog_aliases / staged aliases exist
    // specifically to capture "how sellers actually phrase this" (e.g. "GoPro
    // Hero 13", "JBL Boombox 3"), so alias equality to the candidate's own
    // brand+name or model number is exact identity evidence, not a fuzzy hit.
    const entryAliases = entry.aliases ?? [];
    const candidateAliasCombos = [productName, modelNumber, `${brand} ${productName}`].filter(Boolean) as string[];
    if (entryAliases.some((alias) => candidateAliasCombos.some((value) => identityTokenMatches(value, alias)))) return true;

    return false;
  });
  if (exactMatch) return "EXACT_EXISTING";

  const sameBrandSimilar = canonicalCatalog.some((entry) => {
    const sameBrand = identityTokenMatches(brand, entry.brand);
    if (!sameBrand) return false;
    const sameName = identityTokenMatches(productName, entry.productName);
    const sameModel = Boolean(modelNumber && entry.modelNumber && identityTokenMatches(modelNumber, entry.modelNumber));
    const aliasOverlap = (entry.aliases ?? []).some(
      (alias) => identityTokenMatches(productName, alias) || identityTokenMatches(modelNumber, alias) || identityTokenMatches(brand, alias)
    );
    return sameName || sameModel || aliasOverlap;
  });
  if (sameBrandSimilar) return "LIKELY_EXISTING";

  const candidateInput = { title: productName, brand };
  const matches = findCatalogMatches(candidateInput, canonicalMatchCandidates(canonicalCatalog));
  const best = matches[0];
  if (best) return "POSSIBLE_EXISTING";

  return "NEW";
}

export function parseJsonAdapterRecords(raw: string): CatalogCandidateInput[] {
  const parsed = JSON.parse(raw);
  const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed.products) ? parsed.products : Array.isArray(parsed.records) ? parsed.records : [];
  return records.map((entry: Record<string, unknown>) => ({
    sourceExternalId: typeof entry.sourceExternalId === "string" ? entry.sourceExternalId : typeof entry.source_external_id === "string" ? entry.source_external_id : null,
    sourceId: typeof entry.sourceId === "string" ? entry.sourceId : typeof entry.source_id === "string" ? entry.source_id : null,
    brand: String(entry.brand ?? ""),
    productName: String(entry.productName ?? entry.name ?? ""),
    modelNumber: typeof entry.modelNumber === "string" ? entry.modelNumber : typeof entry.model_number === "string" ? entry.model_number : null,
    family: typeof entry.family === "string" ? entry.family : null,
    category: typeof entry.category === "string" ? entry.category : null,
    subcategory: typeof entry.subcategory === "string" ? entry.subcategory : null,
    aliases: Array.isArray(entry.aliases) ? entry.aliases.filter((alias) => typeof alias === "string") : [],
    sourceUrl: typeof entry.sourceUrl === "string" ? entry.sourceUrl : typeof entry.source_url === "string" ? entry.source_url : null,
    sourceType: typeof entry.sourceType === "string" ? entry.sourceType : typeof entry.source_type === "string" ? entry.source_type : null,
    raw: entry,
  }));
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

export function parseCsvAdapterRecords(raw: string): CatalogCandidateInput[] {
  const trimmed = raw.trim();
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];

  const headers = splitCsvLine(lines[0]).map((header) => header.trim());
  const rows: CatalogCandidateInput[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const values = splitCsvLine(lines[index]);
    const row: Record<string, string> = {};
    for (let headerIndex = 0; headerIndex < headers.length; headerIndex += 1) {
      row[headers[headerIndex]] = values[headerIndex] ?? "";
    }

    const aliases = normalizeAliasList(row.aliases ?? row.Aliases ?? row.aliasesList ?? []);
    rows.push({
      sourceExternalId: row.sourceExternalId || row.source_external_id || null,
      sourceId: row.sourceId || row.source_id || null,
      brand: row.brand || "",
      productName: row.productName || row.name || "",
      modelNumber: row.modelNumber || row.model_number || null,
      family: row.family || null,
      category: row.category || null,
      subcategory: row.subcategory || null,
      aliases,
      sourceUrl: row.sourceUrl || row.source_url || null,
      sourceType: row.sourceType || row.source_type || null,
      raw: row,
    });
  }
  return rows;
}

function makeId(prefix: string): string {
  return `${prefix}_${createHash("sha1").update(`${Date.now()}-${Math.random()}-${prefix}`).digest("hex").slice(0, 12)}`;
}

/**
 * ACQUIRE step. Classifies every record and, when `options.apply` is true,
 * persists staged candidates through the supplied StagingStore (required in
 * apply mode -- the caller chooses the backend via resolveStagingStore()).
 * Dry-run performs zero store calls: nothing is read or written anywhere.
 */
export async function acquireFromRecords(
  records: Partial<CatalogCandidateInput>[],
  canonicalCatalog: CanonicalCatalogEntry[] = [],
  sourceInfo: Partial<SourceRegistryEntry> = {},
  options: { apply?: boolean; adapter?: string; sourcePath?: string | null } = {},
  store?: StagingStore
): Promise<AcquisitionRunResult> {
  const apply = options.apply ?? false;
  if (apply && !store) {
    throw new Error("acquireFromRecords: a StagingStore is required when apply=true. Resolve one via resolveStagingStore().");
  }

  const summary: AcquisitionSummary = {
    processed: records.length,
    valid: 0,
    invalid: 0,
    exactExisting: 0,
    likelyExisting: 0,
    possibleExisting: 0,
    new: 0,
    conflict: 0,
    staged: 0,
    errors: 0,
  };
  const candidates: StagedCatalogCandidate[] = [];
  const invalidRecords: AcquisitionRunResult["invalidRecords"] = [];

  const sourceType = sourceInfo.type ?? "manual import";
  for (let index = 0; index < records.length; index += 1) {
    const rawRecord = records[index] ?? {};
    const validation = validateCatalogCandidate(rawRecord as CatalogCandidateInput);
    if (!validation.valid) {
      summary.invalid += 1;
      summary.errors += 1;
      invalidRecords.push({ candidate: rawRecord, errors: validation.errors, classification: "INVALID" });
      continue;
    }

    summary.valid += 1;
    const classification = classifyCandidate(rawRecord as CatalogCandidateInput, canonicalCatalog);

    if (classification === "EXACT_EXISTING") {
      summary.exactExisting += 1;
      continue;
    }
    if (classification === "LIKELY_EXISTING") summary.likelyExisting += 1;
    else if (classification === "POSSIBLE_EXISTING") summary.possibleExisting += 1;
    else if (classification === "NEW") summary.new += 1;
    else if (classification === "CONFLICT") summary.conflict += 1;

    const status: ReviewStatus =
      classification === "LIKELY_EXISTING" || classification === "POSSIBLE_EXISTING" || classification === "CONFLICT" ? "needs_review" : "pending";
    const fingerprint = sourceFingerprint({
      sourceId: sourceInfo.id ?? rawRecord.sourceId ?? null,
      sourceExternalId: rawRecord.sourceExternalId ?? null,
      brand: rawRecord.brand,
      productName: rawRecord.productName,
      modelNumber: rawRecord.modelNumber,
      family: rawRecord.family,
      category: rawRecord.category,
      sourceUrl: rawRecord.sourceUrl ?? null,
    });

    candidates.push({
      id: makeId("candidate"),
      sourceId: sourceInfo.id ?? rawRecord.sourceId ?? null,
      sourceExternalId: rawRecord.sourceExternalId ?? null,
      fingerprint,
      status,
      classification,
      brand: rawRecord.brand ?? "",
      productName: rawRecord.productName ?? "",
      modelNumber: rawRecord.modelNumber ?? null,
      family: rawRecord.family ?? null,
      category: rawRecord.category ?? null,
      subcategory: rawRecord.subcategory ?? null,
      aliases: [...new Set(normalizeAliasList(rawRecord.aliases ?? []))],
      sourceUrl: rawRecord.sourceUrl ?? null,
      sourceType: rawRecord.sourceType ?? sourceType,
      rawPayload: rawRecord.raw ?? {},
      normalizedBrand: validation.normalized.brand,
      normalizedName: validation.normalized.productName,
      normalizedModel: validation.normalized.modelNumber || undefined,
      confidence: classification === "NEW" ? 0.88 : 0.62,
      duplicateOfCatalogProductId: null,
      reviewNotes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    summary.staged += 1;
  }

  const persistenceMessages: string[] = [];
  let source: SourceRegistryEntry | undefined;
  let runId: string | undefined;
  let stagedResult = candidates;

  if (apply && store) {
    source = await store.upsertSource({
      id: sourceInfo.id,
      name: sourceInfo.name ?? "fixture-source",
      type: sourceType,
      baseUrl: sourceInfo.baseUrl ?? null,
      trustClassification: sourceInfo.trustClassification ?? "staged",
      active: sourceInfo.active ?? true,
      notes: sourceInfo.notes ?? null,
      metadata: sourceInfo.metadata ?? {},
    });
    for (const candidate of candidates) candidate.sourceId = source.id ?? candidate.sourceId;

    stagedResult = await store.upsertStagedCandidates(candidates);

    const runInput: CreateImportRunInput = {
      adapter: options.adapter ?? "json",
      sourcePath: options.sourcePath ?? null,
      dryRun: false,
      processed: summary.processed,
      valid: summary.valid,
      invalid: summary.invalid,
      exactExisting: summary.exactExisting,
      likelyExisting: summary.likelyExisting,
      possibleExisting: summary.possibleExisting,
      newRecords: summary.new,
      conflictRecords: summary.conflict,
      approved: 0,
      rejected: 0,
      promoted: 0,
      staged: summary.staged,
      errors: summary.errors,
      summary,
    };
    const run = await store.createImportRun(source, runInput);
    runId = run.id;
    persistenceMessages.push(`${store.kind}:catalog_sources`, `${store.kind}:catalog_import_runs`, `${store.kind}:catalog_staged_products`);
  }

  return {
    source,
    sourceId: source?.id,
    runId,
    staged: stagedResult,
    invalidRecords,
    summary,
    persistence: persistenceMessages,
  };
}

export function printAcquisitionSummary(run: AcquisitionRunResult): string {
  const lines = [
    `SOURCE RECORDS: ${run.summary.processed}`,
    `VALID: ${run.summary.valid}`,
    `INVALID: ${run.summary.invalid}`,
    `EXACT EXISTING: ${run.summary.exactExisting}`,
    `LIKELY EXISTING: ${run.summary.likelyExisting}`,
    `POSSIBLE EXISTING: ${run.summary.possibleExisting}`,
    `NEW: ${run.summary.new}`,
    `CONFLICT: ${run.summary.conflict}`,
    `STAGED: ${run.summary.staged}`,
    `PERSISTENCE: ${run.persistence.join(", ") || "dry-run (zero writes)"}`,
  ];
  return lines.join("\n");
}

export async function showCandidate(store: StagingStore, candidateId: string): Promise<{ found: boolean; message: string; candidate?: StagedCatalogCandidate }> {
  const candidate = await store.getStagedCandidateById(candidateId);
  if (!candidate) return { found: false, message: `Candidate ${candidateId} not found in ${store.kind} staging backend.` };
  return { found: true, message: `Candidate ${candidateId} found in ${store.kind} staging backend.`, candidate };
}

const TERMINAL_STATUSES: ReviewStatus[] = ["invalid", "promoted"];
const APPROVABLE_STATUSES: ReviewStatus[] = ["pending", "needs_review", "duplicate"];

export async function approveCandidate(
  store: StagingStore,
  candidateId: string,
  options: { dryRun?: boolean } = {}
): Promise<{ ok: boolean; candidate?: StagedCatalogCandidate; message: string }> {
  const dryRun = options.dryRun ?? true;
  const candidate = await store.getStagedCandidateById(candidateId);
  if (!candidate) return { ok: false, message: `Candidate ${candidateId} not found in ${store.kind} staging backend.` };
  if (TERMINAL_STATUSES.includes(candidate.status)) {
    return { ok: false, candidate, message: `Candidate ${candidateId} is in a terminal status (${candidate.status}) and cannot be approved.` };
  }
  if (!APPROVABLE_STATUSES.includes(candidate.status) && candidate.status !== "approved") {
    return { ok: false, candidate, message: `Candidate ${candidateId} is not approvable in its current status (${candidate.status}).` };
  }
  if (dryRun) {
    return { ok: true, candidate: { ...candidate, status: "approved" }, message: `DRY RUN -- would approve candidate ${candidateId} in ${store.kind}; no writes performed.` };
  }
  const updated = await store.updateCandidateStatus(candidateId, "approved", `${candidate.reviewNotes ?? "approved"} | reviewed by CLI`);
  return { ok: true, candidate: updated ?? candidate, message: `Approved candidate ${candidateId} in ${store.kind} staging backend.` };
}

export async function rejectCandidate(
  store: StagingStore,
  candidateId: string,
  options: { dryRun?: boolean } = {}
): Promise<{ ok: boolean; candidate?: StagedCatalogCandidate; message: string }> {
  const dryRun = options.dryRun ?? true;
  const candidate = await store.getStagedCandidateById(candidateId);
  if (!candidate) return { ok: false, message: `Candidate ${candidateId} not found in ${store.kind} staging backend.` };
  if (candidate.status === "promoted") {
    return { ok: false, candidate, message: `Candidate ${candidateId} has already been promoted and cannot be rejected.` };
  }
  if (dryRun) {
    return { ok: true, candidate: { ...candidate, status: "rejected" }, message: `DRY RUN -- would reject candidate ${candidateId} in ${store.kind}; no writes performed.` };
  }
  const updated = await store.updateCandidateStatus(candidateId, "rejected", `${candidate.reviewNotes ?? "rejected"} | reviewed by CLI`);
  return { ok: true, candidate: updated ?? candidate, message: `Rejected candidate ${candidateId} in ${store.kind} staging backend.` };
}

export type PromotionReportEntry = {
  candidateId: string;
  ok: boolean;
  dryRun: boolean;
  canonicalProductId?: string;
  message: string;
};

export type PromotionRunResult = {
  ok: boolean;
  entries: PromotionReportEntry[];
  message: string;
};

const NEVER_PROMOTE_STATUSES: ReviewStatus[] = ["pending", "needs_review", "rejected", "invalid", "promoted", "duplicate"];

/**
 * PROMOTE step. Reads status='approved' rows from `stagingStore`, revalidates
 * them, rechecks canonical duplicates/conflicts via `canonicalStore`
 * immediately before writing, and -- only when `dryRun` is false -- performs
 * the canonical write through `canonicalStore.promote()` (a single atomic
 * Postgres RPC in production; see lib/catalogPromotion.ts). A staged row is
 * only ever marked "promoted" after its canonical write succeeded.
 */
export async function promoteApprovedCandidates(
  stagingStore: StagingStore,
  canonicalStore: CanonicalPromotionStore,
  options: { dryRun?: boolean } = {}
): Promise<PromotionRunResult> {
  const dryRun = options.dryRun ?? true;
  const allStaged = await stagingStore.listStagedCandidates();
  const approved = allStaged.filter((candidate) => candidate.status === "approved" && !NEVER_PROMOTE_STATUSES.includes(candidate.status));

  if (!approved.length) {
    return { ok: true, entries: [], message: "No approved staged candidates found. Nothing to promote." };
  }

  const entries: PromotionReportEntry[] = [];
  for (const candidate of approved) {
    const revalidation = validateCatalogCandidate({
      brand: candidate.brand,
      productName: candidate.productName,
      modelNumber: candidate.modelNumber,
      family: candidate.family,
      category: candidate.category,
      subcategory: candidate.subcategory,
      aliases: candidate.aliases,
      sourceExternalId: candidate.sourceExternalId,
      sourceId: candidate.sourceId,
      raw: candidate.rawPayload,
    });
    if (!revalidation.valid) {
      entries.push({ candidateId: candidate.id, ok: false, dryRun, message: `Revalidation failed: ${revalidation.errors.join(", ")}. Skipped.` });
      continue;
    }

    const eligibility = await canonicalStore.checkEligibility(candidate);
    if (!eligibility.eligible) {
      entries.push({ candidateId: candidate.id, ok: false, dryRun, message: eligibility.reason });
      continue;
    }

    if (dryRun) {
      entries.push({
        candidateId: candidate.id,
        ok: true,
        dryRun: true,
        message: `DRY RUN -- would promote ${candidate.id} (brand=${eligibility.resolution.brandSlug}, slug=${eligibility.resolution.slug}); zero canonical writes performed.`,
      });
      continue;
    }

    const outcome = await canonicalStore.promote(candidate, eligibility.resolution);
    if (!outcome.ok) {
      entries.push({ candidateId: candidate.id, ok: false, dryRun: false, message: outcome.message });
      continue;
    }
    // Supabase's RPC transitions the staged row to 'promoted' atomically as
    // part of the same write; only the local/test mock needs a second call.
    if (canonicalStore.kind === "local") {
      await stagingStore.markPromoted(candidate.id, outcome.canonicalProductId!);
    }
    entries.push({ candidateId: candidate.id, ok: true, dryRun: false, canonicalProductId: outcome.canonicalProductId, message: outcome.message });
  }

  const promotedCount = entries.filter((entry) => entry.ok && !entry.dryRun).length;
  const eligibleCount = entries.filter((entry) => entry.ok).length;
  const message = dryRun
    ? `DRY RUN -- ${eligibleCount}/${approved.length} approved candidate(s) are eligible for promotion; zero canonical writes performed.`
    : `${promotedCount}/${approved.length} approved candidate(s) promoted to the canonical catalog.`;
  return { ok: true, entries, message };
}
