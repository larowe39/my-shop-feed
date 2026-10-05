#!/usr/bin/env node
/* global __dirname */
// Disposable PostgreSQL ONLY. No connection URL, host ports, Supabase env, or production access.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const name = `penchant-taste-test-${process.pid}-${Date.now()}`;
function docker(args, input) {
  const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 120_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`docker ${args[0]} failed: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout;
}
function sql(file) {
  docker(["exec", "-i", name, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1"],
    fs.readFileSync(path.join(__dirname, file), "utf8"));
}
let created = false;
try {
  docker(["run", "--detach", "--name", name, "--network", "none", "--tmpfs", "/var/lib/postgresql/data",
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17"]);
  created = true;
  let ready = false;
  for (let i = 0; i < 30; i += 1) {
    const probe = spawnSync("docker", ["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], { encoding: "utf8", timeout: 5000 });
    if (probe.status === 0) { ready = true; break; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  if (!ready) throw new Error("Disposable PostgreSQL did not become ready");
  sql("fixtures/taste-freshness-db-bootstrap.sql");
  for (const migration of [
    "20260910_add_product_likes_and_saves.sql",
    "20260911_add_user_profiles_and_follows.sql",
    "20260912_add_user_events.sql",
    "20261001_add_taste_graph_foundation.sql",
    "20261002_add_taste_onboarding.sql",
    "20261005_add_taste_graph_freshness_foundation.sql",
    "20261006_repair_taste_onboarding_event_authority.sql",
  ]) sql(`../supabase/migrations/${migration}`);
  sql("fixtures/taste-freshness-db-assertions.sql");
  console.log("Disposable PostgreSQL onboarding RLS and freshness RPC integration tests passed.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (created) {
    try { docker(["rm", "--force", name]); }
    catch (error) { console.error(`Test container cleanup failed: ${error.message}`); process.exitCode = 1; }
  }
}
