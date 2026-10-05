#!/usr/bin/env node
/* global __dirname */
const assert = require("assert/strict");
const { Buffer } = require("node:buffer");
const fs = require("fs");
const path = require("path");
const { parseWorkerArgs, requireServiceRoleCredentials } = require("./taste-graph-worker.js");

const AS_OF = Date.parse("2026-10-06T00:00:00Z");
const event = { id: "e1", event_type: "product_like", product_id: "p1", created_at: new Date(AS_OF).toISOString() };
const products = [{ id: "p1", brand: "Acme", category: "watches", user_id: "seller", catalog_product_id: "canonical" }];
const job = (id = "u1", generation = 2) => ({
  user_id: id, captured_generation: generation, lease_token: `token-${id}`,
  lease_until: new Date(AS_OF + 300_000).toISOString(),
});

function fixture(jobs = [job()], overrides = {}) {
  const calls = [];
  const store = {
    async claim(size) { calls.push(["claim", size]); return jobs; },
    async fetchUserEvents(userId) { calls.push(["events", userId]); return [event]; },
    async fetchProductContext(ids) { calls.push(["products", ids]); return products; },
    async upsertTasteEntities(rows) {
      calls.push(["entities", rows]);
      return rows.map((row, i) => ({ ...row, id: `entity-${i}` }));
    },
    async renew(lease) { calls.push(["renew", { ...lease }]); return new Date(AS_OF + 600_000).toISOString(); },
    async finalize(lease, rows, duration) { calls.push(["finalize", { ...lease }, rows, duration]); return "published"; },
    async fail(lease, message) { calls.push(["fail", { ...lease }, message]); return "retry_scheduled"; },
    ...overrides,
  };
  return { store, calls };
}

