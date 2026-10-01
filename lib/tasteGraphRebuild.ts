// lib/tasteGraphRebuild.ts
//
// Controlled server/service-side rebuild path for the Taste Graph (PR #34).
//
// Orchestrates the full deterministic rebuild for ONE user:
//   1. read the user's public.user_events history (source of truth)
//   2. resolve trustworthy product context from public.products
//   3. build the deterministic affinity snapshot (lib/tasteGraph.ts)
//   4. upsert public.taste_entities
//   5. replace the user's public.user_taste_affinities with the snapshot
//      (upsert new rows, delete rows for entities no longer present)
//
// Persistence uses snapshot-replacement semantics: applying the same
// snapshot twice converges instead of inflating scores or counts.
//
// This module stays dependency-free: all database access goes through the
// duck-typed TasteGraphStore below, so the real service-role client lives in
// scripts/taste-graph-rebuild.js while tests drive an in-memory fake. The
// mobile client NEVER calls this — derived state is service-side only.

import { buildProductContextMap, buildTasteSnapshot } from "./tasteGraph.ts";
import type {
  TasteAffinityRow,
  TasteEventRow,
  TasteProductContext,
  TasteSnapshot,
} from "./tasteGraph.ts";

// Minimal storage surface the rebuild needs. scripts/taste-graph-rebuild.js
// implements this over the Supabase service-role client; tests implement it
// in memory. Read methods are always allowed; write methods are only invoked
// when the rebuild runs with apply=true (dry-run performs ZERO writes).
export type TasteGraphStore = {
  // All user_events rows for the user (any order — the engine re-sorts
  // deterministically).
  fetchUserEvents(userId: string): Promise<TasteEventRow[]>;
  // Trustworthy context for the referenced product ids. Missing ids simply
  // absent from the result (the engine reports them as unresolved).
  fetchProductContext(productIds: string[]): Promise<TasteProductContext[]>;
  // Upsert by (entity_type, entity_key); must return the persisted rows with
  // their database ids.
  upsertTasteEntities(
    rows: Array<{
      entity_type: string;
      entity_key: string;
      display_name: string | null;
      metadata: Record<string, unknown>;
    }>
  ): Promise<Array<{ id: string; entity_type: string; entity_key: string }>>;
  // Existing affinity rows for the user (taste_entity_id list is enough).
  fetchUserAffinityEntityIds(userId: string): Promise<string[]>;
  // Upsert by (user_id, taste_entity_id) with full snapshot values.
  upsertUserAffinities(
    rows: Array<{
      user_id: string;
      taste_entity_id: string;
      long_term_score: number;
      recent_score: number;
      positive_signal_count: number;
      negative_signal_count: number;
      last_interaction_at: string | null;
    }>
  ): Promise<void>;
  // Delete the user's affinity rows for entities absent from the new
  // snapshot so a rebuild is a true replacement.
  deleteUserAffinitiesNotIn(
    userId: string,
    keepTasteEntityIds: string[]
  ): Promise<number>;
};

export type RebuildOptions = {
  // Reference timestamp for decay math. Required for determinism — the
  // script passes an explicit --as-of or its own "now"; tests always pass a
  // fixed value.
  asOf: string | Date;
  // Default false: compute everything, write NOTHING.
  apply?: boolean;
};

export type RebuildResult = {
  userId: string;
  dryRun: boolean;
  asOf: string;
  snapshot: TasteSnapshot;
  // Number of entity/affinity rows written or deleted (0 for dry-runs).
  entitiesUpserted: number;
  affinitiesUpserted: number;
  affinitiesDeleted: number;
  // Human-readable summary lines for CLI output.
  summary: string[];
};

// Read-only rendering of a computed snapshot for the debug/inspection CLI
// (scripts/taste-graph-inspect.js). Pure string formatting — no I/O.
export function formatSnapshotTable(snapshot: TasteSnapshot): string[] {
  const header =
    "entity_type       | key                                  | long_term | recent | pos | neg | last_interaction";
  const lines = [header, "-".repeat(header.length)];
  for (const affinity of snapshot.affinities) {
    const entity = snapshot.entities.find(
      (e) =>
        e.entity_type === affinity.entity_type &&
        e.entity_key === affinity.entity_key
    );
    const label = entity?.display_name
      ? `${affinity.entity_key} (${entity.display_name})`
      : affinity.entity_key;
    lines.push(
      [
        affinity.entity_type.padEnd(17),
        label.length > 36 ? `${label.slice(0, 33)}...` : label.padEnd(36),
        affinity.long_term_score.toFixed(4).padStart(9),
        affinity.recent_score.toFixed(4).padStart(6),
        String(affinity.positive_signal_count).padStart(3),
        String(affinity.negative_signal_count).padStart(3),
        affinity.last_interaction_at ?? "-",
      ].join(" | ")
    );
  }
  if (snapshot.affinities.length === 0) {
    lines.push("(no taste affinities)");
  }
  return lines;
}

