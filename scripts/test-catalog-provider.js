#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

async function main() {
  const provider = await import("../lib/catalogProviders.ts");
  const acquisition = await import("../lib/catalogAcquisition.ts");
  const { OpenIcecatProvider, parseIcecatXml, normalizeIcecatProduct, mapIcecatCategory, assertProviderSupports, processDiscoveredPages } = provider;
  const fixture = fs.readFileSync(path.join(__dirname, "__fixtures__", "catalog-acquisition", "open-icecat-products.xml"), "utf8");
  const indexFixture = `<?xml version="1.0" encoding="UTF-8"?>
<ICECAT-interface>
  <file generated="2026-01-01T00:00:00Z">
    <Product Product_ID="1001" Brand="Example Audio" Supplier_id="42" Prod_ID="WH1000XM5/B" Model_Name="WH-1000XM5" On_Market="1" Updated="2026-01-01T00:00:00Z" Catid="123" Quality="1" Country="US" EAN_UPC="4548736131133" />
    <Product Product_ID="1002" Brand="Example Audio" Supplier_id="42" Prod_ID="EA-DS1" Model_Name="Desk Speaker" On_Market="0" Updated="2026-01-02T00:00:00Z" Catid="456" Quality="3" Country="DE" EAN_UPC="1234567890123" />
    <Product Product_ID="1003" Brand="Example Audio" Supplier_id="99" Prod_ID="XLR-100" Model_Name="XLR Controller" On_Market="1" Updated="2026-01-03T00:00:00Z" Catid="999" Quality="2" Country="US" EAN_UPC="" />
  </file>
</ICECAT-interface>`;
  const first = normalizeIcecatProduct(parseIcecatXml(fixture));
  assert.deepStrictEqual(new OpenIcecatProvider({ username: "u", password: "p" }).capabilities, { lookup: true, discovery: true });

  assert.strictEqual(first.sourceExternalId, "icecat-1001");
  assert.strictEqual(first.brand, "Sony");
  assert.strictEqual(first.modelNumber, "WH-1000XM5");
  assert.strictEqual(first.mpn, "WH1000XM5/B");
  assert.strictEqual(first.gtin, "4548736131133");
  assert.strictEqual(first.subcategory, "Headphones");
  assert.deepStrictEqual(first.aliases, [], "Icecat marketing text must not become aliases");
  assert.strictEqual(first.raw.providerProductId, "icecat-1001");

  const unmapped = normalizeIcecatProduct(parseIcecatXml(fixture.replace("icecat-1001", "icecat-1003").replace("Sony", "Example Audio").replace("WH-1000XM5", "Desk Speaker").replace("WH1000XM5/B", "EA-DS1").replace("Headphones", "Unknown")));
  assert.strictEqual(unmapped.category, null);
  assert.strictEqual(unmapped.subcategory, null);
  assert.strictEqual(unmapped.raw.sourceCategory, "Unknown");
  assert.strictEqual(mapIcecatCategory("Headphones").category, "Electronics");
  assert.strictEqual(mapIcecatCategory("Unknown"), null);

  const missingOptional = normalizeIcecatProduct({ Product_ID: "icecat-1004", Brand: "Brand", Name: "Product" });
  assert.strictEqual(missingOptional.gtin, null);
  assert.strictEqual(missingOptional.sourceUrl, null);
  assert.throws(() => normalizeIcecatProduct({ Product_ID: "bad", Brand: "Brand" }), /product name/);
  assert.throws(() => parseIcecatXml("<broken>"), /no products|Unexpected end|Invalid/);

  let calls = 0;
  const mockProvider = new OpenIcecatProvider({
    username: "user",
    password: "password",
    baseUrl: "https://example.test/api",
    productCodes: [],
    fetcher: async (url) => {
      calls += 1;
      assert.match(url, /productcode=CODE-%5B0-9%5D/);
      return new Response(fixture);
    },
  });
  const fetched = await mockProvider.fetchProducts({ productCodes: ["CODE-[0-9]", "CODE-2"], limit: 1, pages: 1 });
  assert.strictEqual(fetched.fetched, 1);
  assert.strictEqual(fetched.records.length, 1);
  assert.strictEqual(calls, 1);

  const partialProvider = new OpenIcecatProvider({ username: "u", password: "p", fetcher: async () => { throw new Error("provider unavailable"); } });
  const partial = await partialProvider.fetchProducts({ productCodes: ["A", "B"], limit: 2 });
  assert.strictEqual(partial.records.length, 0);
  assert.strictEqual(partial.errors.length, 2);
  await assert.rejects(() => new OpenIcecatProvider().fetchProducts({ productCodes: ["A"] }), /credentials/);
  await assert.rejects(() => new OpenIcecatProvider({ username: "u", password: "p" }).fetchProducts({ limit: 10 }), /unbounded crawl/);
  await testIcecatAuthentication(OpenIcecatProvider, fixture, indexFixture);
  const discoveryProviderInstance = new OpenIcecatProvider({ username: "u", password: "p", fetcher: async () => new Response(indexFixture) });
  const discoveryRecords = [];
  for await (const page of discoveryProviderInstance.discoverProducts({ mode: "initial", limit: 2, pageSize: 1, brand: "Sony" })) {
    discoveryRecords.push(...page.records);
    assert.ok(page.records.length <= 1);
    assert.ok(page.nextCursor === null || typeof page.nextCursor === "string");
  }
  assert.strictEqual(discoveryRecords.length, 0, "brand filter should drop records when the brand does not match the index snapshot");

  const openIcecatDiscovery = new OpenIcecatProvider({
    username: "u",
    password: "p",
    fetcher: async () => new Response(indexFixture),
  });
  const dailyDiscoveryPages = [];
  for await (const page of openIcecatDiscovery.discoverProducts({ mode: "daily", limit: 2, pageSize: 1, updatedSince: "2026-01-02T00:00:00Z" })) {
    dailyDiscoveryPages.push(page);
  }
  assert.strictEqual(dailyDiscoveryPages.length, 2);
  assert.strictEqual(dailyDiscoveryPages[0].records[0].sourceExternalId, "1002");
  assert.strictEqual(dailyDiscoveryPages[1].records[0].sourceExternalId, "1003");
  assert.strictEqual(dailyDiscoveryPages[0].records[0].brand, "Example Audio");

  await testLargeStreamingDiscovery(OpenIcecatProvider);
  await testTruncatedXmlFailure(OpenIcecatProvider);
  await testMalformedDiscoveryRecord(OpenIcecatProvider);

  const icecatCliSource = fs.readFileSync(path.join(__dirname, "catalog-acquire-icecat.js"), "utf8");
  assert.match(icecatCliSource, /processDiscoveredPages\(provider, discoveryOptions, async \(page\)/, "discovery CLI must process one page at a time");
  assert.doesNotMatch(icecatCliSource, /const discoveryPages = \[\]/, "discovery CLI must not retain every page");
  assert.match(icecatCliSource, /acquireFromRecords\(pageRecords, canonicalCatalog/, "each discovery page must enter the existing acquisition pipeline immediately");

  assert.doesNotThrow(() => assertProviderSupports(new OpenIcecatProvider({ username: "u", password: "p" }), "discovery"));

  const discoveredRecord = { sourceExternalId: "discovered-1", brand: "Brand", productName: "Discovered Product", raw: { source: "mock-discovery" } };
  const discoveryProvider = {
    capabilities: { lookup: false, discovery: true },
    normalizeProduct: (raw) => raw,
    getSourceMetadata: () => ({ name: "Mock Catalog", type: "external-provider", baseUrl: "https://example.test", metadata: {} }),
    async *discoverProducts(options) {
      assert.strictEqual(options.limit, 2);
      yield { records: [discoveredRecord], nextCursor: "cursor-2", done: false, errors: [], checkpoint: { cursor: "cursor-2" } };
      yield { records: [{ ...discoveredRecord, sourceExternalId: "discovered-2" }], nextCursor: null, done: true, errors: [] };
    },
  };
  assertProviderSupports(discoveryProvider, "discovery");
  const discoveryPages = [];
  await processDiscoveredPages(discoveryProvider, { limit: 2, pageSize: 1 }, async (page) => {
    discoveryPages.push(page);
    const pageRun = await acquisition.acquireFromRecords(page.records.map((record) => discoveryProvider.normalizeProduct(record)), [], {}, { apply: false });
    assert.strictEqual(pageRun.persistence.length, 0);
  });
  assert.strictEqual(discoveryPages.length, 2);
  assert.strictEqual(discoveryPages[0].checkpoint.cursor, "cursor-2");

  const bothProvider = { ...discoveryProvider, capabilities: { lookup: true, discovery: true }, lookupProducts: async () => ({ records: [], errors: [], fetched: 0, pages: 0 }) };
  assertProviderSupports(bothProvider, "lookup");
  assertProviderSupports(bothProvider, "discovery");

  console.log("Catalog provider fixture tests passed.");
}

async function testIcecatAuthentication(OpenIcecatProvider, productFixture, indexFixture) {
  const token = "fixture-api-token-never-expose";
  const previousToken = process.env.ICECAT_API_TOKEN;
  let discoveryHeaders;
  let discoveryCheckpoint;
  try {
    process.env.ICECAT_API_TOKEN = token;
    const environmentTokenProvider = new OpenIcecatProvider({
      username: "basic-user",
      password: "basic-password",
      fetcher: async (_url, init) => {
        discoveryHeaders = new Headers(init.headers);
        return new Response(indexFixture, { headers: { ETag: '"fixture-etag"', "Last-Modified": "Tue, 01 Sep 2026 00:00:00 GMT" } });
      },
    });
    for await (const page of environmentTokenProvider.discoverProducts({ limit: 1, pageSize: 1 })) {
      discoveryCheckpoint = page.checkpoint;
    }
    assert.strictEqual(discoveryHeaders.get("Api-Token"), token, "ICECAT_API_TOKEN must produce the Api-Token header");
    assert.strictEqual(discoveryHeaders.has("Authorization"), false, "API token must take precedence over Basic authentication");
    assert.doesNotMatch(JSON.stringify(environmentTokenProvider.getSourceMetadata()), new RegExp(token));
    assert.doesNotMatch(JSON.stringify(discoveryCheckpoint), new RegExp(token));
  } finally {
    if (previousToken === undefined) delete process.env.ICECAT_API_TOKEN;
    else process.env.ICECAT_API_TOKEN = previousToken;
  }

  let lookupHeaders;
  const tokenLookupProvider = new OpenIcecatProvider({
    apiToken: token,
    username: "basic-user",
    password: "basic-password",
    fetcher: async (_url, init) => {
      lookupHeaders = new Headers(init.headers);
      return new Response(productFixture);
    },
  });
  await tokenLookupProvider.lookupProducts({ productCodes: ["TOKEN-CODE"], limit: 1 });
  assert.strictEqual(lookupHeaders.get("Api-Token"), token);
  assert.strictEqual(lookupHeaders.has("Authorization"), false);

  let basicHeaders;
  const basicProvider = new OpenIcecatProvider({
    username: "basic-user",
    password: "basic-password",
    fetcher: async (_url, init) => {
      basicHeaders = new Headers(init.headers);
      return new Response(productFixture);
    },
  });
  await basicProvider.lookupProducts({ productCodes: ["BASIC-CODE"], limit: 1 });
  assert.strictEqual(basicHeaders.get("Api-Token"), null);
  assert.strictEqual(basicHeaders.get("Authorization"), `Basic ${Buffer.from("basic-user:basic-password").toString("base64")}`);

  const rejectedProvider = new OpenIcecatProvider({
    apiToken: token,
    fetcher: async () => new Response("denied", { status: 401, statusText: "Unauthorized" }),
  });
  await assert.rejects(async () => {
    for await (const page of rejectedProvider.discoverProducts({ limit: 1 })) void page;
  }, (error) => {
    assert.doesNotMatch(String(error), new RegExp(token));
    return /Icecat HTTP 401 Unauthorized/.test(String(error));
  });

  console.log("testIcecatAuthentication passed.");
}

async function testTruncatedXmlFailure(OpenIcecatProvider) {
  const provider = new OpenIcecatProvider({
    username: "u",
    password: "p",
    fetcher: async () => new Response('<ICECAT-interface><file><Product Product_ID="1" Brand="Brand" Model_Name="Model" />'),
  });
  await assert.rejects(async () => {
    for await (const page of provider.discoverProducts({ limit: 20, pageSize: 10 })) void page;
  }, /unclosed tag|unexpected end|closed root|documents may contain only one root/i, "natural truncated XML must fail");
  console.log("testTruncatedXmlFailure passed.");
}

async function testMalformedDiscoveryRecord(OpenIcecatProvider) {
  const provider = new OpenIcecatProvider({
    username: "u",
    password: "p",
    fetcher: async () => new Response('<ICECAT-interface><file><Product Product_ID="bad" Model_Name="Missing brand"/><Product Product_ID="good" Brand="Brand" Model_Name="Good"/></file></ICECAT-interface>'),
  });
  const pages = [];
  for await (const page of provider.discoverProducts({ limit: 1, pageSize: 25 })) pages.push(page);
  assert.strictEqual(pages.flatMap((page) => page.records).length, 1);
  assert.strictEqual(pages.flatMap((page) => page.errors).length, 1);
  assert.match(pages[0].errors[0].message, /missing Product_ID, brand\/manufacturer, or product name/);
  console.log("testMalformedDiscoveryRecord passed.");
}

async function testLargeStreamingDiscovery(OpenIcecatProvider) {
  const TOTAL_AVAILABLE = 100000;
  const counters = {
    sourceRecordsGenerated: 0,
    parserRecordsSeen: 0,
    qualifyingRecords: 0,
    recordsEmitted: 0,
    pagesEmitted: 0,
    sourceCompletedNaturally: false,
    sourceCancelledEarly: false,
  };
  const encoder = new TextEncoder();
  let phase = "header";

  const source = new ReadableStream({
    pull(controller) {
      if (phase === "header") {
        phase = "records";
        controller.enqueue(encoder.encode("<ICECAT-interface><file>"));
        return;
      }
      if (counters.sourceRecordsGenerated < TOTAL_AVAILABLE) {
        counters.sourceRecordsGenerated += 1;
        const id = counters.sourceRecordsGenerated;
        controller.enqueue(encoder.encode(`<Product Product_ID="${id}" Brand="Synthetic" Model_Name="Model ${id}" Updated="2026-01-01T00:00:00Z"/>`));
        return;
      }
      counters.sourceCompletedNaturally = true;
      phase = "done";
      controller.enqueue(encoder.encode("</file></ICECAT-interface>"));
      controller.close();
    },
    cancel() {
      if (!counters.sourceCompletedNaturally) counters.sourceCancelledEarly = true;
    },
  });

  const provider = new OpenIcecatProvider({ username: "u", password: "p", fetcher: async () => new Response(source) });
  let generatedWhenFirstPageArrived = null;
  let generatedAfterSlowConsumer = null;
  let generatedAfterSecondWait = null;
  for await (const page of provider.discoverProducts({
    limit: 10,
    pageSize: 25,
    diagnostics: {
      onRecordSeen: () => { counters.parserRecordsSeen += 1; },
      onRecordQualified: () => { counters.qualifyingRecords += 1; },
    },
  })) {
    counters.pagesEmitted += 1;
    counters.recordsEmitted += page.records.length;
    if (counters.pagesEmitted === 1) {
      generatedWhenFirstPageArrived = counters.sourceRecordsGenerated;
      assert.strictEqual(counters.sourceCompletedNaturally, false, "page 1 must arrive before source completion");
      await new Promise((resolve) => setTimeout(resolve, 20));
      generatedAfterSlowConsumer = counters.sourceRecordsGenerated;
      await new Promise((resolve) => setTimeout(resolve, 20));
      generatedAfterSecondWait = counters.sourceRecordsGenerated;
      assert.strictEqual(generatedAfterSecondWait, generatedAfterSlowConsumer, "source generation must stop once native stream buffers fill");
      assert.ok(generatedAfterSlowConsumer < 1000, "slow-consumer read-ahead must remain bounded");
    }
  }

  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(counters.recordsEmitted, 10);
  assert.strictEqual(counters.pagesEmitted, 1);
  assert.ok(counters.sourceRecordsGenerated < 1000, "the 100,000-record source must stop generating early");
  assert.strictEqual(counters.sourceCompletedNaturally, false);
  assert.strictEqual(counters.sourceCancelledEarly, true);
  assert.strictEqual(counters.qualifyingRecords, 10);
  assert.ok(counters.parserRecordsSeen >= 10 && counters.parserRecordsSeen < 20);

  console.log("testLargeStreamingDiscovery, testFirstPageBeforeSourceEnd, testSlowConsumerBackpressure, and testIntentionalLimitTermination passed.");
  console.log("Large streaming discovery counters:", JSON.stringify({
    TOTAL_AVAILABLE,
    SOURCE_RECORDS_GENERATED: counters.sourceRecordsGenerated,
    PARSER_RECORDS_SEEN: counters.parserRecordsSeen,
    QUALIFYING_RECORDS: counters.qualifyingRecords,
    RECORDS_EMITTED: counters.recordsEmitted,
    PAGES_EMITTED: counters.pagesEmitted,
    SOURCE_COMPLETED_NATURALLY: counters.sourceCompletedNaturally,
    SOURCE_CANCELLED_EARLY: counters.sourceCancelledEarly,
    GENERATED_WHEN_FIRST_PAGE_ARRIVED: generatedWhenFirstPageArrived,
    GENERATED_AFTER_SLOW_CONSUMER: generatedAfterSlowConsumer,
    GENERATED_AFTER_SECOND_WAIT: generatedAfterSecondWait,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