async function main() {
  const worker = await import("../lib/tasteGraphWorker.ts");
  const { buildTasteSnapshot, buildProductContextMap } = await import("../lib/tasteGraph.ts");
  const { createTasteWorkerStore } = await import("./lib/taste-worker-store.ts");
  const run = (store, options = {}) => worker.runTasteGraphWorker(store, { now: () => AS_OF, ...options });

  let f = fixture([]);
  assert.deepEqual(await run(f.store), { claimed: 0, jobs: [] });
  assert.deepEqual(f.calls, [["claim", 5]]);

  f = fixture([job("u1", "9007199254740993")]);
  let result = await run(f.store);
  assert.equal(result.jobs[0].status, "published");
  const finalize = f.calls.find(([name]) => name === "finalize");
  assert.equal(finalize[1].captured_generation, "9007199254740993");
  assert.equal(finalize[1].lease_token, "token-u1");
  assert.equal(finalize[1].lease_until, job().lease_until);
  const expected = buildTasteSnapshot([event], { asOf: new Date(AS_OF), productContext: buildProductContextMap(products) });
  assert.deepEqual(finalize[2].map(({ taste_entity_id, ...row }) => row),
    expected.affinities.map(({ entity_type, entity_key, ...row }) => row));
  assert.deepEqual(f.calls.find(([name]) => name === "products")[1], ["p1"]);

  f = fixture([job()], { fetchUserEvents: async () => [] });
  result = await run(f.store);
  assert.equal(result.jobs[0].status, "published");
  assert.deepEqual(f.calls.find(([name]) => name === "finalize")[2], []);
  assert.ok(!f.calls.some(([name]) => name === "products"));

  f = fixture([job()], { finalize: async () => "stale_generation" });
  assert.equal((await run(f.store)).jobs[0].status, "stale_generation");
  assert.ok(!f.calls.some(([name]) => name === "fail"));

  f = fixture([job("bad"), job("good")], {
    async fetchUserEvents(userId) {
      if (userId === "bad") throw new Error("history unavailable");
      return [event];
    },
  });
  result = await run(f.store);
  assert.deepEqual(result.jobs.map(({ status }) => status), ["retry_scheduled", "published"]);
  assert.equal(f.calls.find(([name]) => name === "fail")[2], "history unavailable");
  assert.equal(f.calls.find(([name]) => name === "finalize")[1].user_id, "good");

  for (const stage of ["fetchProductContext", "upsertTasteEntities", "finalize", "renew"]) {
    const lease = job();
    if (stage === "renew") lease.lease_until = new Date(AS_OF + 30_000).toISOString();
    f = fixture([lease], { [stage]: async () => { throw new Error(`${stage} failure`); } });
    assert.equal((await run(f.store)).jobs[0].status, "retry_scheduled");
    assert.equal(f.calls.filter(([name]) => name === "fail").length, 1);
  }
  f = fixture([job()], { upsertTasteEntities: async () => [] });
  assert.match((await run(f.store)).jobs[0].error, /missing persisted taste entity/);
  assert.ok(!f.calls.some(([name]) => name === "finalize"));

  f = fixture([job()], {
    fetchUserEvents: async () => { throw new Error("bad"); },
    fail: async () => { throw new Error("lost lease"); },
  });
  result = await run(f.store);
  assert.equal(result.jobs[0].status, "failure_unreported");
  assert.equal(result.jobs[0].failureReportError, "lost lease");

  f = fixture([job()], {
    fetchUserEvents: async () => { throw new Error("superseded"); },
    fail: async () => "stale_generation",
  });
  assert.deepEqual((await run(f.store)).jobs[0], { userId: "u1", generation: 2, status: "stale_generation" });

  f = fixture([job()], {
    fetchUserEvents: async () => { throw new Error("eighth failure"); },
    fail: async () => "blocked",
  });
  assert.equal((await run(f.store)).jobs[0].status, "blocked");

  const shortLease = { ...job(), lease_until: new Date(AS_OF + 30_000).toISOString() };
  f = fixture([shortLease]);
  assert.equal((await run(f.store)).jobs[0].status, "published");
  assert.equal(f.calls.filter(([name]) => name === "renew").length, 1);
  assert.equal(f.calls.find(([name]) => name === "finalize")[1].lease_until, new Date(AS_OF + 600_000).toISOString());
  assert.equal(shortLease.lease_until, new Date(AS_OF + 30_000).toISOString());

  let time = AS_OF;
  f = fixture([job()], { fetchUserEvents: async () => { time += worker.WORKER_BUDGET_MS; return [event]; } });
  result = await run(f.store, { now: () => time });
  assert.match(result.jobs[0].error, /time budget exceeded/);
  assert.ok(!f.calls.some(([name]) => name === "finalize"));

  f = fixture([job()], { fetchUserEvents: async () => Array(worker.MAX_REPLAY_EVENTS + 1).fill(event) });
  assert.match((await run(f.store)).jobs[0].error, /no partial snapshot published/);
  f = fixture([job()], {
    fetchUserEvents: async () => Array.from({ length: worker.MAX_SNAPSHOT_ENTITIES + 1 }, (_, i) => ({
      id: `e${i}`, event_type: "seller_open", seller_id: `s${i}`, created_at: event.created_at,
    })),
  });
  assert.match((await run(f.store)).jobs[0].error, /Full snapshot exceeds/);

  for (const size of [0, 6, -1, 1.5, NaN, Infinity]) {
    f = fixture();
    await assert.rejects(run(f.store, { batchSize: size }), /integer from 1 to 5/);
    assert.deepEqual(f.calls, []);
  }
  for (const size of [1, 5]) {
    f = fixture(Array.from({ length: size }, (_, i) => job(`u${i}`)));
    assert.equal((await run(f.store, { batchSize: size })).claimed, size);
    assert.equal(f.calls.filter(([name]) => name === "claim").length, 1);
    assert.equal(f.calls[0][1], size);
  }

  // Exercise the real Supabase adapter through a fluent fake. Unexpected
  // tables/RPCs throw: direct queue mutation and unguarded replacement cannot pass.
  const operations = [];
  const eventId = (i) => `40000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
  const history = Array.from({ length: 1203 }, (_, i) => ({
    ...event, id: eventId(i + 1),
    event_type: "product_open",
    created_at: i < 700 ? "2026-10-06T00:00:00.123456+00:00" : "2026-10-06T00:00:00.123457+00:00",
  }));
  const compareEvents = (a, b) => a.created_at < b.created_at ? -1 :
    a.created_at > b.created_at ? 1 : a.id.localeCompare(b.id);
  let storedEvents = [...history].reverse();
  let eventPages = 0;
  let afterFirstPage = () => {};
  let requestedGeneration = 2;
  let processedGeneration = 0;
  const publications = [];
  const client = {
    from(table) {
      assert.ok(["user_events", "products", "taste_entities"].includes(table), `forbidden table ${table}`);
      const op = { table };
      operations.push(op);
      const query = {
        select(columns) { op.columns = columns; return query; },
        eq(column, value) { op.eq = [column, value]; return query; },
        order(column, opts) { (op.order ??= []).push([column, opts]); return query; },
        range() { assert.fail("user_events must never use offset/range pagination"); },
        limit(size) { op.limit = size; return query; },
        or(filter) { op.filter = filter; return query; },
        in(column, ids) { op.ids = ids; return query; },
        upsert(rows, opts) { op.rows = rows; op.conflict = opts.onConflict; return query; },
        async abortSignal(signal) {
          assert.ok(signal instanceof AbortSignal);
          if (table === "user_events") {
            assert.deepEqual(op.order, [["created_at", { ascending: true }], ["id", { ascending: true }]]);
            assert.equal(op.limit, 500);
            let candidates = [...storedEvents].sort(compareEvents);
            if (op.filter) {
              const match = /^created_at\.gt\.("[^"]+"),and\(created_at\.eq\.("[^"]+"),id\.gt\.("[^"]+")\)$/.exec(op.filter);
              assert.ok(match, `invalid composite keyset filter: ${op.filter}`);
              const createdAt = JSON.parse(match[1]);
              assert.equal(JSON.parse(match[2]), createdAt);
              const id = JSON.parse(match[3]);
              candidates = candidates.filter((row) => row.created_at > createdAt ||
                (row.created_at === createdAt && row.id > id));
            }
            const data = candidates.slice(0, op.limit);
            op.returnedIds = data.map(({ id }) => id);
            eventPages += 1;
            if (eventPages === 1) afterFirstPage();
            return { data, error: null };
          }
          if (table === "products") return { data: products, error: null };
          return { data: op.rows.map((row, i) => ({ ...row, id: `${row.entity_type}:${row.entity_key}` })), error: null };
        },
      };
      return query;
    },
    rpc(name, params) {
      assert.ok(["claim_taste_graph_rebuild_jobs", "renew_taste_graph_rebuild_lease", "finalize_taste_graph_rebuild", "fail_taste_graph_rebuild"].includes(name), `forbidden RPC ${name}`);
      operations.push({ rpc: name, params });
      return {
        async abortSignal(signal) {
          assert.ok(signal instanceof AbortSignal);
          if (name === "finalize_taste_graph_rebuild") {
            if (params.p_captured_generation !== requestedGeneration) {
              return { data: "stale_generation", error: null };
            }
            publications.push(params.p_rows);
            processedGeneration = params.p_captured_generation;
            return { data: "published", error: null };
          }
          const data = name === "claim_taste_graph_rebuild_jobs" ? [{ ...shortLease, captured_generation: requestedGeneration }] :
            name === "renew_taste_graph_rebuild_lease" ? new Date(AS_OF + 600_000).toISOString() :
              name === "finalize_taste_graph_rebuild" ? "published" : "retry_scheduled";
          return { data, error: null };
        },
      };
    },
  };
  const adapter = createTasteWorkerStore(client);
  assert.equal((await run(adapter)).jobs[0].eventsProcessed, 1203);
  const pages = operations.filter(({ table }) => table === "user_events");
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map(({ limit }) => limit), [500, 500, 500]);
  assert.equal(pages[0].filter, undefined);
  for (const [page, boundary] of [[pages[1], history[499]], [pages[2], history[999]]]) {
    assert.equal(page.filter,
      `created_at.gt.${JSON.stringify(boundary.created_at)},and(created_at.eq.${JSON.stringify(boundary.created_at)},id.gt.${JSON.stringify(boundary.id)})`);
  }
  assert.deepEqual(pages.flatMap(({ returnedIds }) => returnedIds), history.map(({ id }) => id));
  assert.equal(new Set(pages.flatMap(({ returnedIds }) => returnedIds)).size, history.length);
  assert.deepEqual(pages[0].eq, ["user_id", "u1"]);
  assert.deepEqual(pages[0].order.map(([column]) => column), ["created_at", "id"]);
  const rpc = operations.find(({ rpc }) => rpc === "finalize_taste_graph_rebuild");
  assert.equal(rpc.params.p_captured_generation, 2);
  assert.equal(rpc.params.p_lease_token, "token-u1");
  assert.equal(rpc.params.p_user_id, "u1");
  assert.deepEqual(operations.find(({ rpc }) => rpc === "renew_taste_graph_rebuild_lease").params, {
    p_user_id: "u1", p_captured_generation: 2, p_lease_token: "token-u1",
  });
  const control = { checkpoint: async () => {}, requestSignal: () => AbortSignal.timeout(1000) };

  // Non-taste inserts behind the cursor do not dirty the queue or repeat a
  // boundary taste event. Generation guards alone cannot catch that old bug.
  eventPages = 0;
  afterFirstPage = () => {
    storedEvents.push({ ...event, id: eventId(9000), event_type: "product_impression",
      created_at: "2026-10-05T00:00:00+00:00" });
  };
  const readEvents = await adapter.fetchUserEvents("u1", control);
  assert.deepEqual(readEvents, history);

  // A taste event arriving during a claimed replay must invalidate publication,
  // including a backdated event that the cursor will intentionally not revisit.
  for (const createdAt of ["2026-10-05T00:00:00+00:00", "2026-10-07T00:00:00+00:00"]) {
    operations.length = 0;
    storedEvents = [...history];
    eventPages = 0;
    requestedGeneration = 2;
    processedGeneration = 0;
    publications.length = 0;
    afterFirstPage = () => {
      storedEvents.push({ ...event, id: eventId(9001), event_type: "product_open", created_at: createdAt });
      requestedGeneration += 1;
    };
    result = await run(adapter);
    assert.equal(result.jobs[0].generation, 2);
    assert.equal(result.jobs[0].status, "stale_generation");
    assert.equal(processedGeneration, 0);
    assert.equal(requestedGeneration, 3);
    assert.deepEqual(publications, []);
    assert.ok(!operations.some(({ rpc }) => rpc === "fail_taste_graph_rebuild"));

    eventPages = 0;
    afterFirstPage = () => {};
    result = await run(adapter);
    assert.equal(result.jobs[0].generation, 3);
    assert.equal(result.jobs[0].status, "published");
    assert.equal(result.jobs[0].eventsProcessed, history.length + 1);
    assert.equal(processedGeneration, 3);
    assert.equal(publications.length, 1);
  }

  // The real paged adapter, not only the orchestration fake, enforces the cap.
  eventPages = 0;
  storedEvents = Array.from({ length: worker.MAX_REPLAY_EVENTS + 1 }, (_, i) => ({
    ...event, id: eventId(i + 1),
  }));
  await assert.rejects(adapter.fetchUserEvents("u1", control), /Full replay exceeds 50000 events/);
  storedEvents = [...history];
  eventPages = 0;

  operations.length = 0;
  await adapter.fetchProductContext(Array.from({ length: 401 }, (_, i) => `p${i}`), control);
  assert.deepEqual(operations.map(({ ids }) => ids.length), [200, 200, 1]);
  operations.length = 0;
  await adapter.upsertTasteEntities(Array.from({ length: 401 }, (_, i) => ({ entity_type: "brand", entity_key: `b${i}` })), control);
  assert.deepEqual(operations.map(({ rows }) => rows.length), [200, 200, 1]);
  assert.equal(await adapter.fail(job(), "failure", control.requestSignal()), "retry_scheduled");

  const supersededClient = {
    ...client,
    rpc(name, params) {
      if (name !== "finalize_taste_graph_rebuild") return client.rpc(name, params);
      return { abortSignal: async () => ({ data: "stale_generation", error: null }) };
    },
  };
  assert.equal((await run(createTasteWorkerStore(supersededClient))).jobs[0].status, "stale_generation");

  const badClient = { rpc: () => ({ abortSignal: async () => ({ data: "unexpected", error: null }) }) };
  await assert.rejects(createTasteWorkerStore(badClient).finalize(job(), [], 0, control.requestSignal()), /invalid status/);
  const errorClient = { rpc: () => ({ abortSignal: async () => ({ error: { message: "database unavailable" } }) }) };
  await assert.rejects(createTasteWorkerStore(errorClient).claim(5, control.requestSignal()), /database unavailable/);

  assert.deepEqual(parseWorkerArgs([]), { run: false, batchSize: 5 });
  assert.deepEqual(parseWorkerArgs(["--run", "--batch-size", "1"]), { run: true, batchSize: 1 });
  assert.throws(() => parseWorkerArgs(["--run", "--batch-size", "6"]));
  const jwt = (role) => `header.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.signature`;
  for (const key of [jwt("anon"), jwt("authenticated"), "opaque", ""]) {
    assert.throws(() => requireServiceRoleCredentials({ SUPABASE_URL: "http://localhost", SUPABASE_SERVICE_ROLE_KEY: key }));
  }
  assert.equal(requireServiceRoleCredentials({ SUPABASE_URL: "http://localhost", SUPABASE_SERVICE_ROLE_KEY: jwt("service_role") }).key, jwt("service_role"));

  // Static checks supplement, not replace, behavioral and PostgreSQL tests.
  const repair = fs.readFileSync(path.join(__dirname, "../supabase/migrations/20261005_repair_taste_onboarding_event_authority.sql"), "utf8");
  for (const type of ["onboarding_category_select", "onboarding_category_deselect", "onboarding_product_select", "onboarding_product_deselect"]) {
    assert.ok(repair.includes(`'${type}'`));
  }
  assert.match(repair, /security definer\s+set search_path = ''/);
  assert.match(repair, /pg_advisory_xact_lock/);
  console.log("Taste Graph worker offline runtime/adapter contracts passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
