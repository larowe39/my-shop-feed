// lib/catalogPromotion.ts
//
// Canonical promotion: staging -> canonical catalog. This is the ONLY code
// path allowed to write to public.catalog_products / public.catalog_aliases
// from the acquisition pipeline, and it only ever does so for staged
// candidates whose status is exactly "approved" at promotion time.
//
// Real (production) promotion calls a single Postgres RPC
// (public.promote_catalog_staged_product, defined in
// supabase/migrations/20260915_add_catalog_acquisition_staging.sql) so the
// canonical insert + alias inserts + staged-row status transition all happen
// in one atomic transaction: either everything commits, or nothing does.
//
// A LocalCanonicalPromotionStore mock is provided ONLY for tests/dev so the
// promotion algorithm (resolution, duplicate/conflict recheck, eligibility
// rules, atomicity semantics) can be exercised without touching real
// production data. Production callers must use SupabaseCanonicalPromotionStore.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { normalizeAcquisitionText } from "./catalogAcquisition.ts";
import type { StagedCatalogCandidate } from "./catalogStagingTypes.ts";
import { StagingBackendError } from "./stagingStore.ts";

export type CanonicalBackendKind = "local" | "supabase";

export type CanonicalResolution = {
  brandId: string;
  brandSlug: string;
  subcategoryId: string | null;
  familyId: string | null;
  slug: string;
};

export type PromotionEligibility =
  | { eligible: true; resolution: CanonicalResolution }
  | { eligible: false; reason: string };

export type PromotionOutcome = {
  ok: boolean;
  canonicalProductId?: string;
  message: string;
};

export interface CanonicalPromotionStore {
  readonly kind: CanonicalBackendKind;
  /** Resolve brand/subcategory/family identity and recheck duplicates/conflicts. Read-only, zero writes. */
  checkEligibility(candidate: StagedCatalogCandidate): Promise<PromotionEligibility>;
  /** Perform the actual canonical write. Only called when apply=true and eligibility passed immediately beforehand. */
  promote(candidate: StagedCatalogCandidate, resolution: CanonicalResolution): Promise<PromotionOutcome>;
}

function slugify(value: string): string {
  return normalizeAcquisitionText(value).replace(/\s+/g, "-");
}

function buildCandidateSlug(candidate: StagedCatalogCandidate, brandSlug: string): string {
  const nameSlug = slugify(candidate.normalizedName ?? candidate.productName);
  const modelSlug = candidate.normalizedModel ? slugify(candidate.normalizedModel) : "";
  return [brandSlug, nameSlug, modelSlug].filter(Boolean).join("-");
}

// ---------------------------------------------------------------------------
// PRODUCTION (Supabase) canonical promotion
// ---------------------------------------------------------------------------

