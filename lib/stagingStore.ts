// lib/stagingStore.ts
//
// Explicit storage abstraction for the catalog acquisition/staging pipeline.
//
// LOCAL/TEST:  LocalStagingStore persists to a gitignored JSON ledger
//              (.catalog-staging/*.json). Only usable when a backend is
//              explicitly selected as "local" (CLI --backend=local flag or
//              CATALOG_STAGING_BACKEND=local env var). Intended for unit
//              tests and local development fixtures only.
//
// PRODUCTION:  SupabaseStagingStore is the only source of truth for real
//              staging data. It writes to public.catalog_sources,
//              public.catalog_import_runs, public.catalog_staged_products and
//              public.catalog_staged_aliases using the service-role key.
//
// resolveStagingStore() is the single chokepoint for backend selection. It
// NEVER silently falls back from Supabase to local: if the caller asks for
// (or defaults to) the Supabase backend and credentials/tables are missing,
// it throws StagingBackendError so callers fail closed.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import {
  SUPABASE_STAGING_ALIAS_BATCH_SIZE,
  SUPABASE_STAGING_READ_PAGE_SIZE,
  SUPABASE_STAGING_WRITE_BATCH_SIZE,
} from "./catalogStagingTypes.ts";
import type {
  ImportRunRecord,
  ReviewStatus,
  SourceRegistryEntry,
  StagedCatalogCandidate,
} from "./catalogStagingTypes.ts";

export type StagingBackendKind = "local" | "supabase";

export class StagingBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StagingBackendError";
  }
}

export type CreateImportRunInput = {
  adapter: string;
  sourcePath?: string | null;
  dryRun: boolean;
  processed: number;
  valid: number;
  invalid: number;
  exactExisting: number;
  likelyExisting: number;
  possibleExisting: number;
  newRecords: number;
  conflictRecords: number;
  approved: number;
  rejected: number;
  promoted: number;
  staged: number;
  errors: number;
  summary: Record<string, unknown>;
};

export interface StagingStore {
  readonly kind: StagingBackendKind;
  upsertSource(entry: SourceRegistryEntry): Promise<SourceRegistryEntry>;
  createImportRun(source: SourceRegistryEntry, input: CreateImportRunInput): Promise<ImportRunRecord>;
  /** Idempotent by fingerprint: re-submitting the same candidate updates it in place instead of duplicating. */
  upsertStagedCandidates(candidates: StagedCatalogCandidate[]): Promise<StagedCatalogCandidate[]>;
  listStagedCandidates(): Promise<StagedCatalogCandidate[]>;
  getStagedCandidateById(id: string): Promise<StagedCatalogCandidate | null>;
  updateCandidateStatus(id: string, status: ReviewStatus, reviewNotes?: string | null): Promise<StagedCatalogCandidate | null>;
  markPromoted(id: string, canonicalProductId: string): Promise<StagedCatalogCandidate | null>;
}

