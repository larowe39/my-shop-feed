import type { SupabaseClient } from "@supabase/supabase-js";
import type { TasteEventRow, TasteProductContext } from "../../lib/tasteGraph.ts";
import { MAX_REPLAY_EVENTS } from "../../lib/tasteGraphWorker.ts";
import type { ClaimedTasteJob, TasteWorkerStore } from "../../lib/tasteGraphWorker.ts";

const PAGE_SIZE = 500;
const CHUNK_SIZE = 200;

function jobParams(job: ClaimedTasteJob) {
  return {
    p_user_id: job.user_id,
    p_captured_generation: job.captured_generation,
    p_lease_token: job.lease_token,
  };
}

export function createTasteWorkerStore(client: SupabaseClient): TasteWorkerStore {
  return {
    async claim(batchSize, signal) {
      const { data, error } = await client.rpc("claim_taste_graph_rebuild_jobs", {
        p_batch_size: batchSize,
      }).abortSignal(signal);
      if (error) throw new Error(`claim_taste_graph_rebuild_jobs: ${error.message}`);
      if (!Array.isArray(data)) throw new Error("Claim RPC returned invalid jobs");
      return data.map((row) => {
        if (!row || typeof row.user_id !== "string" || typeof row.lease_token !== "string" ||
          typeof row.lease_until !== "string" || !Number.isFinite(Date.parse(row.lease_until)) ||
          !((typeof row.captured_generation === "number" && Number.isSafeInteger(row.captured_generation) && row.captured_generation > 0) ||
            (typeof row.captured_generation === "string" && /^[1-9]\d*$/.test(row.captured_generation)))) {
          throw new Error("Claim RPC returned invalid lease/generation");
        }
        return row;
      });
    },
    async fetchUserEvents(userId, control) {
      const rows: TasteEventRow[] = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        await control.checkpoint();
        const { data, error } = await client.from("user_events")
          .select("id, user_id, session_id, event_type, product_id, seller_id, category, metadata, created_at")
          .eq("user_id", userId)
          .order("created_at", { ascending: true }).order("id", { ascending: true })
          .range(from, from + PAGE_SIZE - 1).abortSignal(control.requestSignal());
        if (error) throw new Error(`fetch user_events: ${error.message}`);
        if (!Array.isArray(data)) throw new Error("Event query returned invalid rows");
        rows.push(...data);
        if (rows.length > MAX_REPLAY_EVENTS) throw new Error(`Full replay exceeds ${MAX_REPLAY_EVENTS} events`);
        if (data.length < PAGE_SIZE) return rows;
      }
    },
    async fetchProductContext(ids, control) {
      const rows: TasteProductContext[] = [];
      for (let from = 0; from < ids.length; from += CHUNK_SIZE) {
        await control.checkpoint();
        const { data, error } = await client.from("products")
          .select("id, title, brand, category, user_id, catalog_product_id")
          .in("id", ids.slice(from, from + CHUNK_SIZE)).abortSignal(control.requestSignal());
        if (error) throw new Error(`fetch products: ${error.message}`);
        if (!Array.isArray(data)) throw new Error("Product query returned invalid rows");
        rows.push(...data);
      }
      return rows;
    },
    async upsertTasteEntities(entities, control) {
      const rows: { id: string; entity_type: string; entity_key: string }[] = [];
      for (let from = 0; from < entities.length; from += CHUNK_SIZE) {
        await control.checkpoint();
        const { data, error } = await client.from("taste_entities")
          .upsert(entities.slice(from, from + CHUNK_SIZE), { onConflict: "entity_type,entity_key" })
          .select("id, entity_type, entity_key").abortSignal(control.requestSignal());
        if (error) throw new Error(`upsert taste_entities: ${error.message}`);
        if (!Array.isArray(data)) throw new Error("Entity upsert returned invalid rows");
        rows.push(...data);
      }
      return rows;
    },
    async renew(job, signal) {
      const { data, error } = await client.rpc("renew_taste_graph_rebuild_lease", jobParams(job)).abortSignal(signal);
      if (error) throw new Error(`renew_taste_graph_rebuild_lease: ${error.message}`);
      if (typeof data !== "string") throw new Error("Renew RPC returned invalid expiry");
      return data;
    },
    async finalize(job, rows, durationMs, signal) {
      const { data, error } = await client.rpc("finalize_taste_graph_rebuild", {
        ...jobParams(job), p_rows: rows, p_duration_ms: durationMs,
      }).abortSignal(signal);
      if (error) throw new Error(`finalize_taste_graph_rebuild: ${error.message}`);
      if (data !== "published" && data !== "stale_generation") throw new Error("Finalize RPC returned invalid status");
      return data;
    },
    async fail(job, message, signal) {
      const { data, error } = await client.rpc("fail_taste_graph_rebuild", {
        ...jobParams(job), p_error: message.slice(0, 1000),
      }).abortSignal(signal);
      if (error) throw new Error(`fail_taste_graph_rebuild: ${error.message}`);
      if (data !== "retry_scheduled" && data !== "blocked" && data !== "stale_generation") {
        throw new Error("Fail RPC returned invalid status");
      }
      return data;
    },
  };
}