export class SupabaseCanonicalPromotionStore implements CanonicalPromotionStore {
  readonly kind: CanonicalBackendKind = "supabase";
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async checkEligibility(candidate: StagedCatalogCandidate): Promise<PromotionEligibility> {
    const normalizedBrand = candidate.normalizedBrand ?? normalizeAcquisitionText(candidate.brand);
    if (!normalizedBrand) return { eligible: false, reason: "Candidate has no resolvable brand." };

    const { data: brandRows, error: brandError } = await this.client
      .from("catalog_brands")
      .select("id, slug, name")
      .or(`slug.eq.${slugify(normalizedBrand)},name.ilike.${normalizedBrand}`)
      .limit(5);
    if (brandError) throw new StagingBackendError(`Brand lookup failed: ${brandError.message}`);
    const brand = (brandRows ?? [])[0];
    if (!brand) {
      return {
        eligible: false,
        reason: `Brand "${candidate.brand}" does not exist in the canonical catalog_brands table. Human review required before a new brand can be created.`,
      };
    }

    let subcategoryId: string | null = null;
    if (candidate.subcategory) {
      const normalizedSubcategory = normalizeAcquisitionText(candidate.subcategory);
      const { data: subcategoryRows, error: subcategoryError } = await this.client
        .from("catalog_subcategories")
        .select("id, slug, name")
        .or(`slug.eq.${slugify(normalizedSubcategory)},name.ilike.${normalizedSubcategory}`)
        .limit(5);
      if (subcategoryError) throw new StagingBackendError(`Subcategory lookup failed: ${subcategoryError.message}`);
      const subcategory = (subcategoryRows ?? [])[0];
      if (!subcategory) {
        return {
          eligible: false,
          reason: `Proposed subcategory "${candidate.subcategory}" is ambiguous/unresolved in the canonical taxonomy. Human review required.`,
        };
      }
      subcategoryId = subcategory.id;
    }

    let familyId: string | null = null;
    if (candidate.family) {
      const familySlug = slugify(candidate.family);
      const { data: familyRows, error: familyError } = await this.client
        .from("catalog_product_families")
        .select("id, slug, brand_id")
        .eq("brand_id", brand.id)
        .eq("slug", familySlug)
        .limit(1);
      if (familyError) throw new StagingBackendError(`Family lookup failed: ${familyError.message}`);
      const family = (familyRows ?? [])[0];
      if (!family) {
        return {
          eligible: false,
          reason: `Proposed family "${candidate.family}" for brand "${brand.name}" does not exist in the canonical catalog. Human review required.`,
        };
      }
      familyId = family.id;
    }

    const slug = buildCandidateSlug(candidate, brand.slug);
    const modelNumber = candidate.normalizedModel ?? candidate.modelNumber ?? null;

    const orClauses = [`slug.eq.${slug}`];
    if (modelNumber) orClauses.push(`and(brand_id.eq.${brand.id},model_number.eq.${modelNumber})`);
    const { data: duplicateRows, error: duplicateError } = await this.client
      .from("catalog_products")
      .select("id, slug, model_number")
      .or(orClauses.join(","))
      .limit(1);
    if (duplicateError) throw new StagingBackendError(`Duplicate recheck failed: ${duplicateError.message}`);
    if ((duplicateRows ?? []).length > 0) {
      return {
        eligible: false,
        reason: `A canonical product already exists (id=${duplicateRows![0].id}) matching slug/model-number. Skipping to avoid a duplicate write.`,
      };
    }

    return { eligible: true, resolution: { brandId: brand.id, brandSlug: brand.slug, subcategoryId, familyId, slug } };
  }

  async promote(candidate: StagedCatalogCandidate, resolution: CanonicalResolution): Promise<PromotionOutcome> {
    const aliases = Array.from(new Set([...(candidate.aliases ?? []), candidate.brand, candidate.productName, candidate.modelNumber ?? ""]))
      .filter(Boolean)
      .map((alias) => ({ alias, normalized_alias: normalizeAcquisitionText(alias) }));

    const { data, error } = await this.client.rpc("promote_catalog_staged_product", {
      p_staged_id: candidate.id,
      p_brand_id: resolution.brandId,
      p_subcategory_id: resolution.subcategoryId,
      p_family_id: resolution.familyId,
      p_slug: resolution.slug,
      p_name: candidate.productName,
      p_model_number: candidate.modelNumber ?? null,
      p_description: null,
      p_attributes: {},
      p_aliases: aliases,
    });
    if (error) {
      return { ok: false, message: `Canonical promotion failed atomically for ${candidate.id}: ${error.message}. Staging status unchanged.` };
    }
    const canonicalProductId = Array.isArray(data) ? data[0]?.catalog_product_id : (data as { catalog_product_id?: string } | null)?.catalog_product_id;
    if (!canonicalProductId) {
      return { ok: false, message: `Canonical promotion RPC for ${candidate.id} returned no product id. Staging status unchanged.` };
    }
    return { ok: true, canonicalProductId, message: `Promoted ${candidate.id} -> catalog_products.${canonicalProductId} (atomic RPC).` };
  }
}

// ---------------------------------------------------------------------------
// LOCAL/TEST canonical promotion mock — never used against production.
// ---------------------------------------------------------------------------

export type LocalCanonicalCatalog = {
  brands: Array<{ id: string; slug: string; name: string }>;
  subcategories: Array<{ id: string; slug: string; name: string }>;
  families: Array<{ id: string; slug: string; brandId: string }>;
  products: Array<{ id: string; slug: string; brandId: string; modelNumber: string | null }>;
};