function makeId(prefix: string): string {
  return `${prefix}_${createHash("sha1").update(`${Date.now()}-${Math.random()}-${prefix}`).digest("hex").slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// LOCAL/TEST backend
// ---------------------------------------------------------------------------

type LocalLedger = {
  sourceRegistry: SourceRegistryEntry[];
  importRuns: ImportRunRecord[];
  stagedProducts: StagedCatalogCandidate[];
  stagedAliases: Array<{ id: string; stagedProductId: string; alias: string; normalizedAlias: string; createdAt: string }>;
};

function emptyLedger(): LocalLedger {
  return { sourceRegistry: [], importRuns: [], stagedProducts: [], stagedAliases: [] };
}

export function getLocalLedgerPath(): string {
  const configured = process.env.CATALOG_STAGING_LEDGER_PATH;
  if (configured) return configured;
  return path.join(process.cwd(), ".catalog-staging", "catalog-staging-ledger.json");
}

export class LocalStagingStore implements StagingStore {
  readonly kind: StagingBackendKind = "local";
  private readonly ledgerPath: string;

  constructor(ledgerPath: string = getLocalLedgerPath()) {
    this.ledgerPath = ledgerPath;
  }

  private ensureDir(): void {
    const dir = path.dirname(this.ledgerPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  reset(): void {
    this.ensureDir();
    fs.writeFileSync(this.ledgerPath, JSON.stringify(emptyLedger(), null, 2));
  }

  private read(): LocalLedger {
    this.ensureDir();
    if (!fs.existsSync(this.ledgerPath)) {
      const ledger = emptyLedger();
      fs.writeFileSync(this.ledgerPath, JSON.stringify(ledger, null, 2));
      return ledger;
    }
    try {
      const raw = fs.readFileSync(this.ledgerPath, "utf8");
      const parsed = JSON.parse(raw || "{}") as Partial<LocalLedger>;
      return {
        sourceRegistry: Array.isArray(parsed.sourceRegistry) ? parsed.sourceRegistry : [],
        importRuns: Array.isArray(parsed.importRuns) ? parsed.importRuns : [],
        stagedProducts: Array.isArray(parsed.stagedProducts) ? parsed.stagedProducts : [],
        stagedAliases: Array.isArray(parsed.stagedAliases) ? parsed.stagedAliases : [],
      };
    } catch {
      this.reset();
      return emptyLedger();
    }
  }

  private write(ledger: LocalLedger): void {
    this.ensureDir();
    fs.writeFileSync(this.ledgerPath, JSON.stringify(ledger, null, 2));
  }

  async upsertSource(entry: SourceRegistryEntry): Promise<SourceRegistryEntry> {
    const ledger = this.read();
    const normalizedName = entry.name.trim();
    const existing = ledger.sourceRegistry.find((row) => row.name === normalizedName || (entry.id && row.id === entry.id));
    if (existing) {
      Object.assign(existing, entry, { id: existing.id ?? entry.id ?? makeId("source"), name: normalizedName });
      this.write(ledger);
      return existing;
    }
    const created: SourceRegistryEntry = {
      id: entry.id ?? makeId("source"),
      name: normalizedName,
      type: entry.type,
      baseUrl: entry.baseUrl ?? null,
      trustClassification: entry.trustClassification ?? "staged",
      active: entry.active ?? true,
      notes: entry.notes ?? null,
      metadata: entry.metadata ?? {},
    };
    ledger.sourceRegistry.push(created);
    this.write(ledger);
    return created;
  }

  async createImportRun(source: SourceRegistryEntry, input: CreateImportRunInput): Promise<ImportRunRecord> {
    const ledger = this.read();
    const run: ImportRunRecord = {
      id: makeId("run"),
      sourceId: source.id ?? null,
      adapter: input.adapter,
      sourcePath: input.sourcePath ?? null,
      dryRun: input.dryRun,
      processed: input.processed,
      valid: input.valid,
      invalid: input.invalid,
      exactExisting: input.exactExisting,
      likelyExisting: input.likelyExisting,
      possibleExisting: input.possibleExisting,
      newRecords: input.newRecords,
      conflictRecords: input.conflictRecords,
      approved: input.approved,
      rejected: input.rejected,
      promoted: input.promoted,
      staged: input.staged,
      errors: input.errors,
      status: "completed",
      summary: input.summary,
      createdAt: new Date().toISOString(),
    };
    ledger.importRuns.push(run);
    this.write(ledger);
    return run;
  }

  async upsertStagedCandidates(candidates: StagedCatalogCandidate[]): Promise<StagedCatalogCandidate[]> {
    const ledger = this.read();
    const results: StagedCatalogCandidate[] = [];
    for (const candidate of candidates) {
      const existingIndex = ledger.stagedProducts.findIndex(
        (row) => row.fingerprint === candidate.fingerprint && (row.sourceExternalId ?? "") === (candidate.sourceExternalId ?? "")
      );
      if (existingIndex >= 0) {
        ledger.stagedProducts[existingIndex] = {
          ...ledger.stagedProducts[existingIndex],
          ...candidate,
          id: ledger.stagedProducts[existingIndex].id,
          updatedAt: new Date().toISOString(),
        };
        results.push(ledger.stagedProducts[existingIndex]);
        continue;
      }
      ledger.stagedProducts.push(candidate);
      results.push(candidate);

      const aliasValues = Array.from(new Set([...(candidate.aliases ?? []), candidate.brand, candidate.productName, candidate.modelNumber ?? ""])).filter(
        Boolean
      );
      for (const alias of aliasValues) {
        const normalizedAlias = alias.toLowerCase();
        if (ledger.stagedAliases.some((row) => row.stagedProductId === candidate.id && row.normalizedAlias === normalizedAlias)) continue;
        ledger.stagedAliases.push({ id: makeId("alias"), stagedProductId: candidate.id, alias, normalizedAlias, createdAt: new Date().toISOString() });
      }
    }
    this.write(ledger);
    return results;
  }

  async listStagedCandidates(): Promise<StagedCatalogCandidate[]> {
    return this.read().stagedProducts;
  }

  async getStagedCandidateById(id: string): Promise<StagedCatalogCandidate | null> {
    return this.read().stagedProducts.find((row) => row.id === id) ?? null;
  }

  async updateCandidateStatus(id: string, status: ReviewStatus, reviewNotes?: string | null): Promise<StagedCatalogCandidate | null> {
    const ledger = this.read();
    const index = ledger.stagedProducts.findIndex((row) => row.id === id);
    if (index === -1) return null;
    ledger.stagedProducts[index] = {
      ...ledger.stagedProducts[index],
      status,
      reviewNotes: reviewNotes ?? ledger.stagedProducts[index].reviewNotes ?? null,
      updatedAt: new Date().toISOString(),
    };
    this.write(ledger);
    return ledger.stagedProducts[index];
  }

  async markPromoted(id: string, canonicalProductId: string): Promise<StagedCatalogCandidate | null> {
    const ledger = this.read();
    const index = ledger.stagedProducts.findIndex((row) => row.id === id);
    if (index === -1) return null;
    ledger.stagedProducts[index] = {
      ...ledger.stagedProducts[index],
      status: "promoted",
      promotedCatalogProductId: canonicalProductId,
      promotedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.write(ledger);
    return ledger.stagedProducts[index];
  }
}

// ---------------------------------------------------------------------------
// PRODUCTION (Supabase) backend
// ---------------------------------------------------------------------------

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function rowToCandidate(row: Record<string, unknown>): StagedCatalogCandidate {
  return {
    id: String(row.id),
    sourceId: (row.source_id as string) ?? null,
    sourceExternalId: (row.source_external_id as string) ?? null,
    fingerprint: String(row.fingerprint ?? ""),
    status: (row.status as ReviewStatus) ?? "pending",
    classification: "NEW",
    brand: String(row.normalized_brand ?? ""),
    productName: String(row.normalized_name ?? ""),
    modelNumber: (row.normalized_model as string) ?? null,
    family: (row.proposed_family as string) ?? null,
    category: (row.proposed_category as string) ?? null,
    subcategory: (row.proposed_subcategory as string) ?? null,
    aliases: [],
    sourceUrl: (row.source_url as string) ?? null,
    sourceType: (row.source_type as string) ?? null,
    rawPayload: (row.raw_payload as Record<string, unknown>) ?? {},
    normalizedBrand: (row.normalized_brand as string) ?? undefined,
    normalizedName: (row.normalized_name as string) ?? undefined,
    normalizedModel: (row.normalized_model as string) ?? undefined,
    confidence: Number(row.confidence ?? 0),
    duplicateOfCatalogProductId: (row.duplicate_of_catalog_product_id as string) ?? null,
    promotedCatalogProductId: (row.promoted_catalog_product_id as string) ?? null,
    promotedAt: (row.promoted_at as string) ?? null,
    reviewNotes: (row.review_notes as string) ?? null,
    createdAt: String(row.created_at ?? new Date().toISOString()),
    updatedAt: String(row.updated_at ?? new Date().toISOString()),
  };
}

/**
 * The real production staging backend. Every write goes to Supabase's
 * catalog_sources / catalog_import_runs / catalog_staged_products /
 * catalog_staged_aliases tables via the service-role client — never a local
 * file. Batched (not one network call per candidate/alias):
 *   - read page size: SUPABASE_STAGING_READ_PAGE_SIZE (500 rows/page)
 *   - staged-product write batch size: SUPABASE_STAGING_WRITE_BATCH_SIZE (200 rows/upsert)
 *   - staged-alias write batch size: SUPABASE_STAGING_ALIAS_BATCH_SIZE (500 rows/upsert)
 */
export class SupabaseStagingStore implements StagingStore {
  readonly kind: StagingBackendKind = "supabase";
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async upsertSource(entry: SourceRegistryEntry): Promise<SourceRegistryEntry> {
    const { data, error } = await this.client
      .from("catalog_sources")
      .upsert(
        {
          name: entry.name,
          type: entry.type,
          base_url: entry.baseUrl ?? null,
          trust_classification: entry.trustClassification ?? "staged",
          active: entry.active ?? true,
          notes: entry.notes ?? null,
          metadata: entry.metadata ?? {},
        },
        { onConflict: "name" }
      )
      .select("id, name, type, base_url, trust_classification, active, notes, metadata")
      .single();
    if (error) throw new StagingBackendError(`Failed to upsert catalog_sources row: ${error.message}`);
    return {
      id: data.id,
      name: data.name,
      type: data.type,
      baseUrl: data.base_url,
      trustClassification: data.trust_classification,
      active: data.active,
      notes: data.notes,
      metadata: data.metadata,
    };
  }

  async createImportRun(source: SourceRegistryEntry, input: CreateImportRunInput): Promise<ImportRunRecord> {
    const { data, error } = await this.client
      .from("catalog_import_runs")
      .insert({
        source_id: source.id ?? null,
        adapter: input.adapter,
        source_path: input.sourcePath ?? null,
        dry_run: input.dryRun,
        processed: input.processed,
        valid: input.valid,
        invalid: input.invalid,
        exact_existing: input.exactExisting,
        likely_existing: input.likelyExisting,
        possible_existing: input.possibleExisting,
        new_records: input.newRecords,
        conflict_records: input.conflictRecords,
        staged: input.staged,
        errors: input.errors,
        approved: input.approved,
        rejected: input.rejected,
        promoted: input.promoted,
        status: "completed",
        summary: input.summary,
      })
      .select("id, created_at")
      .single();
    if (error) throw new StagingBackendError(`Failed to insert catalog_import_runs row: ${error.message}`);
    return {
      id: data.id,
      sourceId: source.id ?? null,
      adapter: input.adapter,
      sourcePath: input.sourcePath ?? null,
      dryRun: input.dryRun,
      processed: input.processed,
      valid: input.valid,
      invalid: input.invalid,
      exactExisting: input.exactExisting,
      likelyExisting: input.likelyExisting,
      possibleExisting: input.possibleExisting,
      newRecords: input.newRecords,
      conflictRecords: input.conflictRecords,
      approved: input.approved,
      rejected: input.rejected,
      promoted: input.promoted,
      staged: input.staged,
      errors: input.errors,
      status: "completed",
      summary: input.summary,
      createdAt: data.created_at,
    };
  }

  async upsertStagedCandidates(candidates: StagedCatalogCandidate[]): Promise<StagedCatalogCandidate[]> {
    const results: StagedCatalogCandidate[] = [];
    for (const batch of chunk(candidates, SUPABASE_STAGING_WRITE_BATCH_SIZE)) {
      if (!batch.length) continue;
      const rows = batch.map((candidate) => ({
        source_id: candidate.sourceId ?? null,
        source_external_id: candidate.sourceExternalId ?? null,
        fingerprint: candidate.fingerprint,
        raw_payload: candidate.rawPayload,
        normalized_brand: candidate.normalizedBrand ?? candidate.brand,
        normalized_name: candidate.normalizedName ?? candidate.productName,
        normalized_model: candidate.normalizedModel ?? candidate.modelNumber ?? null,
        proposed_category: candidate.category ?? null,
        proposed_subcategory: candidate.subcategory ?? null,
        proposed_family: candidate.family ?? null,
        source_url: candidate.sourceUrl ?? null,
        source_type: candidate.sourceType ?? null,
        status: candidate.status,
        confidence: candidate.confidence,
        duplicate_of_catalog_product_id: candidate.duplicateOfCatalogProductId ?? null,
        review_notes: candidate.reviewNotes ?? null,
      }));
      const { data, error } = await this.client
        .from("catalog_staged_products")
        .upsert(rows, { onConflict: "fingerprint" })
        .select("id, fingerprint");
      if (error) throw new StagingBackendError(`Failed to upsert catalog_staged_products batch: ${error.message}`);

      const idByFingerprint = new Map((data ?? []).map((row: { id: string; fingerprint: string }) => [row.fingerprint, row.id]));
      const aliasRows: Array<{ staged_product_id: string; alias: string; normalized_alias: string }> = [];
      for (const candidate of batch) {
        const stagedId = idByFingerprint.get(candidate.fingerprint);
        if (!stagedId) continue;
        candidate.id = stagedId;
        results.push(candidate);
        const aliasValues = Array.from(new Set([...(candidate.aliases ?? []), candidate.brand, candidate.productName, candidate.modelNumber ?? ""])).filter(
          Boolean
        );
        for (const alias of aliasValues) {
          aliasRows.push({ staged_product_id: stagedId, alias, normalized_alias: alias.toLowerCase() });
        }
      }

      for (const aliasBatch of chunk(aliasRows, SUPABASE_STAGING_ALIAS_BATCH_SIZE)) {
        if (!aliasBatch.length) continue;
        const { error: aliasError } = await this.client
          .from("catalog_staged_aliases")
          .upsert(aliasBatch, { onConflict: "staged_product_id,normalized_alias" });
        if (aliasError) throw new StagingBackendError(`Failed to upsert catalog_staged_aliases batch: ${aliasError.message}`);
      }
    }
    return results;
  }

  async listStagedCandidates(): Promise<StagedCatalogCandidate[]> {
    const rows: StagedCatalogCandidate[] = [];
    let from = 0;
    for (;;) {
      const { data, error } = await this.client
        .from("catalog_staged_products")
        .select("*")
        .range(from, from + SUPABASE_STAGING_READ_PAGE_SIZE - 1);
      if (error) throw new StagingBackendError(`Failed to list catalog_staged_products: ${error.message}`);
      rows.push(...(data ?? []).map(rowToCandidate));
      if (!data || data.length < SUPABASE_STAGING_READ_PAGE_SIZE) break;
      from += SUPABASE_STAGING_READ_PAGE_SIZE;
    }
    return rows;
  }

  async getStagedCandidateById(id: string): Promise<StagedCatalogCandidate | null> {
    const { data, error } = await this.client.from("catalog_staged_products").select("*").eq("id", id).maybeSingle();
    if (error) throw new StagingBackendError(`Failed to fetch catalog_staged_products row ${id}: ${error.message}`);
    return data ? rowToCandidate(data) : null;
  }

  async updateCandidateStatus(id: string, status: ReviewStatus, reviewNotes?: string | null): Promise<StagedCatalogCandidate | null> {
    const { data, error } = await this.client
      .from("catalog_staged_products")
      .update({ status, review_notes: reviewNotes ?? null })
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (error) throw new StagingBackendError(`Failed to update catalog_staged_products row ${id}: ${error.message}`);
    return data ? rowToCandidate(data) : null;
  }

  async markPromoted(id: string, canonicalProductId: string): Promise<StagedCatalogCandidate | null> {
    const { data, error } = await this.client
      .from("catalog_staged_products")
      .update({ status: "promoted", promoted_catalog_product_id: canonicalProductId, promoted_at: new Date().toISOString() })
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (error) throw new StagingBackendError(`Failed to mark catalog_staged_products row ${id} promoted: ${error.message}`);
    return data ? rowToCandidate(data) : null;
  }
}

export type ResolveStagingStoreOptions = {
  /** Explicit backend selection. If omitted, defaults to "supabase" (production-safe default — never silently local). */
  backend?: StagingBackendKind;
};

/**
 * Single chokepoint for staging backend selection.
 *
 * - backend: "local"  -> LocalStagingStore (JSON ledger). Only for tests/dev.
 * - backend: "supabase" or omitted -> SupabaseStagingStore. Requires
 *   EXPO_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. Throws
 *   StagingBackendError (fails closed) if either is missing — it never falls
 *   back to the local ledger.
 */
export function resolveStagingStore(options: ResolveStagingStoreOptions = {}): StagingStore {
  const backend = options.backend ?? "supabase";
  if (backend === "local") {
    return new LocalStagingStore();
  }

  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new StagingBackendError(
      "Supabase staging backend requested (or defaulted to) but credentials are missing. " +
        "Set EXPO_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in a local, gitignored .env.local, " +
        "or explicitly pass --backend=local for local/test runs. Refusing to silently fall back to the local ledger."
    );
  }
  const client = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return new SupabaseStagingStore(client);
}
