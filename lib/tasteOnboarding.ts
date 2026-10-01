// lib/tasteOnboarding.ts
//
// Pure, dependency-free core of PENCHANT's Taste Onboarding (PR #35).
//
// Everything here is deterministic and testable offline via native TS
// type-stripping (same convention as lib/tasteSignals.ts /
// lib/tasteGraph.ts): no supabase, no react-native, no Date.now().
//
// Responsibilities:
//   - onboarding versioning + minimums (single source of truth)
//   - rollout-safe eligibility status resolution (grandfathering)
//   - the centralized navigation gate decision
//   - curated category validation/normalization
//   - deterministic, diverse product candidate selection
//   - client-side completion validation (mirrors the
//     complete_taste_onboarding RPC's server-side checks)
//   - pure event-delta computation mirroring the RPC's idempotency
//     semantics, so retry/dedup behavior is testable offline
//
// Onboarding selections are EXPLICIT preferences. They never fake ordinary
// behavioral events (product_like, product_save, product_open, dwell, ...).

import { CATEGORIES, matchProductCategory } from "../constants/categories.ts";
import type { CategoryItem } from "../constants/categories.ts";
import { isDiscoveryCategoryVisible } from "./discoveryTaxonomy.ts";

// ---------------------------------------------------------------------------
// Versioning + thresholds
// ---------------------------------------------------------------------------

// Current onboarding flow version. Written to
// user_profiles.taste_onboarding_version when the client CREATES a brand-new
// profile (existing profiles keep NULL = grandfathered), and recorded on the
// user_taste_onboarding row + emitted events. Mirrors v_version inside the
// complete_taste_onboarding RPC — keep them in sync.
export const ONBOARDING_VERSION = 1;

// Stage 1: at least this many curated categories before Continue.
export const ONBOARDING_MIN_CATEGORY_SELECTIONS = 3;

// Stage 2: at least this many real products before completion. Documented
// cold-start minimum: enough explicit signal to seed multiple category
// affinities without turning onboarding into a questionnaire.
export const ONBOARDING_MIN_PRODUCT_SELECTIONS = 5;

// How many real product candidates stage 2 offers.
export const ONBOARDING_PRODUCT_CANDIDATE_COUNT = 24;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

// ---------------------------------------------------------------------------
// Curated categories
// ---------------------------------------------------------------------------

// The onboarding category picker shows ONLY the curated discovery categories
// that pass the existing visibility rules — never internal canonical
// taxonomy nodes.
export function getOnboardingCategories(): CategoryItem[] {
  return CATEGORIES.filter((c) => isDiscoveryCategoryVisible(c.id));
}

export function isValidOnboardingCategoryId(id: unknown): id is string {
  return typeof id === "string" && isDiscoveryCategoryVisible(id);
}

// Normalize a raw selection list to the canonical stored form: curated ids
// only, trimmed/lowercased, de-duplicated, sorted. Stable for the same input
// semantics so state rows and events never disagree over formatting.
export function normalizeOnboardingCategoryIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const id = raw.trim().toLowerCase();
    if (!id || !isDiscoveryCategoryVisible(id)) continue;
    out.add(id);
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// Eligibility + centralized gate
// ---------------------------------------------------------------------------

export type OnboardingProfileLike = {
  taste_onboarding_version?: number | null;
} | null;

export type OnboardingStateLike = {
  status?: string | null;
  selected_categories?: unknown;
  selected_product_ids?: unknown;
} | null;

export type OnboardingStatus =
  // No authenticated user.
  | "signed_out"
  // Profile/state fetch not settled yet.
  | "loading"
  // Existing historical account: profile predates the eligibility marker
  // (taste_onboarding_version IS NULL). Never forced through onboarding.
  | "grandfathered"
  // Eligible (marker set) and not completed: must go through onboarding.
  // Covers both "no state row yet" and "state row in_progress" (resume).
  | "required"
  // Onboarding completed.
  | "completed";

