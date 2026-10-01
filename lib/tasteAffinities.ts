// lib/tasteAffinities.ts
//
// Client-side consumption of the persisted Taste Graph (PR #36 — FOR YOU V2).
//
// Reads the DERIVED, service-side-materialized affinity state produced by the
// PR #34 rebuild path (public.user_taste_affinities + public.taste_entities)
// and resolves it into an O(1) in-memory lookup for the pure FOR YOU V2
// ranker (lib/forYouV2.ts).
//
// Query pattern (exactly TWO batched queries per load, never N+1):
//
//   Query 1: user_taste_affinities for the current user
//            (RLS: authenticated users read ONLY their own rows).
//   Query 2: taste_entities for ALL referenced taste_entity_id values in ONE
//            batched .in("id", ids) query (RLS: authenticated read-only).
//
// This module is the ONLY place that should read the taste tables from the
// client. It performs ZERO writes: no client write policies exist on either
// table, and none are needed here.
//
// Failure contract: loading is BEST EFFORT. Any error (network, RLS,
// malformed rows) resolves to null so callers fall back to the V1 ranking
// path — a Taste Graph failure must never break the feed.
//
// The pure lookup builder (buildTasteAffinityLookup) is dependency-free so
// offline tests import it directly via native TS type-stripping, exactly
// like lib/tasteGraph.ts / lib/tasteOnboarding.ts. All database access goes
// through the duck-typed TasteAffinityStore below: the real Supabase client
// wiring lives in hooks/ProductsContext.tsx while tests drive fakes.

import { normalizeEntityKey } from "./tasteSignals.ts";
import type { TasteEntityType } from "./tasteSignals.ts";

// One resolved affinity entry, keyed by normalized "entity_type:entity_key".
export type TasteAffinityEntry = {
  entityType: TasteEntityType;
  entityKey: string;
  recentScore: number;
  longTermScore: number;
  positiveSignalCount: number;
  negativeSignalCount: number;
  lastInteractionAt: string | null;
  // Row's persisted updated_at: freshness METADATA for the snapshot (the
  // ranker never applies a freshness cutoff — see docs/for-you-v2.md).
  updatedAt: string | null;
};

// O(1) rank-time lookup: `${entity_type}:${normalized entity_key}` -> entry.
export type TasteAffinityLookup = Map<string, TasteAffinityEntry>;

// Raw public.user_taste_affinities row (the columns the client reads).
export type TasteAffinityRow = {
  taste_entity_id: string;
  recent_score: number;
  long_term_score: number;
  positive_signal_count: number;
  negative_signal_count: number;
  last_interaction_at: string | null;
  updated_at: string | null;
};

// Raw public.taste_entities row (the columns the client reads).
export type TasteEntityRow = {
  id: string;
  entity_type: string;
  entity_key: string;
  display_name?: string | null;
};

// Minimal storage surface for one load. hooks/ProductsContext.tsx implements
// this over the real Supabase client with exactly two batched queries; tests
// implement it in memory. Batched-fetch-by-ids is part of the interface, so
// per-row (N+1) entity queries are structurally impossible.
export type TasteAffinityStore = {
  // All user_taste_affinities rows for the user (own rows only under RLS).
  fetchUserAffinities(userId: string): Promise<TasteAffinityRow[]>;
  // All taste_entities rows for the given ids, fetched in ONE batched query.
  fetchTasteEntities(ids: string[]): Promise<TasteEntityRow[]>;
};

export type TasteAffinitySnapshot = {
  lookup: TasteAffinityLookup;
  // Number of resolved affinity entries (0 is a valid, fallback-worthy load).
  rowCount: number;
  // Latest persisted updated_at across the loaded rows (freshness metadata
  // only; ranking is intentionally stale-tolerant and never gated on this).
  latestUpdatedAt: string | null;
};

// Canonical lookup key used by both the loader and the ranker.
export function affinityLookupKey(entityType: string, entityKey: string): string {
  return `${entityType}:${entityKey}`;
}

