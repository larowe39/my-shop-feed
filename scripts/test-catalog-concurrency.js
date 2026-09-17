#!/usr/bin/env node
const assert = require("assert");

(async () => {
  const { OpenIcecatProvider, decodeIcecatDiscoveryCursor } = await import("../lib/catalogProviders.ts");
  const ids = ["1", "2", "3", "4", "5", "6"];
  const index = `<ICECAT-interface><files.index>${ids.map((id) => `<file path="export/freexml/INT/${id}.xml" Product_ID="${id}" Prod_ID="MPN-${id}" Model_Name="Model ${id}"/>`).join("")}</files.index></ICECAT-interface>`;
  const delays = { "1": 45, "2": 5, "3": 30, "4": 1, "5": 20, "6": 2 };
  const detail = (id) => `<?xml version="1.0"?><ICECAT-interface><Product ID="${id}" Name="Model ${id}" Prod_id="MPN-${id}"><Supplier ID="s-${id}" Name="Brand"/></Product></ICECAT-interface>`;

  async function run(concurrency, options = {}) {
    let active = 0;
    let maxActive = 0;
    const metrics = [];
    const provider = new OpenIcecatProvider({
      username: "u",
      password: "p",
      fetcher: async (url, init) => {
        if (String(url).endsWith(".index.xml.gz")) return new Response(index, { headers: { etag: "fixture-snapshot" } });
        const id = String(url).match(/\/(\d+)\.xml$/)[1];
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delays[id]);
          init.signal.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
        }).finally(() => { active -= 1; });
        return new Response(detail(id));
      },
    });
    const pages = [];
    for await (const page of provider.discoverProducts({ ...options, limit: options.limit ?? 5, pageSize: 2, concurrency, diagnostics: { onMetrics: (value) => metrics.push(value) } })) {
      page.acknowledge?.();
      pages.push({ ids: page.records.map((record) => record.sourceExternalId), errors: page.errors, checkpoint: page.checkpoint });
    }
    return { pages, maxActive, metrics: metrics.at(-1) };
  }

  const reference = await run(1);
  for (const concurrency of [2, 3, 5]) {
    const result = await run(concurrency);
    assert.deepStrictEqual(result.pages.map((page) => page.ids), reference.pages.map((page) => page.ids), `page boundaries must match at concurrency ${concurrency}`);
    assert.deepStrictEqual(result.pages.flatMap((page) => page.errors), reference.pages.flatMap((page) => page.errors));
    assert.strictEqual(result.maxActive <= concurrency, true);
    assert.strictEqual(result.metrics.concurrency, concurrency);
    assert.strictEqual(result.metrics.admissionWindow, concurrency * 2);
    assert.strictEqual(result.metrics.maxActiveDetailRequests, result.maxActive, `metric active mismatch at concurrency ${concurrency}: ${JSON.stringify(result.metrics)}`);
    assert.strictEqual(result.metrics.admittedWindowHighWaterMark <= concurrency * 2, true);
    assert.strictEqual(result.metrics.reorderBufferHighWaterMark <= concurrency * 2, true);
    assert.strictEqual(result.metrics.detailLatencyCount, result.metrics.enrichmentAttempts);
    assert.strictEqual(result.maxActive > 1, true, `details must overlap at concurrency ${concurrency}`);
  }

  const serialPartial = await run(1, { limit: 2 });
  const serialCursor = serialPartial.pages.at(-1).checkpoint.acknowledgedCursor;
  assert.ok(serialCursor && decodeIcecatDiscoveryCursor(serialCursor).acknowledgedPosition > 0);
  for (const concurrency of [2, 3, 5]) {
    const partial = await run(concurrency, { limit: 2 });
    const cursor = partial.pages.at(-1).checkpoint.acknowledgedCursor;
    const resumed = await run(concurrency, { limit: 3, cursor });
    assert.deepStrictEqual(partial.pages.flatMap((page) => page.ids).concat(resumed.pages.flatMap((page) => page.ids)), reference.pages.flatMap((page) => page.ids), `resume must match serial at concurrency ${concurrency}`);
  }

  console.log("Ordered bounded concurrency fixture tests passed.");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
