#!/usr/bin/env node
// One bounded service-side invocation. Deliberately no dotenv autoload or schedule.
const { createClient } = require("@supabase/supabase-js");
const { Buffer } = require("node:buffer");

function parseWorkerArgs(argv) {
  let run = false;
  let batchSize = 5;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--run") run = true;
    else if (argv[i] === "--batch-size") batchSize = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5) {
    throw new Error("--batch-size must be an integer from 1 to 5");
  }
  return { run, batchSize };
}

function requireServiceRoleCredentials(env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (server environment only)");
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("Invalid SUPABASE_URL protocol");
  let payload;
  try {
    payload = JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    throw new Error("Worker requires a service_role JWT, not an anon/authenticated key");
  }
  if (payload.role !== "service_role") throw new Error("Worker requires service_role credentials");
  return { url, key };
}

async function main() {
  const { run, batchSize } = parseWorkerArgs(process.argv.slice(2));
  if (!run) {
    console.log("No work claimed. To perform ONE batch (writes): npm run taste:worker -- --run [--batch-size 1..5]");
    return;
  }
  const { url, key } = requireServiceRoleCredentials(process.env);
  const [{ runTasteGraphWorker }, { createTasteWorkerStore }] = await Promise.all([
    import("../lib/tasteGraphWorker.ts"),
    import("./lib/taste-worker-store.ts"),
  ]);
  const client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const result = await runTasteGraphWorker(createTasteWorkerStore(client), { batchSize });
  console.log(JSON.stringify(result, null, 2));
  if (result.jobs.some((job) => job.status !== "published" && job.status !== "stale_generation")) {
    process.exitCode = 1;
  }
}

module.exports = { parseWorkerArgs, requireServiceRoleCredentials };
if (require.main === module) {
  main().catch((error) => {
    console.error("Taste Graph worker failed:", error.message);
    process.exitCode = 1;
  });
}
