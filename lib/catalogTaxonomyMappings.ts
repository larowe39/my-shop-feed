import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import type { ExternalTaxonomyIdentity } from "./catalogStagingTypes.ts";
import { mappingIsTrusted, mappingKey, type TaxonomyMappingInput, type TaxonomyMappingRecord } from "./catalogTaxonomyTypes.ts";
import { StagingBackendError } from "./stagingStore.ts";

export type CanonicalTaxonomyTarget = {
  categoryId: string | null;
  categoryName: string | null;
  subcategoryId: string | null;
  subcategoryName: string | null;
};

export interface TaxonomyMappingStore {
  readonly kind: "local" | "supabase";
  listMappings(options?: { provider?: string; status?: string }): Promise<TaxonomyMappingRecord[]>;
  getMapping(identity: ExternalTaxonomyIdentity): Promise<TaxonomyMappingRecord | null>;
  validateCanonicalTarget(categoryId: string | null, subcategoryId: string | null): Promise<CanonicalTaxonomyTarget>;
  upsertMapping(input: TaxonomyMappingInput, target: CanonicalTaxonomyTarget): Promise<TaxonomyMappingRecord>;
  resolveTrustedMapping(identity: ExternalTaxonomyIdentity): Promise<TaxonomyMappingRecord | null>;
}