export class LocalCanonicalPromotionStore implements CanonicalPromotionStore {
  readonly kind: CanonicalBackendKind = "local";
  private readonly catalog: LocalCanonicalCatalog;

  constructor(catalog: LocalCanonicalCatalog) {
    this.catalog = catalog;
  }

  async checkEligibility(candidate: StagedCatalogCandidate): Promise<PromotionEligibility> {
    const normalizedBrand = candidate.normalizedBrand ?? normalizeAcquisitionText(candidate.brand);
    const brand = this.catalog.brands.find((row) => row.slug === slugify(normalizedBrand) || normalizeAcquisitionText(row.name) === normalizedBrand);
    if (!brand) {
      return { eligible: false, reason: `Brand "${candidate.brand}" does not exist in the canonical catalog. Human review required.` };
    }

    let subcategoryId: string | null = null;
    if (candidate.subcategory) {
      const normalizedSubcategory = normalizeAcquisitionText(candidate.subcategory);
      const subcategory = this.catalog.subcategories.find(
        (row) => row.slug === slugify(normalizedSubcategory) || normalizeAcquisitionText(row.name) === normalizedSubcategory
      );
      if (!subcategory) {
        return { eligible: false, reason: `Proposed subcategory "${candidate.subcategory}" is unresolved. Human review required.` };
      }
      subcategoryId = subcategory.id;
    }

    let familyId: string | null = null;
    if (candidate.family) {
      const familySlug = slugify(candidate.family);
      const family = this.catalog.families.find((row) => row.brandId === brand.id && row.slug === familySlug);
      if (!family) {
        return { eligible: false, reason: `Proposed family "${candidate.family}" is unresolved for brand "${brand.name}". Human review required.` };
      }
      familyId = family.id;
    }

    const slug = buildCandidateSlug(candidate, brand.slug);
    const modelNumber = candidate.normalizedModel ?? candidate.modelNumber ?? null;
    const duplicate = this.catalog.products.find(
      (row) => row.slug === slug || (modelNumber && row.brandId === brand.id && row.modelNumber === modelNumber)
    );
    if (duplicate) {
      return { eligible: false, reason: `A canonical product already exists (id=${duplicate.id}) matching slug/model-number.` };
    }

    return { eligible: true, resolution: { brandId: brand.id, brandSlug: brand.slug, subcategoryId, familyId, slug } };
  }

  async promote(candidate: StagedCatalogCandidate, resolution: CanonicalResolution): Promise<PromotionOutcome> {
    // Simulate the same atomicity contract as the Supabase RPC: either both
    // the canonical row and the status transition happen, or neither does.
    const duplicate = this.catalog.products.find((row) => row.slug === resolution.slug);
    if (duplicate) {
      return { ok: false, message: `Canonical promotion failed for ${candidate.id}: duplicate slug detected at write time. Staging status unchanged.` };
    }
    const canonicalProductId = `local_product_${resolution.slug}`;
    this.catalog.products.push({ id: canonicalProductId, slug: resolution.slug, brandId: resolution.brandId, modelNumber: candidate.modelNumber ?? null });
    return { ok: true, canonicalProductId, message: `Promoted ${candidate.id} -> local mock catalog_products.${canonicalProductId} (atomic mock).` };
  }
}

export type ResolveCanonicalPromotionStoreOptions = {
  backend?: CanonicalBackendKind;
  localCatalog?: LocalCanonicalCatalog;
};

/**
 * Single chokepoint for canonical promotion backend selection. Same fail-closed
 * contract as resolveStagingStore(): defaults to "supabase", never silently
 * falls back to the local mock.
 */
export function resolveCanonicalPromotionStore(options: ResolveCanonicalPromotionStoreOptions = {}): CanonicalPromotionStore {
  const backend = options.backend ?? "supabase";
  if (backend === "local") {
    return new LocalCanonicalPromotionStore(options.localCatalog ?? { brands: [], subcategories: [], families: [], products: [] });
  }
  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new StagingBackendError(
      "Supabase canonical promotion backend requested (or defaulted to) but credentials are missing. " +
        "Set EXPO_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or explicitly pass --backend=local for local/test runs. " +
        "Refusing to silently fall back to the local mock."
    );
  }
  const client = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return new SupabaseCanonicalPromotionStore(client);
}
