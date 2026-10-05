// Server-only orchestration; no client, credentials, or polling loop.
import {
  prepareUserTasteSnapshot,
  persistTasteSnapshotEntities,
} from "./tasteGraphRebuild.ts";
import type { TasteGraphStore } from "./tasteGraphRebuild.ts";

export const MAX_WORKER_BATCH = 5;
export const WORKER_BUDGET_MS = 240_000;
export const REQUEST_TIMEOUT_MS = 15_000;
export const FAILURE_TIMEOUT_MS = 10_000;
export const LEASE_RENEW_MARGIN_MS = 90_000;
export const MAX_REPLAY_EVENTS = 50_000;
export const MAX_SNAPSHOT_ENTITIES = 20_000;

export type ClaimedTasteJob = {
  user_id: string;
  captured_generation: number | string;
  lease_token: string;
  lease_until: string;
};
export type AffinitySnapshotRows = Awaited<
  ReturnType<typeof persistTasteSnapshotEntities>
>["affinityRows"];
export type JobControl = {
  checkpoint(): Promise<void>;
  requestSignal(): AbortSignal;
};
export type TasteWorkerStore = {
  claim(batchSize: number, signal: AbortSignal): Promise<ClaimedTasteJob[]>;
  fetchUserEvents(userId: string, control: JobControl): ReturnType<TasteGraphStore["fetchUserEvents"]>;
  fetchProductContext(ids: string[], control: JobControl): ReturnType<TasteGraphStore["fetchProductContext"]>;
  upsertTasteEntities(rows: Parameters<TasteGraphStore["upsertTasteEntities"]>[0], control: JobControl): ReturnType<TasteGraphStore["upsertTasteEntities"]>;
  renew(job: ClaimedTasteJob, signal: AbortSignal): Promise<string>;
  finalize(job: ClaimedTasteJob, rows: AffinitySnapshotRows, durationMs: number, signal: AbortSignal): Promise<"published" | "stale_generation">;
  fail(job: ClaimedTasteJob, error: string, signal: AbortSignal): Promise<"retry_scheduled" | "blocked" | "stale_generation">;
};
export type TasteJobResult = {
  userId: string;
  generation: number | string;
  status: "published" | "stale_generation" | "retry_scheduled" | "blocked" | "failure_unreported";
  error?: string;
  failureReportError?: string;
  eventsProcessed?: number;
  unresolvedProducts?: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validateWorkerBatch(batchSize: number): number {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_WORKER_BATCH) {
    throw new Error("Taste Graph worker batch size must be an integer from 1 to 5");
  }
  return batchSize;
}

export async function runTasteGraphWorker(
  store: TasteWorkerStore,
  options: { batchSize?: number; now?: () => number } = {}
): Promise<{ claimed: number; jobs: TasteJobResult[] }> {
  const batchSize = validateWorkerBatch(options.batchSize ?? MAX_WORKER_BATCH);
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + WORKER_BUDGET_MS;
  const asOf = new Date(startedAt).toISOString();
  const requestSignal = () => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("Taste Graph worker time budget exceeded");
    return AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining));
  };
  // Exactly one claim per invocation. All leases are serviced concurrently,
  // so later jobs do not wait behind another user's slow full replay.
  const jobs = await store.claim(batchSize, requestSignal());
  if (jobs.length > batchSize) throw new Error("Claim RPC exceeded requested worker batch");

  const results = await Promise.all(jobs.map(async (claimed): Promise<TasteJobResult> => {
    const job = { ...claimed };
    const base = { userId: job.user_id, generation: job.captured_generation };
    const jobStartedAt = now();
    const control: JobControl = {
      requestSignal,
      async checkpoint() {
        if (now() >= deadline) throw new Error("Taste Graph worker time budget exceeded");
        const expiry = Date.parse(job.lease_until);
        if (!Number.isFinite(expiry) || expiry <= now()) {
          throw new Error("Taste Graph worker lease is invalid or expired");
        }
        if (expiry - now() <= LEASE_RENEW_MARGIN_MS) {
          job.lease_until = await store.renew(job, requestSignal());
          if (!Number.isFinite(Date.parse(job.lease_until)) || Date.parse(job.lease_until) <= now()) {
            throw new Error("Lease renewal returned an invalid expiry");
          }
        }
      },
    };
    try {
      await control.checkpoint();
      const snapshot = await prepareUserTasteSnapshot({
        async fetchUserEvents(userId) {
          const events = await store.fetchUserEvents(userId, control);
          if (events.length > MAX_REPLAY_EVENTS) {
            throw new Error(`Full replay exceeds ${MAX_REPLAY_EVENTS} events; no partial snapshot published`);
          }
          await control.checkpoint();
          return events;
        },
        async fetchProductContext(ids) {
          const products = await store.fetchProductContext(ids, control);
          await control.checkpoint();
          return products;
        },
      }, job.user_id, asOf);
      await control.checkpoint();
      if (snapshot.entities.length > MAX_SNAPSHOT_ENTITIES) {
        throw new Error(`Full snapshot exceeds ${MAX_SNAPSHOT_ENTITIES} entities; no partial snapshot published`);
      }
      const { affinityRows } = await persistTasteSnapshotEntities({
        upsertTasteEntities: (rows) => store.upsertTasteEntities(rows, control),
      }, snapshot);
      await control.checkpoint();
      const status = await store.finalize(
        job, affinityRows, Math.max(0, Math.floor(now() - jobStartedAt)), requestSignal()
      );
      return {
        ...base, status,
        eventsProcessed: snapshot.stats.eventsProcessed,
        unresolvedProducts: snapshot.stats.unresolvedProducts.length,
      };
    } catch (error) {
      const message = errorMessage(error);
      try {
        // Cleanup has its own small budget, even after the replay deadline.
        const status = await store.fail(job, message, AbortSignal.timeout(FAILURE_TIMEOUT_MS));
        return status === "stale_generation"
          ? { ...base, status }
          : { ...base, status, error: message };
      } catch (failureReportError) {
        // A lost lease or ambiguous network outcome is never reported as success.
        return {
          ...base, status: "failure_unreported", error: message,
          failureReportError: errorMessage(failureReportError),
        };
      }
    }
  }));
  return { claimed: jobs.length, jobs: results };
}