export function buildAffinityRows(
  snapshot: TasteSnapshot,
  entityIdsByKey: Map<string, string>
): Array<{
  taste_entity_id: string;
  row: Omit<TasteAffinityRow, "entity_type" | "entity_key">;
}> {
  const rows: Array<{
    taste_entity_id: string;
    row: Omit<TasteAffinityRow, "entity_type" | "entity_key">;
  }> = [];
  for (const affinity of snapshot.affinities) {
    const id = entityIdsByKey.get(
      `${affinity.entity_type}:${affinity.entity_key}`
    );
    if (!id) continue;
    rows.push({
      taste_entity_id: id,
      row: {
        long_term_score: affinity.long_term_score,
        recent_score: affinity.recent_score,
        positive_signal_count: affinity.positive_signal_count,
        negative_signal_count: affinity.negative_signal_count,
        last_interaction_at: affinity.last_interaction_at,
      },
    });
  }
  return rows;
}

export async function rebuildUserTasteGraph(
  store: TasteGraphStore,
  userId: string,
  options: RebuildOptions
): Promise<RebuildResult> {
  if (!userId || typeof userId !== "string") {
    throw new Error("rebuildUserTasteGraph requires a userId");
  }
  const apply = options.apply === true;
  const asOf = new Date(options.asOf);
  if (!Number.isFinite(asOf.getTime())) {
    throw new Error("rebuildUserTasteGraph requires a valid asOf timestamp");
  }

  const events = await store.fetchUserEvents(userId);
  const productIds = [
    ...new Set(
      events
        .map((event) => event.product_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    ),
  ].sort();
  const productRows =
    productIds.length > 0 ? await store.fetchProductContext(productIds) : [];

  const snapshot = buildTasteSnapshot(events, {
    asOf,
    productContext: buildProductContextMap(productRows),
  });

  let entitiesUpserted = 0;
  let affinitiesUpserted = 0;
  let affinitiesDeleted = 0;

  if (apply) {
    const persistedEntities = await store.upsertTasteEntities(
      snapshot.entities.map((entity) => ({
        entity_type: entity.entity_type,
        entity_key: entity.entity_key,
        display_name: entity.display_name,
        metadata: { source: "taste_graph_rebuild", version: snapshot.version },
      }))
    );
    entitiesUpserted = persistedEntities.length;

    const entityIdsByKey = new Map<string, string>();
    for (const entity of persistedEntities) {
      entityIdsByKey.set(`${entity.entity_type}:${entity.entity_key}`, entity.id);
    }

    const affinityRows = buildAffinityRows(snapshot, entityIdsByKey).map(
      ({ taste_entity_id, row }) => ({
        user_id: userId,
        taste_entity_id,
        ...row,
      })
    );
    if (affinityRows.length > 0) {
      await store.upsertUserAffinities(affinityRows);
    }
    affinitiesUpserted = affinityRows.length;

    affinitiesDeleted = await store.deleteUserAffinitiesNotIn(
      userId,
      affinityRows.map((row) => row.taste_entity_id)
    );
  }

  const summary = [
    `user: ${userId}`,
    `mode: ${apply ? "apply" : "dry-run (no writes)"}`,
    `as of: ${snapshot.asOf}`,
    `signal version: ${snapshot.version}`,
    `events processed: ${snapshot.stats.eventsProcessed}`,
    `taste events: ${snapshot.stats.tasteEvents}`,
    `skipped non-taste events: ${snapshot.stats.skippedNonTasteEvents}`,
    `malformed events: ${snapshot.stats.malformedEvents}`,
    `orphan reversals (no prior toggle): ${snapshot.stats.orphanReversals}`,
    `unresolved products: ${snapshot.stats.unresolvedProducts.length}`,
    `entities produced: ${snapshot.entities.length}`,
    `affinities produced: ${snapshot.affinities.length}`,
    `entities upserted: ${entitiesUpserted}`,
    `affinities upserted: ${affinitiesUpserted}`,
    `stale affinities deleted: ${affinitiesDeleted}`,
  ];

  return {
    userId,
    dryRun: !apply,
    asOf: snapshot.asOf,
    snapshot,
    entitiesUpserted,
    affinitiesUpserted,
    affinitiesDeleted,
    summary,
  };
}