function makeId(): string {
  return `mapping_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

function getLedgerPath(): string {
  return process.env.CATALOG_TAXONOMY_LEDGER_PATH || path.join(process.cwd(), ".catalog-staging", "catalog-taxonomy-mappings.json");
}

function emptyLedger(): TaxonomyMappingRecord[] {
  return [];
}

function readLedger(): TaxonomyMappingRecord[] {
  const ledgerPath = getLedgerPath();
  if (!fs.existsSync(ledgerPath)) return emptyLedger();
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLedger(rows: TaxonomyMappingRecord[]): void {
  const ledgerPath = getLedgerPath();
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(rows, null, 2));
}

function buildRecord(input: TaxonomyMappingInput, target: CanonicalTaxonomyTarget, existing?: TaxonomyMappingRecord): TaxonomyMappingRecord {
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? makeId(),
    provider: input.identity.provider.trim().toLowerCase(),
    externalTaxonomyId: input.identity.externalId.trim(),
    externalName: input.identity.name ?? null,
    externalPath: input.identity.path ?? null,
    externalParentId: input.identity.parentId ?? null,
    externalParentPath: input.identity.parentPath ?? null,
    canonicalCategoryId: target.categoryId,
    canonicalCategoryName: target.categoryName,
    canonicalSubcategoryId: target.subcategoryId,
    canonicalSubcategoryName: target.subcategoryName,
    status: input.status,
    method: input.method,
    confidence: input.confidence ?? null,
    evidence: input.evidence ?? {},
    reviewedBy: input.reviewedBy ?? null,
    reviewedAt: input.status === "verified" ? now : null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export class LocalTaxonomyMappingStore implements TaxonomyMappingStore {
  readonly kind = "local" as const;
  private readonly targets: { categories: Array<{ id: string; name: string }>; subcategories: Array<{ id: string; categoryId: string; name: string }> };

  constructor(targets: LocalTaxonomyMappingStore["targets"] = { categories: [], subcategories: [] }) {
    this.targets = targets;
  }

  async listMappings(options: { provider?: string; status?: string } = {}): Promise<TaxonomyMappingRecord[]> {
    return readLedger().filter((row) => (!options.provider || row.provider === options.provider.toLowerCase()) && (!options.status || row.status === options.status));
  }

  async getMapping(identity: ExternalTaxonomyIdentity): Promise<TaxonomyMappingRecord | null> {
    return (await this.listMappings()).find((row) => mappingKey({ provider: row.provider, externalId: row.externalTaxonomyId }) === mappingKey(identity)) ?? null;
  }

  async resolveTrustedMapping(identity: ExternalTaxonomyIdentity): Promise<TaxonomyMappingRecord | null> {
    const mapping = await this.getMapping(identity);
    return mappingIsTrusted(mapping) ? mapping : null;
  }

  async validateCanonicalTarget(categoryId: string | null, subcategoryId: string | null): Promise<CanonicalTaxonomyTarget> {
    const category = categoryId ? this.targets.categories.find((row) => row.id === categoryId) : null;
    if (categoryId && !category) throw new Error(`Canonical category ${categoryId} does not exist.`);
    const subcategory = subcategoryId ? this.targets.subcategories.find((row) => row.id === subcategoryId) : null;
    if (subcategoryId && !subcategory) throw new Error(`Canonical subcategory ${subcategoryId} does not exist.`);
    if (subcategory && category && subcategory.categoryId !== category.id) throw new Error("Canonical subcategory does not belong to the supplied category.");
    const resolvedCategory = category ?? (subcategory ? this.targets.categories.find((row) => row.id === subcategory.categoryId) : null);
    return { categoryId: resolvedCategory?.id ?? null, categoryName: resolvedCategory?.name ?? null, subcategoryId: subcategory?.id ?? null, subcategoryName: subcategory?.name ?? null };
  }

  async upsertMapping(input: TaxonomyMappingInput, target: CanonicalTaxonomyTarget): Promise<TaxonomyMappingRecord> {
    const rows = readLedger();
    const existing = rows.find((row) => mappingKey({ provider: row.provider, externalId: row.externalTaxonomyId }) === mappingKey(input.identity));
    const record = buildRecord(input, target, existing);
    const index = existing ? rows.indexOf(existing) : rows.length;
    rows[index] = record;
    writeLedger(rows);
    return record;
  }
}

function rowToMapping(row: Record<string, unknown>): TaxonomyMappingRecord {
  return {
    id: String(row.id),
    provider: String(row.provider),
    externalTaxonomyId: String(row.external_taxonomy_id),
    externalName: (row.external_name as string) ?? null,
    externalPath: (row.external_path as string) ?? null,
    externalParentId: (row.external_parent_id as string) ?? null,
    externalParentPath: (row.external_parent_path as string) ?? null,
    canonicalCategoryId: (row.canonical_category_id as string) ?? null,
    canonicalCategoryName: (row.canonical_category_name as string) ?? null,
    canonicalSubcategoryId: (row.canonical_subcategory_id as string) ?? null,
    canonicalSubcategoryName: (row.canonical_subcategory_name as string) ?? null,
    status: row.mapping_status as TaxonomyMappingRecord["status"],
    method: row.mapping_method as TaxonomyMappingRecord["method"],
    confidence: row.confidence == null ? null : Number(row.confidence),
    evidence: (row.evidence as Record<string, unknown>) ?? {},
    reviewedBy: (row.reviewed_by as string) ?? null,
    reviewedAt: (row.reviewed_at as string) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class SupabaseTaxonomyMappingStore implements TaxonomyMappingStore {
  readonly kind = "supabase" as const;
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async listMappings(options: { provider?: string; status?: string } = {}): Promise<TaxonomyMappingRecord[]> {
    let query = this.client.from("catalog_taxonomy_mappings").select("*").order("updated_at", { ascending: false });
    if (options.provider) query = query.eq("provider", options.provider.toLowerCase());
    if (options.status) query = query.eq("mapping_status", options.status);
    const { data, error } = await query;
    if (error) throw new StagingBackendError(`Failed to list taxonomy mappings: ${error.message}`);
    return ((data ?? []) as Record<string, unknown>[]).map(rowToMapping);
  }

  async getMapping(identity: ExternalTaxonomyIdentity): Promise<TaxonomyMappingRecord | null> {
    const { data, error } = await this.client.from("catalog_taxonomy_mappings").select("*").eq("provider", identity.provider.toLowerCase()).eq("external_taxonomy_id", identity.externalId).maybeSingle();
    if (error) throw new StagingBackendError(`Failed to read taxonomy mapping: ${error.message}`);
    if (!data) return null;
    const mapping = rowToMapping(data as Record<string, unknown>);
    const target = await this.validateCanonicalTarget(mapping.canonicalCategoryId, mapping.canonicalSubcategoryId);
    return { ...mapping, canonicalCategoryName: target.categoryName, canonicalSubcategoryName: target.subcategoryName };
  }

  async resolveTrustedMapping(identity: ExternalTaxonomyIdentity): Promise<TaxonomyMappingRecord | null> {
    const mapping = await this.getMapping(identity);
    return mappingIsTrusted(mapping) ? mapping : null;
  }

  async validateCanonicalTarget(categoryId: string | null, subcategoryId: string | null): Promise<CanonicalTaxonomyTarget> {
    let category: { id: string; name: string } | null = null;
    if (categoryId) {
      const result = await this.client.from("catalog_categories").select("id, name").eq("id", categoryId).maybeSingle();
      if (result.error) throw new StagingBackendError(`Failed to validate canonical category: ${result.error.message}`);
      category = result.data;
      if (!category) throw new Error(`Canonical category ${categoryId} does not exist.`);
    }
    let subcategory: { id: string; category_id: string; name: string } | null = null;
    if (subcategoryId) {
      const result = await this.client.from("catalog_subcategories").select("id, category_id, name").eq("id", subcategoryId).maybeSingle();
      if (result.error) throw new StagingBackendError(`Failed to validate canonical subcategory: ${result.error.message}`);
      subcategory = result.data;
      if (!subcategory) throw new Error(`Canonical subcategory ${subcategoryId} does not exist.`);
    }
    if (category && subcategory && category.id !== subcategory.category_id) throw new Error("Canonical subcategory does not belong to the supplied category.");
    if (!category && subcategory) {
      const result = await this.client.from("catalog_categories").select("id, name").eq("id", subcategory.category_id).single();
      if (result.error) throw new StagingBackendError(`Failed to resolve subcategory category: ${result.error.message}`);
      category = result.data;
    }
    return { categoryId: category?.id ?? null, categoryName: category?.name ?? null, subcategoryId: subcategory?.id ?? null, subcategoryName: subcategory?.name ?? null };
  }

  async upsertMapping(input: TaxonomyMappingInput, target: CanonicalTaxonomyTarget): Promise<TaxonomyMappingRecord> {
    const row = {
      provider: input.identity.provider.toLowerCase(), external_taxonomy_id: input.identity.externalId,
      external_name: input.identity.name ?? null, external_path: input.identity.path ?? null,
      external_parent_id: input.identity.parentId ?? null, external_parent_path: input.identity.parentPath ?? null,
      canonical_category_id: target.categoryId, canonical_subcategory_id: target.subcategoryId,
      mapping_status: input.status, mapping_method: input.method, confidence: input.confidence ?? null,
      evidence: input.evidence ?? {}, reviewed_by: input.reviewedBy ?? null,
      reviewed_at: input.status === "verified" ? new Date().toISOString() : null,
    };
    const { data, error } = await this.client.from("catalog_taxonomy_mappings").upsert(row, { onConflict: "provider,external_taxonomy_id" }).select("*").single();
    if (error) throw new StagingBackendError(`Failed to upsert taxonomy mapping: ${error.message}`);
    return { ...rowToMapping(data as Record<string, unknown>), canonicalCategoryName: target.categoryName, canonicalSubcategoryName: target.subcategoryName };
  }
}

export function resolveTaxonomyMappingStore(options: { backend?: "local" | "supabase" } = {}): TaxonomyMappingStore {
  if ((options.backend ?? "supabase") === "local") return new LocalTaxonomyMappingStore();
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new StagingBackendError("Supabase taxonomy mapping backend requested but credentials are missing.");
  return new SupabaseTaxonomyMappingStore(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }));
}
