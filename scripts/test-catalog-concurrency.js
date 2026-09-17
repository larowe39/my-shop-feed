#!/usr/bin/env node
const assert = require("assert");

(async () => {
  const { OpenIcecatProvider, decodeIcecatDiscoveryCursor } = await import("../lib/catalogProviders.ts");
  const { acquireDiscoveredProducts } = await import("../lib/catalogAcquisition.ts");
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
  let acquisitionMaxActive = 0;
  const acquisitionProvider = new OpenIcecatProvider({
    username: "u",
    password: "p",
    fetcher: async (url, init) => {
      if (String(url).endsWith(".index.xml.gz")) return new Response(index, { headers: { etag: "acquisition-snapshot" } });
      const id = String(url).match(/\/(\d+)\.xml$/)[1];
      acquisitionMaxActive += 1;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delays[id]);
        init.signal.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
      });
      acquisitionMaxActive -= 1;
      return new Response(detail(id));
    },
  });
  const acquisitionRun = await acquireDiscoveredProducts(acquisitionProvider, { limit: 5, pageSize: 2, concurrency: 2 }, [], acquisitionProvider.getSourceMetadata(), { apply: false });
  assert.strictEqual(acquisitionRun.providerMetrics?.concurrency, 2);
  assert.strictEqual(acquisitionRun.providerMetrics?.maxActiveDetailRequests >= 2, true);
  for (const concurrency of [2, 3, 5]) {
    const result = await run(concurrency);
    assert.deepStrictEqual(result.pages.map((page) => page.ids), reference.pages.map((page) => page.ids), `page boundaries must match at concurrency ${concurrency}`);
    assert.deepStrictEqual(result.pages.flatMap((page) => page.errors), reference.pages.flatMap((page) => page.errors));
    assert.strictEqual(result.maxActive <= concurrency, true);
    assert.strictEqual(result.metrics.concurrency, concurrency);
    assert.strictEqual(result.metrics.admissionWindow, concurrency * 2);
    assert.strictEqual(result.metrics.maxActiveDetailRequests, result.maxActive, `metric active mismatch at concurrency ${concurrency}: ${JSON.stringify(result.metrics)}`);
    assert.strictEqual(result.metrics.admittedWindowHighWaterMark <= result.metrics.totalWorkBound, true);
    assert.strictEqual(result.metrics.reorderBufferHighWaterMark <= concurrency * 2, true);
    assert.strictEqual(result.metrics.detailLatencyCount, result.metrics.enrichmentAttempts);
    assert.strictEqual(result.maxActive > 1, true, `details must overlap at concurrency ${concurrency}`);
  }

  for (const parserFeedChars of [128, 1024, 4096]) {
    const dense = await run(3, { parserFeedChars, limit: 5 });
    assert.strictEqual(dense.metrics.parserPendingBound, parserFeedChars);
    assert.strictEqual(dense.metrics.admittedWindowHighWaterMark <= dense.metrics.totalWorkBound, true, `dense parser feed exceeded bound at ${parserFeedChars}`);
    assert.deepStrictEqual(dense.pages.map((page) => page.ids), reference.pages.map((page) => page.ids), `dense pages at ${parserFeedChars}: ${JSON.stringify(dense.pages.map((page) => page.ids))}`);
  }

  const mixedIds = ["1", "2", "3", "4", "5", "6", "7", "8"];
  const mixedIndex = `<ICECAT-interface><files.index>${mixedIds.map((id) => `<file path="export/freexml/INT/${id}.xml" Product_ID="${id}" Prod_ID="MPN-${id}" Model_Name="Model ${id}"/>`).join("")}</files.index></ICECAT-interface>`;
  async function runMixed(concurrency) {
    const provider = new OpenIcecatProvider({
      username: "u",
      password: "p",
      fetcher: async (url) => {
        if (String(url).endsWith(".index.xml.gz")) return new Response(mixedIndex, { headers: { etag: "mixed-snapshot" } });
        const id = String(url).match(/\/(\d+)\.xml$/)[1];
        await new Promise((resolve) => setTimeout(resolve, { "1": 20, "2": 1, "3": 15, "4": 2, "5": 10, "6": 3, "7": 5, "8": 1 }[id]));
        if (id === "2") return new Response("missing", { status: 404, statusText: "Not Found" });
        if (id === "3") return new Response("<broken");
        if (id === "4") return new Response(detail("40"));
        if (id === "5") return new Response(detail("5").replace("MPN-5", "OTHER-MPN"));
        if (id === "6") return new Response(detail("6").replace('Name="Brand"', 'Name="Other"'));
        if (id === "7") throw new Error("synthetic network failure");
        if (id === "8") return new Response("unavailable", { status: 503, statusText: "Unavailable" });
        return new Response(detail(id));
      },
    });
    const pages = [];
    for await (const page of provider.discoverProducts({ limit: 10, pageSize: 2, concurrency, brand: "Brand" })) {
      page.acknowledge?.();
      pages.push({ ids: page.records.map((record) => record.sourceExternalId), errors: page.errors.map((error) => ({ sourceExternalId: error.sourceExternalId, message: error.message, retriable: error.retriable })), continuation: page.checkpoint?.acknowledgedContinuation ?? null });
    }
    return pages;
  }
  const mixedReference = await runMixed(1);
  for (const concurrency of [2, 3, 5]) assert.deepStrictEqual(await runMixed(concurrency), mixedReference, `mixed outcomes must match at concurrency ${concurrency}`);

  const consumerController = new AbortController();
  let consumerRequests = 0;
  const consumerProvider = new OpenIcecatProvider({
    username: "u",
    password: "p",
    fetcher: async (url, init) => {
      if (String(url).endsWith(".index.xml.gz")) return new Response(index, { headers: { etag: "consumer-snapshot" } });
      consumerRequests += 1;
      const id = String(url).match(/\/(\d+)\.xml$/)[1];
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, id === "1" ? 10 : 500);
        init.signal.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
      });
      return new Response(detail(id));
    },
  });
  const consumerIterator = consumerProvider.discoverProducts({ limit: 5, pageSize: 1, concurrency: 3, signal: consumerController.signal })[Symbol.asyncIterator]();
  const firstConsumerPage = await consumerIterator.next();
  assert.strictEqual(firstConsumerPage.done, false);
  consumerController.abort(new Error("consumer cleanup"));
  const requestsAtCancellation = consumerRequests;
  await assert.rejects(consumerIterator.throw(new Error("consumer failure before acknowledgment")), /consumer failure/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(consumerRequests, requestsAtCancellation);

  const cancellationController = new AbortController();
  const cancellationTimeline = [];
  let cancellationRequests = 0;
  let cancellationClosed = false;
  const cancellationProvider = new OpenIcecatProvider({
    username: "u",
    password: "p",
    fetcher: async (url, init) => {
      if (String(url).endsWith(".index.xml.gz")) return new Response(index);
      const id = String(url).match(/\/(\d+)\.xml$/)[1];
      const request = { id, position: Number(id), started: true, activeAtAbort: false, signalAbortedAtAbort: false, abortEvent: false, settled: false, settlement: null };
      cancellationRequests += 1;
      cancellationTimeline.push(request);
      if (cancellationClosed) throw new Error("request started after cancellation");
      await new Promise((resolve, reject) => {
        const abort = () => {
          request.activeAtAbort = true;
          request.signalAbortedAtAbort = init.signal.aborted;
          request.abortEvent = true;
          request.settlement = "abort";
          request.settled = true;
          reject(init.signal.reason);
        };
        init.signal.addEventListener("abort", abort, { once: true });
      });
      request.settlement = "success";
      request.settled = true;
      return new Response(detail(id));
    },
  });
  const cancellationPending = (async () => {
    for await (const page of cancellationProvider.discoverProducts({ limit: 5, concurrency: 3, parserFeedChars: 4096, signal: cancellationController.signal })) void page;
  })();
  while (cancellationRequests < 3) await new Promise((resolve) => setImmediate(resolve));
  cancellationClosed = true;
  const activeBeforeCancellation = cancellationTimeline.filter((request) => !request.settled);
  assert.strictEqual(activeBeforeCancellation.length, 3);
  cancellationController.abort(new Error("multi-active-cancel"));
  await assert.rejects(cancellationPending, /multi-active-cancel/);
  assert.strictEqual(cancellationTimeline.length, 3);
  assert.strictEqual(cancellationTimeline.every((request) => request.activeAtAbort && request.signalAbortedAtAbort && request.abortEvent && request.settled && request.settlement === "abort"), true);
  assert.strictEqual(cancellationRequests, 3);

  const mixedCancellationController = new AbortController();
  const mixedCancellationTimeline = [];
  const mixedCancellationProvider = new OpenIcecatProvider({
    username: "u",
    password: "p",
    fetcher: async (url, init) => {
      if (String(url).endsWith(".index.xml.gz")) return new Response(index, { headers: { etag: "mixed-cancel-snapshot" } });
      const id = String(url).match(/\/(\d+)\.xml$/)[1];
      const request = { id, started: true, completed: false, aborted: false };
      mixedCancellationTimeline.push(request);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, id === "1" ? 15 : id === "2" ? 1 : 1000);
        init.signal.addEventListener("abort", () => { clearTimeout(timer); request.aborted = true; reject(init.signal.reason); }, { once: true });
      });
      request.completed = true;
      return new Response(detail(id));
    },
  });
  const mixedCancellationIterator = mixedCancellationProvider.discoverProducts({ limit: 5, pageSize: 1, concurrency: 3, parserFeedChars: 4096, signal: mixedCancellationController.signal })[Symbol.asyncIterator]();
  const mixedFirstPage = await mixedCancellationIterator.next();
  assert.strictEqual(mixedFirstPage.done, false);
  assert.deepStrictEqual(mixedFirstPage.value.records.map((record) => record.sourceExternalId), ["1"]);
  assert.strictEqual(mixedFirstPage.value.checkpoint.acknowledgedCursor, undefined);
  assert.strictEqual(mixedCancellationTimeline.length >= 4, true);
  assert.strictEqual(mixedCancellationTimeline.some((request) => request.completed && request.id === "2"), true, JSON.stringify(mixedCancellationTimeline));
  assert.strictEqual(mixedCancellationTimeline.filter((request) => !request.completed).length >= 2, true, JSON.stringify(mixedCancellationTimeline));
  const mixedRequestsAtCancellation = mixedCancellationTimeline.length;
  mixedCancellationController.abort(new Error("mixed-consumer-failure"));
  await assert.rejects(mixedCancellationIterator.throw(new Error("mixed-consumer-failure")), /mixed-consumer-failure/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(mixedCancellationTimeline.filter((request) => request.aborted).length >= 2, true, JSON.stringify(mixedCancellationTimeline));
  assert.strictEqual(mixedCancellationTimeline.length, mixedRequestsAtCancellation);

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
