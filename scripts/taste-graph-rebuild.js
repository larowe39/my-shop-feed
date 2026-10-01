// scripts/taste-graph-rebuild.js
/**
 * PENCHANT Taste Graph Rebuild (PR #34)
 *
 * Rebuilds ONE user's derived Taste Graph state from their append-only
 * public.user_events history using the deterministic engine in
 * lib/tasteGraph.ts (signal model in lib/tasteSignals.ts):
 *
 *   user_events -> resolve product context -> build snapshot
 *     -> upsert taste_entities -> replace user_taste_affinities
 *
 * Persistence is snapshot REPLACEMENT, not incremental addition, and it is
 * ATOMIC: a single PostgreSQL function call
 * (public.replace_user_taste_affinity_snapshot, added by the PR #34
 * migration) upserts the new snapshot rows by (user_id, taste_entity_id) and
 * deletes the user's stale rows inside one transaction. Any failure rolls
 * the whole replacement back, so a user's derived state can never be left in
 * a mixed old/new state, and re-running --apply with the same history and
 * --as-of converges instead of inflating scores.
 *
 * DRY-RUN IS THE DEFAULT: no database writes happen unless --apply is
 * passed explicitly.
 *
 * REQUIRES the Supabase SERVICE ROLE key even for dry-runs: RLS on
 * user_events is insert-only for clients (no select policy), and writes to
 * the taste tables bypass RLS entirely. Put it in a local, gitignored
 * `.env.local`:
 *   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
 *
 * Usage:
 *   node scripts/taste-graph-rebuild.js --user <uuid>                 dry-run (default)
 *   node scripts/taste-graph-rebuild.js --user <uuid> --apply         write the snapshot
 *   node scripts/taste-graph-rebuild.js --user <uuid> --as-of 2026-10-01T00:00:00.000Z
 *
 * --as-of pins the deterministic reference timestamp used for recency
 * decay; when omitted, the current time is used.
 */

const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
// Local-only overrides (gitignored) — this is where SUPABASE_SERVICE_ROLE_KEY lives.
require("dotenv").config({ path: ".env.local", override: true });

function parseArgs(argv) {
  const args = { user: null, apply: false, asOf: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--dry-run") {
      args.apply = false;
    } else if (arg === "--user") {
      args.user = argv[++i] ?? null;
    } else if (arg === "--as-of") {
      args.asOf = argv[++i] ?? null;
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

const args = parseArgs(process.argv);

if (!args.user) {
  console.error("Missing required --user <uuid>. Rebuilds run for one user at a time.");
  process.exit(1);
}

const asOf = args.asOf ? new Date(args.asOf) : new Date();
if (!Number.isFinite(asOf.getTime())) {
  console.error(`Invalid --as-of timestamp: ${args.asOf}`);
  process.exit(1);
}

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  console.error("Missing EXPO_PUBLIC_SUPABASE_URL in .env");
  process.exit(1);
}

if (!serviceRoleKey) {
  console.error(
    "\nMissing SUPABASE_SERVICE_ROLE_KEY.\n" +
      "Rebuilding taste state reads other columns of user_events (RLS is insert-only\n" +
      "for clients) and writes the derived taste tables, which requires bypassing\n" +
      "RLS, so this script must not run with the anon key. Add it to a local,\n" +
      "gitignored `.env.local` file:\n\n" +
      "  SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here\n\n" +
      "Find it in Supabase Dashboard -> Project Settings -> API -> service_role.\n" +
      "Never commit this key or use an EXPO_PUBLIC_ prefix for it.\n"
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PAGE_SIZE = 1000;

// TasteGraphStore (see lib/tasteGraphRebuild.ts) over the service-role client.
const store = {
  async fetchUserEvents(userId) {
    const rows = [];
    let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from("user_events")
        .select("id, user_id, session_id, event_type, product_id, seller_id, category, metadata, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      rows.push(...(data ?? []));
      if (!data || data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
    return rows;
  },

  async fetchProductContext(productIds) {
    if (productIds.length === 0) return [];
    const { data, error } = await supabase
      .from("products")
      .select("id, title, brand, category, user_id, catalog_product_id")
      .in("id", productIds);
    if (error) throw error;
    return data ?? [];
  },

  async upsertTasteEntities(rows) {
    if (rows.length === 0) return [];
    const { data, error } = await supabase
      .from("taste_entities")
      .upsert(rows, { onConflict: "entity_type,entity_key" })
      .select("id, entity_type, entity_key");
    if (error) throw error;
    return data ?? [];
  },

  // Atomic snapshot replacement: ONE PostgreSQL function call upserts the
  // new rows and deletes this user's stale rows transactionally (see the PR
  // #34 migration). If the RPC raises, nothing is committed and the user's
  // previous snapshot is preserved. The RPC's EXECUTE grant is service_role
  // only; anon/authenticated clients cannot call it.
  async replaceUserAffinitySnapshot(userId, rows) {
    const { data, error } = await supabase.rpc(
      "replace_user_taste_affinity_snapshot",
      {
        p_user_id: userId,
        p_rows: rows.map((row) => ({
          taste_entity_id: row.taste_entity_id,
          long_term_score: row.long_term_score,
          recent_score: row.recent_score,
          positive_signal_count: row.positive_signal_count,
          negative_signal_count: row.negative_signal_count,
          last_interaction_at: row.last_interaction_at,
        })),
      }
    );
    if (error) throw error;
    return {
      upserted: typeof data?.upserted === "number" ? data.upserted : rows.length,
      deleted: typeof data?.deleted === "number" ? data.deleted : 0,
    };
  },
};

async function main() {
  const { rebuildUserTasteGraph } = await import("../lib/tasteGraphRebuild.ts");

  const result = await rebuildUserTasteGraph(store, args.user, {
    asOf,
    apply: args.apply,
  });

  console.log("\nTaste Graph rebuild");
  console.log("===================");
  for (const line of result.summary) {
    console.log(`  ${line}`);
  }
  if (result.snapshot.stats.unresolvedProducts.length > 0) {
    console.log("\n  unresolved product ids:");
    for (const id of result.snapshot.stats.unresolvedProducts) {
      console.log(`    - ${id}`);
    }
  }
  if (result.dryRun) {
    console.log("\nDry-run only — no database writes were made. Re-run with --apply to persist.");
  }
}

main().catch((err) => {
  console.error("\nTaste Graph rebuild failed:", err);
  process.exit(1);
});