// Deterministic eligibility/status rule:
//   signed out                      -> signed_out
//   profile or state still fetching -> loading
//   profile marker NULL             -> grandfathered
//   state row status 'completed'    -> completed
//   otherwise (eligible)            -> required
//
// `undefined` means "not fetched yet" (loading); `null` means "fetched, no
// row". A missing STATE row for an eligible profile means onboarding has not
// started -> required. Callers must never pass a definitively-missing
// PROFILE as null: the context retries profile creation first and then falls
// back to a synthetic eligible marker, so a brand-new account is never
// permanently grandfathered by a fetch race (see
// hooks/TasteOnboardingContext.tsx).
export function resolveOnboardingStatus(args: {
  userId: string | null;
  profile: OnboardingProfileLike | undefined;
  state: OnboardingStateLike | undefined;
}): OnboardingStatus {
  if (!args.userId) return "signed_out";
  if (args.profile === undefined || args.state === undefined) return "loading";
  const marker = args.profile?.taste_onboarding_version;
  if (typeof marker !== "number" || !Number.isFinite(marker)) {
    return "grandfathered";
  }
  if (args.state?.status === "completed") return "completed";
  return "required";
}

export type OnboardingGateDecision =
  // Show a blocking loading veil (no flash of the normal app).
  | "loading"
  // Redirect to the onboarding route.
  | "to_onboarding"
  // Redirect away from onboarding into the normal app.
  | "to_app"
  // Current location is allowed; do nothing.
  | "none";

// The ONE centralized routing decision, evaluated near the root navigation
// boundary (app/_layout.tsx). Pure so redirect-loop safety is testable.
export function resolveOnboardingGate(args: {
  authLoading: boolean;
  status: OnboardingStatus;
  inOnboarding: boolean;
}): OnboardingGateDecision {
  if (args.authLoading) return "loading";
  if (args.status === "loading") return "loading";
  if (args.status === "signed_out") {
    // Signed-out browsing stays exactly as before; onboarding is an
    // authenticated-only route.
    return args.inOnboarding ? "to_app" : "none";
  }
  if (args.status === "required") {
    return args.inOnboarding ? "none" : "to_onboarding";
  }
  // completed / grandfathered
  return args.inOnboarding ? "to_app" : "none";
}

// ---------------------------------------------------------------------------
// Deterministic product candidate selection
// ---------------------------------------------------------------------------

// Minimal product shape the selector needs (structural; the app's Product
// type satisfies it).
export type OnboardingCandidateProduct = {
  id: string;
  brand?: string | null;
  category?: string | null;
  image_url?: string | null;
  created_at?: string | null;
  moderation?: { is_hidden?: boolean | null } | null;
};

// Effective product minimum for a sparse catalog. Full minimum is
// ONBOARDING_MIN_PRODUCT_SELECTIONS; when the catalog genuinely offers fewer
// eligible candidates, require everything available (never less than 1 when
// anything exists). 0 available -> 0 (completion impossible; the UI shows an
// empty-catalog state instead of a dead CTA).
export function requiredProductMinimum(availableCount: number): number {
  if (!Number.isFinite(availableCount) || availableCount <= 0) return 0;
  return Math.max(
    1,
    Math.min(ONBOARDING_MIN_PRODUCT_SELECTIONS, Math.floor(availableCount))
  );
}

function normalizeBrandKey(brand: string | null | undefined): string | null {
  const value = (brand ?? "").trim().toLowerCase();
  return value.length > 0 ? value : null;
}

