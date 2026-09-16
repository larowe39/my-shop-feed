// lib/catalogStagingTypes.ts
//
// Shared types for the acquisition/staging/review/promotion pipeline. Kept in
// their own module (no logic) so lib/catalogAcquisition.ts, lib/stagingStore.ts
// and lib/catalogPromotion.ts can all import them without circular deps.

export type CandidateClassification =
  | "EXACT_EXISTING"
  | "LIKELY_EXISTING"
  | "POSSIBLE_EXISTING"
  | "NEW"
  | "CONFLICT"
  | "INVALID";

export type ReviewStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "needs_review"
  | "duplicate"
  | "invalid"
  | "promoted";

export type SourceRegistryEntry = {
  id?: string;
  name: string;
  type: string;
  baseUrl?: string | null;
  trustClassification?: string;
  active?: boolean;
  notes?: string | null;
  metadata?: Record<string, unknown>;
};

export type CatalogCandidateInput = {
  sourceExternalId?: string | null;
  sourceId?: string | null;
  brand: string;
  productName: string;
  modelNumber?: string | null;
  family?: string | null;
  category?: string | null;
  subcategory?: string | null;
  aliases?: string[];
  sourceUrl?: string | null;
  sourceType?: string | null;
  // Strong identifiers, optional and provider-agnostic. A retailer SKU
  // (sourceSku) is source-specific provenance, never a universal product
  // identity -- it must never be written into upc/gtin/mpn.
  upc?: string | null;
  gtin?: string | null;
  mpn?: string | null;
  sourceSku?: string | null;
  raw: Record<string, unknown>;
};

export type CanonicalCatalogEntry = {
  brand: string;
  productName: string;
  modelNumber?: string | null;
  family?: string | null;
  category?: string | null;
  subcategory?: string | null;
  aliases?: string[];
  upc?: string | null;
  gtin?: string | null;
  mpn?: string | null;
};

export type StagedCatalogCandidate = {
  id: string;
  sourceId?: string | null;
  sourceExternalId?: string | null;
  fingerprint: string;
  status: ReviewStatus;
  classification: CandidateClassification;
  brand: string;
  productName: string;
  modelNumber?: string | null;
  family?: string | null;
  category?: string | null;
  subcategory?: string | null;
  aliases: string[];
  sourceUrl?: string | null;
  sourceType?: string | null;
  upc?: string | null;
  gtin?: string | null;
  mpn?: string | null;
  sourceSku?: string | null;
  rawPayload: Record<string, unknown>;
  normalizedBrand?: string;
  normalizedName?: string;
  normalizedModel?: string;
  confidence: number;
  duplicateOfCatalogProductId?: string | null;
  promotedCatalogProductId?: string | null;
  promotedAt?: string | null;
  reviewNotes?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AcquisitionSummary = {
  processed: number;
  valid: number;
  invalid: number;
  exactExisting: number;
  likelyExisting: number;
  possibleExisting: number;
  new: number;
  conflict: number;
  staged: number;
  errors: number;
};

export type ImportRunRecord = {
  id: string;
  sourceId?: string | null;
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
  status: string;
  summary: Record<string, unknown>;
  createdAt: string;
};

// Batch/page sizes used by the Supabase-backed staging store. Documented here
// (not buried in an implementation file) because the PR requires the actual
// numbers to be reported, not just described.
export const SUPABASE_STAGING_READ_PAGE_SIZE = 500;
export const SUPABASE_STAGING_WRITE_BATCH_SIZE = 200;
export const SUPABASE_STAGING_ALIAS_BATCH_SIZE = 500;
