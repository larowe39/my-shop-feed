// scripts/taste-graph-inspect.js
/**
 * PENCHANT Taste Graph Inspect (PR #34) — READ-ONLY developer/debug tool.
 *
 * Computes a user's taste snapshot from raw event history and prints it.
 * NEVER writes to the database.
 *
 * Modes:
 *   --user <uuid>       read the user's user_events + product context via the
 *                       service role (reads only) and print the snapshot
 *   --fixture <path>    offline deterministic mode: read a JSON fixture of
 *                       { "events": [...], "products": [...] } and print the
 *                       snapshot. No Supabase credentials needed.
 *
 * Options:
 *   --as-of <ISO>       pin the deterministic decay reference timestamp
 *                       (default: current time)
 *
 * Usage:
 *   node scripts/taste-graph-inspect.js --user <uuid> [--as-of 2026-10-01T00:00:00.000Z]
 *   node scripts/taste-graph-inspect.js --fixture scripts/fixtures/taste-graph-sample.json --as-of 2026-10-01T00:00:00.000Z
 */

const fs = require("fs");

function parseArgs(argv) {
  const args = { user: null, fixture: null, asOf: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--user") {
      args.user = argv[++i] ?? null;
    } else if (arg === "--fixture") {
      args.fixture = argv[++i] ?? null;
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

if ((!args.user && !args.fixture) || (args.user && args.fixture)) {
  console.error("Pass exactly one of --user <uuid> or --fixture <path>.");
  process.exit(1);
}

const asOf = args.asOf ? new Date(args.asOf) : new Date();
if (!Number.isFinite(asOf.getTime())) {
  console.error(`Invalid --as-of timestamp: ${args.asOf}`);
  process.exit(1);
}

async function loadFixture(path) {
  const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
  return {
    events: Array.isArray(parsed.events) ? parsed.events : [],
    products: Array.isArray(parsed.products) ? parsed.products : [],
  };
}

async function loadFromSupabase(userId) {
  const { createClient } = require("@supabase/supabase-js");
  require("dotenv").config();
  require("dotenv").config({ path: ".env.local", override: true });

  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl) {
    console.error("Missing EXPO_PUBLIC_SUPABASE_URL in .env");
    process.exit(1);
  }
  if (!serviceRoleKey) {
    console.error(
      "\nMissing SUPABASE_SERVICE_ROLE_KEY.\n" +
        "RLS on user_events is insert-only for clients, so even read-only\n" +
        "inspection needs the service role key. Add it to a local, gitignored\n" +
        "`.env.local` file:\n\n" +
        "  SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here\n\n" +
        "Never commit this key or use an EXPO_PUBLIC_ prefix for it.\n"
    );
    process.exit(1);
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: events, error: eventsError } = await supabase
    .from("user_events")
    .select("id, user_id, session_id, event_type, product_id, seller_id, category, metadata, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(10000);
  if (eventsError) throw eventsError;

  const productIds = [
    ...new Set(
      (events ?? [])
        .map((event) => event.product_id)
        .filter((id) => typeof id === "string" && id.length > 0)
    ),
  ];
  let products = [];
  if (productIds.length > 0) {
    const { data, error } = await supabase
      .from("products")
      .select("id, title, brand, category, user_id, catalog_product_id")
      .in("id", productIds);
    if (error) throw error;
    products = data ?? [];
  }
  return { events: events ?? [], products };
}

async function main() {
  const { buildProductContextMap, buildTasteSnapshot } = await import("../lib/tasteGraph.ts");
  const { formatSnapshotTable } = await import("../lib/tasteGraphRebuild.ts");

  const { events, products } = args.fixture
    ? await loadFixture(args.fixture)
    : await loadFromSupabase(args.user);

  const snapshot = buildTasteSnapshot(events, {
    asOf,
    productContext: buildProductContextMap(products),
  });

  console.log("\nTaste snapshot (read-only)");
  console.log("==========================");
  console.log(`  source: ${args.fixture ? `fixture ${args.fixture}` : `user ${args.user}`}`);
  console.log(`  as of: ${snapshot.asOf}`);
  console.log(`  signal version: ${snapshot.version}`);
  console.log(`  events processed: ${snapshot.stats.eventsProcessed}`);
  console.log(`  taste events: ${snapshot.stats.tasteEvents}`);
  console.log(`  skipped non-taste events: ${snapshot.stats.skippedNonTasteEvents}`);
  console.log(`  malformed events: ${snapshot.stats.malformedEvents}`);
  console.log(`  orphan reversals: ${snapshot.stats.orphanReversals}`);
  console.log(`  unresolved products: ${snapshot.stats.unresolvedProducts.length}`);
  console.log("");
  for (const line of formatSnapshotTable(snapshot)) {
    console.log(`  ${line}`);
  }
}

main().catch((err) => {
  console.error("\nTaste Graph inspect failed:", err);
  process.exit(1);
});