// Stable candidate ordering: newest first, ties broken by id so the same
// dataset always yields the same ordering (created_at ties are common in
// seeded/bulk-imported catalogs).
function compareCandidates(
  a: OnboardingCandidateProduct,
  b: OnboardingCandidateProduct
): number {
  const at = Date.parse(a.created_at ?? "");
  const bt = Date.parse(b.created_at ?? "");
  const ta = Number.isFinite(at) ? at : 0;
  const tb = Number.isFinite(bt) ? bt : 0;
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Pick the deterministic, diverse candidate set for stage 2.
//
// Eligibility: REAL products only (UUID ids — the local demo row "demo-1"
// and any non-UUID id is excluded so a fake product can never be persisted
// as an onboarding selection), hidden-moderation excluded, usable image
// required (visual-first grid; imageless products are skipped).
//
// Matching uses the existing curated category semantics
// (matchProductCategory) against the selected category ids.
//
// Diversity: matching products are bucketed by their FIRST matching selected
// category (each product enters exactly one bucket), buckets are sorted
// deterministically, then candidates are interleaved round-robin so one
// category cannot fill the screen while alternatives exist. Within each
// round-robin visit, a product whose brand differs from the previously
// picked brand is preferred when the bucket offers one (brand diversity
// where practical).
//
// Sparse fallback: if matching yields fewer than `count`, the remainder is
// filled from eligible products in OTHER categories (same stable ordering).
// If still short, whatever exists is returned — never fabricated.
export function selectOnboardingCandidates<T extends OnboardingCandidateProduct>(args: {
  products: readonly T[];
  selectedCategoryIds: readonly string[];
  count?: number;
}): T[] {
  const count = args.count ?? ONBOARDING_PRODUCT_CANDIDATE_COUNT;
  const selected = normalizeOnboardingCategoryIds([...args.selectedCategoryIds]);

  const seenIds = new Set<string>();
  const eligible: T[] = [];
  for (const product of args.products ?? []) {
    if (!product || typeof product.id !== "string") continue;
    const id = product.id.trim();
    if (!isUuid(id)) continue; // real DB products only
    const idKey = id.toLowerCase();
    if (seenIds.has(idKey)) continue; // eliminate duplicate rows
    seenIds.add(idKey);
    if (product.moderation?.is_hidden) continue; // hidden never appears
    if (!(product.image_url ?? "").trim()) continue; // usable image required
    eligible.push(product);
  }

  const buckets = new Map<string, T[]>();
  for (const categoryId of selected) buckets.set(categoryId, []);
  const matchedIds = new Set<string>();
  for (const product of eligible) {
    for (const categoryId of selected) {
      if (matchProductCategory(product.category, categoryId)) {
        buckets.get(categoryId)!.push(product);
        matchedIds.add(product.id);
        break;
      }
    }
  }
  for (const bucket of buckets.values()) bucket.sort(compareCandidates);

  const picked: T[] = [];
  let lastBrand: string | null = null;

  for (;;) {
    let progressed = false;
    for (const categoryId of selected) {
      if (picked.length >= count) break;
      const bucket = buckets.get(categoryId)!;
      if (bucket.length === 0) continue;
      let index = 0;
      if (lastBrand !== null) {
        const alternative = bucket.findIndex((p) => {
          const brand = normalizeBrandKey(p.brand);
          return brand !== null && brand !== lastBrand;
        });
        if (alternative > 0) index = alternative;
      }
      const [product] = bucket.splice(index, 1);
      picked.push(product);
      lastBrand = normalizeBrandKey(product.brand) ?? lastBrand;
      progressed = true;
    }
    if (!progressed || picked.length >= count) break;
  }

  if (picked.length < count) {
    const remainder = eligible
      .filter((p) => !matchedIds.has(p.id))
      .sort(compareCandidates);
    for (const product of remainder) {
      if (picked.length >= count) break;
      picked.push(product);
    }
  }

  return picked;
}

// ---------------------------------------------------------------------------
// Completion validation (client-side mirror of the RPC's server checks)
// ---------------------------------------------------------------------------

export type OnboardingCompletionValidation =
  | { ok: true; categories: string[]; productIds: string[] }
  | { ok: false; error: string };

// Validate the final onboarding payload before it is submitted. Mirrors the
// complete_taste_onboarding RPC: curated categories only, >=
// ONBOARDING_MIN_CATEGORY_SELECTIONS; real UUID product ids only (fake/demo
// ids are dropped, then the minimum is enforced), >= the effective minimum
// for the available candidate pool. The server re-validates everything, so
// this client check exists purely for fast UX feedback.
export function validateOnboardingCompletion(args: {
  categoryIds: unknown;
  productIds: unknown;
  availableProductCount: number;
}): OnboardingCompletionValidation {
  const categories = normalizeOnboardingCategoryIds(args.categoryIds);
  if (categories.length < ONBOARDING_MIN_CATEGORY_SELECTIONS) {
    return {
      ok: false,
      error: `Select at least ${ONBOARDING_MIN_CATEGORY_SELECTIONS} categories.`,
    };
  }

  const productIds = new Set<string>();
  if (Array.isArray(args.productIds)) {
    for (const raw of args.productIds) {
      if (!isUuid(raw)) continue; // fake/demo/non-UUID ids are never persisted
      productIds.add(raw.trim().toLowerCase());
    }
  }
  const minimum = requiredProductMinimum(args.availableProductCount);
  if (productIds.size < minimum) {
    return {
      ok: false,
      error: `Pick at least ${minimum} ${minimum === 1 ? "product" : "products"}.`,
    };
  }

  return { ok: true, categories, productIds: [...productIds].sort() };
}

// ---------------------------------------------------------------------------
// Event-delta mirror (offline-testable RPC idempotency semantics)
// ---------------------------------------------------------------------------

export type OnboardingEventWrite = {
  event_type:
    | "onboarding_category_select"
    | "onboarding_category_deselect"
    | "onboarding_product_select"
    | "onboarding_product_deselect"
    | "onboarding_complete";
  category?: string;
  product_id?: string;
};

// Compute the exact user_events writes for a completion, given the
// PREVIOUSLY COMMITTED selections. This mirrors what the
// complete_taste_onboarding RPC does in SQL: the RPC is the only writer of
// onboarding events, and it updates the state row in the same transaction,
// so "events emitted so far" always equals "last completed row's
// selections". Consequences, all verified in scripts/test-taste-onboarding.js:
//   - retrying the same completion inserts nothing (idempotent),
//   - a changed selection emits select for added / deselect for removed,
//   - a first completion has an empty delta base (no orphan deselects),
//   - onboarding_complete fires exactly once (first completion only).
export function computeOnboardingEventDelta(args: {
  previouslyCommitted: { categories: string[]; productIds: string[] } | null;
  finalCategories: readonly string[];
  finalProductIds: readonly string[];
}): OnboardingEventWrite[] {
  const prevCategories = new Set(
    (args.previouslyCommitted?.categories ?? []).map((c) => c.trim().toLowerCase())
  );
  const prevProducts = new Set(
    (args.previouslyCommitted?.productIds ?? []).map((p) => p.trim().toLowerCase())
  );
  const nextCategories = new Set(args.finalCategories.map((c) => c.trim().toLowerCase()));
  const nextProducts = new Set(args.finalProductIds.map((p) => p.trim().toLowerCase()));

  const writes: OnboardingEventWrite[] = [];
  for (const category of [...nextCategories].sort()) {
    if (!prevCategories.has(category)) {
      writes.push({ event_type: "onboarding_category_select", category });
    }
  }
  for (const category of [...prevCategories].sort()) {
    if (!nextCategories.has(category)) {
      writes.push({ event_type: "onboarding_category_deselect", category });
    }
  }
  for (const productId of [...nextProducts].sort()) {
    if (!prevProducts.has(productId)) {
      writes.push({ event_type: "onboarding_product_select", product_id: productId });
    }
  }
  for (const productId of [...prevProducts].sort()) {
    if (!nextProducts.has(productId)) {
      writes.push({ event_type: "onboarding_product_deselect", product_id: productId });
    }
  }
  if (!args.previouslyCommitted) {
    writes.push({ event_type: "onboarding_complete" });
  }
  return writes;
}