function finiteOrZero(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function nonNegativeIntOrZero(value: unknown): number {
  const n = Math.trunc(finiteOrZero(value));
  return n >= 0 ? n : 0;
}

// Resolve raw rows into the O(1) rank-time lookup. Pure and defensive:
//   - entity keys are re-normalized with the SAME normalizeEntityKey the
//     rebuild path used, so client lookups match persisted identity exactly;
//   - rows referencing a missing/duplicate entity row are skipped safely;
//   - non-finite scores coerce to 0 rather than poisoning ranking math;
//   - duplicate resolutions keep the first row (deterministic).
export function buildTasteAffinityLookup(
  affinityRows: readonly TasteAffinityRow[],
  entityRows: readonly TasteEntityRow[]
): TasteAffinityLookup {
  const keyByEntityId = new Map<
    string,
    { entityType: TasteEntityType; entityKey: string; lookupKey: string }
  >();

  for (const entity of entityRows ?? []) {
    if (!entity || typeof entity.id !== "string" || entity.id.length === 0) {
      continue;
    }
    if (typeof entity.entity_type !== "string" || entity.entity_type.length === 0) {
      continue;
    }
    if (keyByEntityId.has(entity.id)) continue; // duplicate id row: first wins
    const entityKey = normalizeEntityKey(
      entity.entity_type as TasteEntityType,
      entity.entity_key
    );
    if (!entityKey) continue; // blank/un-normalizable key: skip safely
    keyByEntityId.set(entity.id, {
      entityType: entity.entity_type as TasteEntityType,
      entityKey,
      lookupKey: affinityLookupKey(entity.entity_type, entityKey),
    });
  }

  const lookup: TasteAffinityLookup = new Map();
  for (const row of affinityRows ?? []) {
    if (!row || typeof row.taste_entity_id !== "string") continue;
    const resolved = keyByEntityId.get(row.taste_entity_id);
    if (!resolved) continue; // entity row absent from the batch: skip safely
    if (lookup.has(resolved.lookupKey)) continue; // duplicate resolution: first wins
    lookup.set(resolved.lookupKey, {
      entityType: resolved.entityType,
      entityKey: resolved.entityKey,
      recentScore: finiteOrZero(row.recent_score),
      longTermScore: finiteOrZero(row.long_term_score),
      positiveSignalCount: nonNegativeIntOrZero(row.positive_signal_count),
      negativeSignalCount: nonNegativeIntOrZero(row.negative_signal_count),
      lastInteractionAt:
        typeof row.last_interaction_at === "string" ? row.last_interaction_at : null,
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
    });
  }
  return lookup;
}

// One full best-effort load: affinities -> ONE batched entity fetch ->
// resolved lookup + freshness metadata. Returns null on ANY failure (the
// caller then falls back to V1 ranking) and a valid empty snapshot when the
// user simply has no persisted affinities yet.
export async function loadTasteAffinities(
  store: TasteAffinityStore,
  userId: string
): Promise<TasteAffinitySnapshot | null> {
  if (!userId || typeof userId !== "string") return null;
  try {
    const rows = (await store.fetchUserAffinities(userId)) ?? [];
    const entityIds = [
      ...new Set(
        rows
          .map((row) => row?.taste_entity_id)
          .filter((id): id is string => typeof id === "string" && id.length > 0)
      ),
    ].sort();
    const entities =
      entityIds.length > 0 ? ((await store.fetchTasteEntities(entityIds)) ?? []) : [];

    const lookup = buildTasteAffinityLookup(rows, entities);

    let latestUpdatedAt: string | null = null;
    for (const row of rows) {
      if (
        typeof row?.updated_at === "string" &&
        (latestUpdatedAt === null || row.updated_at > latestUpdatedAt)
      ) {
        latestUpdatedAt = row.updated_at;
      }
    }

    return { lookup, rowCount: lookup.size, latestUpdatedAt };
  } catch (err) {
    // Best effort: a Taste Graph failure must never break the feed.
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.log("[taste] failed to load taste affinities", err);
    }
    return null;
  }
}
