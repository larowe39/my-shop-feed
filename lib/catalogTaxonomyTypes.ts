import type { ExternalTaxonomyIdentity } from "./catalogStagingTypes.ts";

export type TaxonomyMappingStatus = "unmapped" | "suggested" | "verified" | "rejected";
export type TaxonomyMappingMethod = "manual" | "exact_deterministic" | "verified_reuse" | "automated_suggestion";

export type TaxonomyMappingRecord = {
  id: string;
  provider: string;
  externalTaxonomyId: string;
  externalName: string | null;
  externalPath: string | null;
  externalParentId: string | null;
  externalParentPath: string | null;
  canonicalCategoryId: string | null;
  canonicalCategoryName: string | null;
  canonicalSubcategoryId: string | null;
  canonicalSubcategoryName: string | null;
  status: TaxonomyMappingStatus;
  method: TaxonomyMappingMethod;
  confidence: number | null;
  evidence: Record<string, unknown>;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaxonomyMappingInput = {
  identity: ExternalTaxonomyIdentity;
  canonicalCategoryId?: string | null;
  canonicalCategoryName?: string | null;
  canonicalSubcategoryId?: string | null;
  canonicalSubcategoryName?: string | null;
  status: TaxonomyMappingStatus;
  method: TaxonomyMappingMethod;
  confidence?: number | null;
  evidence?: Record<string, unknown>;
  reviewedBy?: string | null;
};

export function mappingIsTrusted(mapping: TaxonomyMappingRecord | null | undefined): boolean {
  return mapping?.status === "verified" && Boolean(mapping.canonicalSubcategoryId || mapping.canonicalCategoryId);
}

export function mappingKey(identity: ExternalTaxonomyIdentity): string {
  return `${identity.provider.trim().toLowerCase()}::${identity.externalId.trim()}`;
}