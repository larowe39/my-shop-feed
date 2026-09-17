#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { gzipSync } = require("zlib");

async function main() {
  const provider = await import("../lib/catalogProviders.ts");
  const acquisition = await import("../lib/catalogAcquisition.ts");
  const { OpenIcecatProvider, parseIcecatXml, parseIcecatProductsXml, normalizeIcecatProduct, mapIcecatCategory, assertProviderSupports, processDiscoveredPages, decodeIcecatDiscoveryCursor, encodeIcecatDiscoveryCursor } = provider;
  const fixture = fs.readFileSync(path.join(__dirname, "__fixtures__", "catalog-acquisition", "open-icecat-products.xml"), "utf8");
  const indexFixture = fs.readFileSync(path.join(__dirname, "__fixtures__", "catalog-acquisition", "open-icecat-files-index.xml"), "utf8");
  const first = normalizeIcecatProduct(parseIcecatXml(fixture));
  assert.deepStrictEqual(new OpenIcecatProvider({ username: "u", password: "p" }).capabilities, { lookup: true, discovery: true });

  assert.strictEqual(first.sourceExternalId, "1399");
  assert.strictEqual(first.brand, "HP");
  assert.strictEqual(first.productName, "HP Cartouche d'encre cyan 80 175-ml print head");
  assert.strictEqual(first.modelNumber, "C4872A");
  assert.strictEqual(first.mpn, "C4872A");
  assert.strictEqual(first.gtin, null);
  assert.strictEqual(first.imageUrl, "https://images.icecat.biz/img/gallery/1399.jpg");
  assert.strictEqual(first.subcategory, null);
  assert.deepStrictEqual(first.raw.externalCategory, { id: null, name: "Printers", path: null });
  assert.deepStrictEqual(first.aliases, [], "Icecat marketing text must not become aliases");
  assert.strictEqual(first.raw.providerProductId, "1399");
  assert.deepStrictEqual(first.raw.supplier, { id: "1", name: "HP" });
  assert.deepStrictEqual(first.raw.brandProductCodes, ["C4872A#018"]);

  const unmapped = normalizeIcecatProduct(parseIcecatProductsXml(fixture)[1]);
  assert.strictEqual(unmapped.category, null);
  assert.strictEqual(unmapped.subcategory, null);
  assert.strictEqual(unmapped.raw.sourceCategory, "Unmapped Icecat Category");
  assert.deepStrictEqual(unmapped.raw.externalCategory, { id: null, name: "Unmapped Icecat Category", path: null });
  assert.strictEqual(mapIcecatCategory("Headphones").category, "Electronics");
  assert.strictEqual(mapIcecatCategory("Unknown"), null);

  const missingOptional = normalizeIcecatProduct({ Product_ID: "icecat-1004", Brand: "Brand", Name: "Product" });
  assert.strictEqual(missingOptional.gtin, null);
  assert.strictEqual(missingOptional.sourceUrl, null);
  assert.throws(() => normalizeIcecatProduct({ Product_ID: "bad", Brand: "Brand" }), /product title\/name/);
  assert.throws(() => parseIcecatXml("<broken>"), /no products|Unexpected end|Invalid/);

  const titleFallback = normalizeIcecatProduct({
    ID: "title-1",
    GeneratedIntTitle: "Generated title",
    Title: "Title",
    IntName: "International name",
    Name: "Name",
    LocalName: "",
    Prod_id: "TITLE-MPN",
    Supplier: [{ ID: "7", Name: "Explicit Brand" }, { ID: "7", Name: "Explicit Brand" }],
  });
  assert.strictEqual(titleFallback.productName, "Generated title");
  assert.strictEqual(titleFallback.brand, "Explicit Brand");
  assert.strictEqual(titleFallback.mpn, "TITLE-MPN");
  assert.strictEqual(titleFallback.modelNumber, "TITLE-MPN");
  assert.strictEqual(normalizeIcecatProduct({ ID: "title-2", Title: "Title", IntName: "International", Name: "Name", Prod_id: "M", Supplier: { Name: "Brand" } }).productName, "Title");
  assert.strictEqual(normalizeIcecatProduct({ ID: "title-3", IntName: "International", Name: "Name", Prod_id: "M", Supplier: { Name: "Brand" } }).productName, "International");
  assert.strictEqual(normalizeIcecatProduct({ ID: "title-4", Name: "Name", Prod_id: "M", Supplier: { Name: "Brand" } }).productName, "Name");
  assert.throws(() => normalizeIcecatProduct({ ID: "conflict", Name: "HP in free text", Prod_id: "M", Supplier: [{ Name: "HP" }, { Name: "Canon" }] }), /conflicting Supplier names/);
  const nestedSupplierConflict = normalizeIcecatProduct({
    ID: "nested-supplier-1",
    Name: "HP Tray",
    Prod_id: "M",
    Supplier: [{ ID: "1", Name: "HP" }],
    RelatedProducts: [{ Supplier: [{ ID: "2", Name: "Neomounts" }] }],
  });
  assert.strictEqual(nestedSupplierConflict.brand, "HP");
  assert.strictEqual(nestedSupplierConflict.productName, "HP Tray");
  assert.throws(() => normalizeIcecatProduct({ ID: "ambiguous-primary", Name: "Ambiguous Tray", Prod_id: "M", Supplier: [{ Name: "HP" }, { Name: "HPE" }] }), /conflicting Supplier names/);
  assert.throws(() => normalizeIcecatProduct({ ID: "no-brand", Title: "HP title text", Prod_id: "M" }), /explicit Supplier\/brand\/manufacturer/);
  console.log("testLiveProductSheetIdentity passed.");

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
  const credentialEnv = ["ICECAT_API_TOKEN", "ICECAT_USERNAME", "ICECAT_PASSWORD"];
  const savedCredentialEnv = Object.fromEntries(credentialEnv.map((name) => [name, process.env[name]]));
  try {
    for (const name of credentialEnv) delete process.env[name];
    await assert.rejects(() => new OpenIcecatProvider().fetchProducts({ productCodes: ["A"] }), /credentials/);
    await assert.rejects(
      () => new OpenIcecatProvider({ username: "basic-user" }).fetchProducts({ productCodes: ["A"] }),
      /credentials/
    );
    await assert.rejects(
      () => new OpenIcecatProvider({ username: "basic-user", password: "   " }).fetchProducts({ productCodes: ["A"] }),
      /credentials/
    );
  } finally {
    for (const name of credentialEnv) {
      if (savedCredentialEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedCredentialEnv[name];
    }
  }
  await testExplicitAuthenticationHeaders(OpenIcecatProvider, fixture);
  await assert.rejects(() => new OpenIcecatProvider({ username: "u", password: "p" }).fetchProducts({ limit: 10 }), /unbounded crawl/);
  await testIcecatAuthentication(OpenIcecatProvider, fixture, indexFixture);
  await testIcecatTransportDecoding(OpenIcecatProvider, fixture, indexFixture);
  await testDiscoveryStreamFailures(OpenIcecatProvider);
  const discoveryProviderInstance = new OpenIcecatProvider({ username: "u", password: "p", fetcher: makeIcecatDiscoveryFetcher(indexFixture) });
  const discoveryRecords = [];
  for await (const page of discoveryProviderInstance.discoverProducts({ mode: "initial", limit: 2, pageSize: 1, brand: "Sony" })) {
    discoveryRecords.push(...page.records);
    assert.ok(page.records.length <= 1);
    assert.ok(page.nextCursor === null || typeof page.nextCursor === "string");
  }
  assert.strictEqual(discoveryRecords.length, 1, "brand filter must use bounded product-detail enrichment");
  assert.strictEqual(discoveryRecords[0].sourceExternalId, "1001");

  const openIcecatDiscovery = new OpenIcecatProvider({
    username: "u",
    password: "p",
    fetcher: makeIcecatDiscoveryFetcher(indexFixture),
  });
  const dailyDiscoveryPages = [];
  for await (const page of openIcecatDiscovery.discoverProducts({ mode: "daily", limit: 2, pageSize: 1, updatedSince: "2026-09-16T06:02:02Z", concurrency: 2 })) {
    dailyDiscoveryPages.push(page);
  }
  assert.strictEqual(dailyDiscoveryPages.length, 2);
  assert.strictEqual(dailyDiscoveryPages[0].records[0].sourceExternalId, "1002");
  assert.strictEqual(dailyDiscoveryPages[1].records[0].sourceExternalId, "1003");
  assert.strictEqual(dailyDiscoveryPages[0].records[0].brand, "Example Audio");
  assert.strictEqual(dailyDiscoveryPages[0].records[0].sourceUrl, "https://data.icecat.biz/export/freexml/INT/1002.xml");
  assert.strictEqual(dailyDiscoveryPages[0].records[0].gtin, "1234567890123");
  assert.deepStrictEqual(dailyDiscoveryPages[1].records[0].countryMarkets, ["US"]);
  assert.strictEqual(dailyDiscoveryPages[0].records[0].raw.supplierId, "42");
  assert.strictEqual(dailyDiscoveryPages[0].records[0].updated, "2026-09-16T06:02:02Z");
  assert.strictEqual(dailyDiscoveryPages[0].records[0].dateAdded, "2020-01-02T03:04:05Z");
  assert.strictEqual(dailyDiscoveryPages[0].records[0].imageUrl, "https://images.icecat.biz/img/gallery/detail-1002.jpg");
  assert.strictEqual(dailyDiscoveryPages[0].records[0].raw.record.HighPic, "https://images.icecat.biz/img/gallery/1002.jpg", "index HighPic must remain in raw provenance");

  const enrichedCandidate = normalizeIcecatProduct(dailyDiscoveryPages[0].records[0]);
  assert.strictEqual(enrichedCandidate.imageUrl, "https://images.icecat.biz/img/gallery/detail-1002.jpg", "detail HighPic must be preferred over index HighPic");
  assert.deepStrictEqual(enrichedCandidate.raw.externalCategory, { id: "456", name: "Headphones", path: null });
  const indexFallbackCandidate = normalizeIcecatProduct({
    sourceExternalId: "fallback-1",
    brand: "Brand",
    productName: "Product",
    modelNumber: "MODEL-1",
    mpn: "MODEL-1",
    gtin: null,
    sourceUrl: "https://data.icecat.biz/export/freexml/INT/fallback-1.xml",
    category: "846",
    subcategory: null,
    onMarket: true,
    country: null,
    updated: null,
    supplierId: null,
    dateAdded: null,
    imageUrl: "https://images.icecat.biz/img/gallery/index-fallback.jpg",
    countryMarkets: [],
    raw: { provider: "open-icecat", categoryId: "846" },
  });
  assert.strictEqual(indexFallbackCandidate.imageUrl, "https://images.icecat.biz/img/gallery/index-fallback.jpg");

  const filteredRecords = [];
  const filteredProvider = new OpenIcecatProvider({ username: "u", password: "p", fetcher: makeIcecatDiscoveryFetcher(indexFixture) });
  for await (const page of filteredProvider.discoverProducts({
    limit: 10,
    category: "456",
    country: "DE",
    onMarket: false,
    updatedSince: "2026-09-16T06:02:02Z",
  })) filteredRecords.push(...page.records);
  assert.deepStrictEqual(filteredRecords.map((record) => record.sourceExternalId), ["1002"]);
  console.log("testLiveFilesIndexFilters passed.");

  const liveSchemaRecord = discoveryRecords[0];
  assert.strictEqual(liveSchemaRecord.brand, "Sony", "brand must come from product detail enrichment");
  assert.notStrictEqual(liveSchemaRecord.brand, "HPI SOURCING", "alternate M_Prod_ID supplier name must not become canonical brand");
  assert.deepStrictEqual(liveSchemaRecord.raw.alternateManufacturerPartNumbers[1], { value: "ALT-1001", supplierId: "37985", supplierName: "HPI SOURCING" });
  console.log("testLiveFilesIndexSchema passed.");

  await testFilesIndexSchemaMismatch(OpenIcecatProvider);
  await testUsableRecordLimitAfterEnrichmentFailure(OpenIcecatProvider);
  await testEnrichmentIdentityMismatch(OpenIcecatProvider);

  await testLargeStreamingDiscovery(OpenIcecatProvider);
  await testTruncatedXmlFailure(OpenIcecatProvider);
  await testMalformedDiscoveryRecord(OpenIcecatProvider);
  await testV2ContinuationContract(OpenIcecatProvider, decodeIcecatDiscoveryCursor, encodeIcecatDiscoveryCursor);

  const icecatCliSource = fs.readFileSync(path.join(__dirname, "catalog-acquire-icecat.js"), "utf8");
  assert.match(icecatCliSource, /acquireDiscoveredProducts\(provider, discoveryOptions/, "discovery CLI must use the single-run streaming acquisition orchestrator");
  assert.match(icecatCliSource, /concurrency: options\.concurrency/, "discovery CLI must forward configured concurrency");
  assert.match(icecatCliSource, /MAX ACTIVE DETAIL REQUESTS/, "discovery CLI must expose provider concurrency metrics");
  assert.doesNotMatch(icecatCliSource, /const discoveryPages = \[\]/, "discovery CLI must not retain every page");
  const acquisitionSource = fs.readFileSync(path.join(__dirname, "..", "lib", "catalogAcquisition.ts"), "utf8");
  assert.match(acquisitionSource, /processDiscoveredPages\(provider, providerDiscoveryOptions, async \(page\)/, "the discovery orchestrator must process provider pages incrementally");
  assert.match(acquisitionSource, /acquireFromRecords\(pageRecords, canonicalCatalog/, "each discovery page must enter the acquisition pipeline immediately");

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

async function testExplicitAuthenticationHeaders(OpenIcecatProvider, fixture) {
  const requests = [];
  const fetcher = async (_url, init) => {
    requests.push(new Headers(init.headers));
    return new Response(fixture);
  };

  await new OpenIcecatProvider({ apiToken: " token-value ", username: "ignored", password: "ignored", fetcher }).lookupProducts({ productCodes: ["TOKEN"], limit: 1 });
  assert.strictEqual(requests.at(-1).get("Api-Token"), "token-value");
  assert.strictEqual(requests.at(-1).has("Authorization"), false, "API token must take precedence over Basic credentials");

  await new OpenIcecatProvider({ username: " basic-user ", password: " basic-password ", fetcher }).lookupProducts({ productCodes: ["BASIC"], limit: 1 });
  assert.strictEqual(requests.at(-1).get("Authorization"), `Basic ${Buffer.from("basic-user:basic-password").toString("base64")}`);
  assert.strictEqual(requests.at(-1).has("Api-Token"), false);
}

function makeIcecatDiscoveryFetcher(indexFixture, inspectRequest) {
  return async (url, init) => {
    inspectRequest?.(url, init);
    if (String(url).endsWith(".index.xml.gz")) return new Response(indexFixture);
    const productId = String(url).match(/\/(\d+)\.xml$/)?.[1] ?? "1";
    const details = {
      "1001": { brand: "Sony", name: "WH-1000XM5", mpn: "WH1000XM5/B", gtin: "4548736131133", highPic: "https://images.icecat.biz/img/gallery/detail-1001.jpg" },
      "1002": { brand: "Example Audio", name: "Desk Speaker", mpn: "EA-DS1", gtin: "1234567890123", highPic: "https://images.icecat.biz/img/gallery/detail-1002.jpg" },
      "1003": { brand: "Example Controls", name: "XLR Controller", mpn: "XLR-100", gtin: "", highPic: "https://images.icecat.biz/img/gallery/detail-1003.jpg" },
    }[productId] ?? { brand: "Synthetic", name: `Model ${productId}`, mpn: `MPN-${productId}`, gtin: "" };
    return new Response(`<?xml version="1.0"?><ICECAT-interface><Product ID="${productId}" Name="${details.name}" IntName="${details.name}" Title="${details.name}" GeneratedIntTitle="${details.name}" LocalName="" Prod_id="${details.mpn}" EAN_UPC="${details.gtin}" HighPic="${details.highPic}"><Supplier ID="supplier-${productId}" Name="${details.brand}"/><Supplier ID="supplier-${productId}" Name="${details.brand}"/><Category Name="Headphones"/><Identifiers><Identifier Type="BrandProductCode" Value="${details.mpn}"/></Identifiers></Product></ICECAT-interface>`);
  };
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
      fetcher: makeIcecatDiscoveryFetcher(indexFixture, (_url, init) => {
        discoveryHeaders = new Headers(init.headers);
      }),
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

async function testIcecatTransportDecoding(OpenIcecatProvider, productFixture, indexFixture) {
  const plainProductHeaders = { "Content-Type": "application/xml; charset=UTF-8" };
  const detailFetcher = makeIcecatDiscoveryFetcher(indexFixture);
  let plainProductRequestSeen = false;
  const compressedIndexProvider = new OpenIcecatProvider({
    username: "u",
    password: "p",
    fetcher: async (url, init) => {
      if (String(url).endsWith(".index.xml.gz")) {
        return new Response(gzipSync(indexFixture), { headers: { "Content-Type": "application/x-gzip-compressed" } });
      }
      plainProductRequestSeen = true;
      const response = await detailFetcher(url, init);
      return new Response(await response.arrayBuffer(), { headers: plainProductHeaders });
    },
  });
  const discovered = [];
  for await (const page of compressedIndexProvider.discoverProducts({ limit: 1, pageSize: 1 })) discovered.push(...page.records);
  assert.strictEqual(discovered.length, 1, "gzip files.index transport must stream and enrich successfully");
  assert.strictEqual(plainProductRequestSeen, true);

  const plainLookupProvider = new OpenIcecatProvider({
    username: "u",
    password: "p",
    fetcher: async () => new Response(productFixture, { headers: plainProductHeaders }),
  });
  const plainLookup = await plainLookupProvider.lookupProducts({ productCodes: ["PLAIN-XML"], limit: 1 });
  assert.strictEqual(plainLookup.records.length, 1);
  assert.strictEqual(plainLookup.errors.length, 0, "plain product XML must not produce incorrect header check");

  const gzipLookupProvider = new OpenIcecatProvider({
    username: "u",
    password: "p",
    fetcher: async () => new Response(gzipSync(productFixture), { headers: { "Content-Type": "application/gzip" } }),
  });
  const gzipLookup = await gzipLookupProvider.lookupProducts({ productCodes: ["GZIP-XML"], limit: 1 });
  assert.strictEqual(gzipLookup.records.length, 1, "actual gzip magic bytes must be decompressed");

  const transparentLookupProvider = new OpenIcecatProvider({
    username: "u",
    password: "p",
    fetcher: async () => new Response(productFixture, { headers: { ...plainProductHeaders, "Content-Encoding": "gzip" } }),
  });
  const transparentLookup = await transparentLookupProvider.lookupProducts({ productCodes: ["TRANSPARENT-GZIP"], limit: 1 });
  assert.strictEqual(transparentLookup.records.length, 1);
  assert.strictEqual(transparentLookup.errors.length, 0, "already-decoded XML must not be gunzipped again when a gzip header remains");

  console.log("testIcecatTransportDecoding passed.");
}

async function testTruncatedXmlFailure(OpenIcecatProvider) {
  const provider = new OpenIcecatProvider({
    username: "u",
    password: "p",
    fetcher: async () => new Response('<ICECAT-interface><files.index><file path="export/freexml/INT/1.xml" Product_ID="1" Model_Name="Model">'),
  });
  await assert.rejects(async () => {
    for await (const page of provider.discoverProducts({ limit: 20, pageSize: 10 })) void page;
  }, /unclosed tag|unexpected end|closed root|documents may contain only one root/i, "natural truncated XML must fail");
  console.log("testTruncatedXmlFailure passed.");
}

async function testFilesIndexSchemaMismatch(OpenIcecatProvider) {
  const provider = new OpenIcecatProvider({
    username: "u",
    password: "p",
    fetcher: makeIcecatDiscoveryFetcher('<ICECAT-interface><files.index><file Unknown="value"/></files.index></ICECAT-interface>'),
  });
  await assert.rejects(async () => {
    for await (const page of provider.discoverProducts({ limit: 1 })) void page;
  }, /files\.index schema mismatch: file elements were present but none could be parsed/);
  console.log("testFilesIndexSchemaMismatch passed.");
}

async function testUsableRecordLimitAfterEnrichmentFailure(OpenIcecatProvider) {
  const total = 50;
  const files = Array.from({ length: total }, (_, index) => {
    const id = index + 1;
    return `<file path="export/freexml/INT/${id}.xml" Product_ID="${id}" Prod_ID="MPN-${id}" Model_Name="Model ${id}"/>`;
  }).join("");
  const index = `<ICECAT-interface><files.index>${files}</files.index></ICECAT-interface>`;
  const detailFetcher = makeIcecatDiscoveryFetcher(index);
  let enrichmentAttempts = 0;
  const provider = new OpenIcecatProvider({
    username: "u",
    password: "p",
    fetcher: async (url, init) => {
      if (String(url).endsWith(".index.xml.gz")) return new Response(index);
      enrichmentAttempts += 1;
      if (enrichmentAttempts === 1) return new Response("missing", { status: 503, statusText: "Unavailable" });
      return detailFetcher(url, init);
    },
  });
  const records = [];
  const errors = [];
  for await (const page of provider.discoverProducts({ limit: 10, pageSize: 25, concurrency: 1 })) {
    records.push(...page.records);
    errors.push(...page.errors);
  }
  assert.strictEqual(records.length, 10, "limit must count usable enriched records, not attempted index records");
  assert.strictEqual(enrichmentAttempts, 11);
  assert.strictEqual(errors.length, 1);
  console.log("testUsableRecordLimitAfterEnrichmentFailure passed.");
}

async function testEnrichmentIdentityMismatch(OpenIcecatProvider) {
  const index = '<ICECAT-interface><files.index><file path="export/freexml/INT/1399.xml" Product_ID="1399" Prod_ID="C4872A" Model_Name="HP 80"/></files.index></ICECAT-interface>';
  const run = async (productXml) => {
    const provider = new OpenIcecatProvider({
      username: "u",
      password: "p",
      fetcher: async (url) => String(url).endsWith(".index.xml.gz") ? new Response(index) : new Response(productXml),
    });
    const records = [];
    const errors = [];
    for await (const page of provider.discoverProducts({ limit: 1, pageSize: 10 })) {
      records.push(...page.records);
      errors.push(...page.errors);
    }
    return { records, errors };
  };

  const idMismatch = await run('<ICECAT-interface><Product ID="1400" Prod_id="C4872A" GeneratedIntTitle="HP 80"><Supplier ID="1" Name="HP"/></Product></ICECAT-interface>');
  assert.strictEqual(idMismatch.records.length, 0);
  assert.match(idMismatch.errors[0].message, /identity mismatch: index Product_ID 1399 does not match product ID 1400/);
  assert.strictEqual(idMismatch.errors[0].retriable, false);

  const mpnMismatch = await run('<ICECAT-interface><Product ID="1399" Prod_id="OTHER" GeneratedIntTitle="HP 80"><Supplier ID="1" Name="HP"/></Product></ICECAT-interface>');
  assert.strictEqual(mpnMismatch.records.length, 0);
  assert.match(mpnMismatch.errors[0].message, /MPN mismatch: index Prod_ID C4872A does not match product Prod_id OTHER/);
  assert.strictEqual(mpnMismatch.errors[0].retriable, false);
  console.log("testEnrichmentIdentityMismatch passed.");
}

async function testDiscoveryStreamFailures(OpenIcecatProvider) {
  const uncaughtErrors = [];
  const onUncaughtException = (error) => { uncaughtErrors.push(error); };
  process.on("uncaughtException", onUncaughtException);
  try {
    const timeoutProvider = new OpenIcecatProvider({
      username: "u",
      password: "p",
      fetcher: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
    });
    await assert.rejects(async () => {
      for await (const page of timeoutProvider.discoverProducts({ limit: 1, requestTimeoutMs: 5 })) void page;
    }, (error) => {
      assert.strictEqual(error.name, "CatalogProviderRequestError");
      assert.strictEqual(error.code, "ICECAT_DISCOVERY_REQUEST_TIMEOUT");
      assert.strictEqual(error.retriable, true);
      return /timed out before response headers/.test(error.message);
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(uncaughtErrors, [], "request timeout must not emit an uncaught Readable error");

    const encoder = new TextEncoder();
    const progressingSource = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode("<ICECAT-interface><files.index>"));
        await new Promise((resolve) => setTimeout(resolve, 15));
        controller.enqueue(encoder.encode('<file path="export/freexml/INT/1.xml" Product_ID="1" Prod_ID="MPN-1" Model_Name="Model"/>'));
        await new Promise((resolve) => setTimeout(resolve, 15));
        controller.enqueue(encoder.encode("</files.index></ICECAT-interface>"));
        controller.close();
      },
    });
    const detailFetcher = makeIcecatDiscoveryFetcher("");
    const progressingProvider = new OpenIcecatProvider({
      username: "u",
      password: "p",
      fetcher: async (url, init) => String(url).endsWith(".index.xml.gz") ? new Response(progressingSource) : detailFetcher(url, init),
    });
    const progressingRecords = [];
    for await (const page of progressingProvider.discoverProducts({ limit: 2, pageSize: 1, requestTimeoutMs: 5, inactivityTimeoutMs: 25 })) progressingRecords.push(...page.records);
    assert.strictEqual(progressingRecords.length, 1, "an established slow stream must not be subject to the request timeout");

    const stalledSource = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("<ICECAT-interface><files.index>"));
      },
      cancel() {},
    });
    const stalledProvider = new OpenIcecatProvider({ username: "u", password: "p", fetcher: async () => new Response(stalledSource) });
    await assert.rejects(async () => {
      for await (const page of stalledProvider.discoverProducts({ limit: 2, requestTimeoutMs: 5, inactivityTimeoutMs: 5 })) void page;
    }, (error) => {
      assert.strictEqual(error.name, "CatalogProviderRequestError");
      assert.strictEqual(error.code, "ICECAT_DISCOVERY_INACTIVITY_TIMEOUT");
      assert.strictEqual(error.retriable, true);
      return /made no progress/.test(error.message);
    });

    const networkSource = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("<ICECAT-interface><files.index>"));
        controller.error(new Error("synthetic network interruption"));
      },
    });
    const networkProvider = new OpenIcecatProvider({ username: "u", password: "p", fetcher: async () => new Response(networkSource) });
    await assert.rejects(async () => {
      for await (const page of networkProvider.discoverProducts({ limit: 2 })) void page;
    }, /synthetic network interruption/);

    const corruptGzip = Buffer.from(gzipSync('<ICECAT-interface><files.index><file path="export/freexml/INT/1.xml" Product_ID="1" Prod_ID="MPN-1" Model_Name="Model"/></files.index></ICECAT-interface>'));
    corruptGzip[corruptGzip.length - 8] ^= 0xff;
    const gzipProvider = new OpenIcecatProvider({
      username: "u",
      password: "p",
      fetcher: async (url, init) => String(url).endsWith(".index.xml.gz") ? new Response(corruptGzip) : detailFetcher(url, init),
    });
    await assert.rejects(async () => {
      for await (const page of gzipProvider.discoverProducts({ limit: 2 })) void page;
    }, /incorrect data check|checksum/i);

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(uncaughtErrors, [], "network and gzip failures must remain handled promise rejections");
  } finally {
    process.off("uncaughtException", onUncaughtException);
  }
  console.log("testDiscoveryRequestTimeout, testDiscoveryInactivityTimeout, testSlowEstablishedStream, testNetworkStreamFailure, and testGzipFailure passed.");
}

async function testMalformedDiscoveryRecord(OpenIcecatProvider) {
  const provider = new OpenIcecatProvider({
    username: "u",
    password: "p",
    fetcher: makeIcecatDiscoveryFetcher('<ICECAT-interface><files.index><file Product_ID="bad" Model_Name="Missing path"/><file path="export/freexml/INT/1.xml" Product_ID="1" Prod_ID="MPN-1" Model_Name="Good"/></files.index></ICECAT-interface>'),
  });
  const pages = [];
  for await (const page of provider.discoverProducts({ limit: 1, pageSize: 25 })) pages.push(page);
  assert.strictEqual(pages.flatMap((page) => page.records).length, 1);
  assert.strictEqual(pages.flatMap((page) => page.errors).length, 1);
  assert.match(pages[0].errors[0].message, /missing Product_ID, Model_Name\/Prod_ID, or product XML path/);
  console.log("testMalformedDiscoveryRecord passed.");
}

async function testV2ContinuationContract(OpenIcecatProvider, decodeIcecatDiscoveryCursor, encodeIcecatDiscoveryCursor) {
  const index = '<ICECAT-interface><files.index>' + ["9", "10", "2"].map((id) => `<file path="export/freexml/INT/${id}.xml" Product_ID="${id}" Prod_ID="MPN-${id}" Model_Name="Model ${id}"/>`).join("") + '</files.index></ICECAT-interface>';
  const makeProvider = (headers = { etag: "fixture-snapshot" }, indexXml = index, indexBaseUrl) => new OpenIcecatProvider({
    username: "u",
    password: "p",
    indexBaseUrl,
    fetcher: async (url, init) => {
      if (String(url).endsWith(".index.xml.gz")) return new Response(indexXml, { headers });
      return makeIcecatDiscoveryFetcher(indexXml)(url, init);
    },
  });

  const uninterrupted = [];
  for await (const page of makeProvider().discoverProducts({ limit: 10, pageSize: 1 })) uninterrupted.push(...page.records.map((record) => record.sourceExternalId));

  const firstRun = [];
  let acknowledgedCursor;
  for await (const page of makeProvider().discoverProducts({ limit: 1, pageSize: 1 })) {
    firstRun.push(...page.records.map((record) => record.sourceExternalId));
    page.acknowledge();
    acknowledgedCursor = page.checkpoint.acknowledgedCursor;
  }
  assert.ok(String(acknowledgedCursor).startsWith("ic2."), "generated continuation must be an opaque v2 token");

  const resumed = [];
  for await (const page of makeProvider().discoverProducts({ limit: 10, pageSize: 1, cursor: acknowledgedCursor })) resumed.push(...page.records.map((record) => record.sourceExternalId));
  assert.deepStrictEqual(firstRun.concat(resumed), uninterrupted, "resumed output must equal uninterrupted output at the acknowledged boundary");
  assert.deepStrictEqual(uninterrupted, ["9", "10", "2"], "numeric and lexical product-ID ordering must not affect encounter order");

  const orderedIterator = makeProvider().discoverProducts({ limit: 3, pageSize: 1 })[Symbol.asyncIterator]();
  const pageOne = (await orderedIterator.next()).value;
  const pageTwo = (await orderedIterator.next()).value;
  assert.strictEqual(pageOne.nextCursor, null, "emission alone must not expose a recovery cursor");
  pageOne.acknowledge();
  assert.strictEqual(decodeIcecatDiscoveryCursor(pageOne.checkpoint.acknowledgedCursor).acknowledgedPosition, 1, "page one acknowledgment must remain page-local");
  assert.strictEqual(pageTwo.checkpoint.acknowledgedCursor, undefined, "later emission must not be acknowledged by page one");
  pageTwo.acknowledge();
  assert.strictEqual(decodeIcecatDiscoveryCursor(pageTwo.checkpoint.acknowledgedCursor).acknowledgedPosition, 2, "page two acknowledgment must advance exactly to page two");
  await orderedIterator.return();

  const repeatedIndex = '<ICECAT-interface><files.index>' + ["7", "7"].map((id) => `<file path="export/freexml/INT/7.xml" Product_ID="${id}" Prod_ID="MPN-${id}" Model_Name="Model ${id}"/>`).join("") + '</files.index></ICECAT-interface>';
  const repeatedIterator = makeProvider({ etag: "repeated-snapshot" }, repeatedIndex).discoverProducts({ limit: 2, pageSize: 1 })[Symbol.asyncIterator]();
  const repeatedOne = (await repeatedIterator.next()).value;
  const repeatedTwo = (await repeatedIterator.next()).value;
  repeatedOne.acknowledge();
  repeatedTwo.acknowledge();
  assert.strictEqual(decodeIcecatDiscoveryCursor(repeatedTwo.checkpoint.acknowledgedCursor).acknowledgedPosition, 2, "adjacent repeated identities must still use positional frontiers");
  await repeatedIterator.return();

  const failedConsumerIterator = makeProvider().discoverProducts({ limit: 3, pageSize: 1 })[Symbol.asyncIterator]();
  const unacknowledgedPage = (await failedConsumerIterator.next()).value;
  assert.strictEqual(unacknowledgedPage.checkpoint.acknowledgedCursor, undefined, "consumer failure before acknowledgment must leave no recovery cursor");
  await failedConsumerIterator.return();

  await assert.rejects(async () => {
    for await (const page of makeProvider().discoverProducts({ limit: 10, cursor: acknowledgedCursor, brand: "Changed filter" })) void page;
  }, /incompatible.*filters/i);
  const snapshotFirst = makeProvider({ etag: "snapshot-a", "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT", "content-length": "123" });
  let snapshotCursor;
  for await (const page of snapshotFirst.discoverProducts({ limit: 1, pageSize: 1 })) {
    page.acknowledge();
    snapshotCursor = page.checkpoint.acknowledgedCursor;
  }
  await assert.rejects(async () => {
    for await (const page of makeProvider({ etag: "snapshot-b" }).discoverProducts({ limit: 10, cursor: snapshotCursor })) void page;
  }, /snapshot does not match/i);
  await assert.rejects(async () => {
    for await (const page of makeProvider({ etag: "snapshot-a", "last-modified": "Tue, 02 Jan 2024 00:00:00 GMT", "content-length": "123" }).discoverProducts({ limit: 10, cursor: snapshotCursor })) void page;
  }, /snapshot does not match/i);
  await assert.rejects(async () => {
    for await (const page of makeProvider({ etag: "snapshot-a", "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT", "content-length": "456" }).discoverProducts({ limit: 10, cursor: snapshotCursor })) void page;
  }, /snapshot does not match/i);
  await assert.rejects(async () => {
    for await (const page of makeProvider({ etag: "snapshot-a" }, index, "https://other.example/export/freexml").discoverProducts({ limit: 10, cursor: snapshotCursor })) void page;
  }, /incompatible.*source/i);
  await assert.rejects(async () => {
    for await (const page of makeProvider().discoverProducts({ mode: "daily", limit: 10, cursor: snapshotCursor })) void page;
  }, /incompatible.*source/i);
  const changedParserToken = encodeIcecatDiscoveryCursor({ ...decodeIcecatDiscoveryCursor(snapshotCursor), parserVersion: "changed-parser" });
  await assert.rejects(async () => {
    for await (const page of makeProvider().discoverProducts({ limit: 10, cursor: changedParserToken })) void page;
  }, /incompatible.*parser/i);
  const missingEvidenceToken = encodeIcecatDiscoveryCursor({ ...decodeIcecatDiscoveryCursor(snapshotCursor), snapshot: { etag: null, lastModified: null, contentLength: null } });
  await assert.rejects(async () => {
    for await (const page of makeProvider().discoverProducts({ limit: 10, cursor: missingEvidenceToken })) void page;
  }, /Invalid.*continuation|snapshot evidence/i);
  const noEvidencePage = (await makeProvider({}).discoverProducts({ limit: 1, pageSize: 1 })[Symbol.asyncIterator]().next()).value;
  noEvidencePage.acknowledge();
  assert.strictEqual(noEvidencePage.checkpoint.acknowledgedCursor, undefined, "no snapshot evidence must not produce a recovery cursor");
  const lengthOnlyPage = (await makeProvider({ "content-length": "123" }).discoverProducts({ limit: 1, pageSize: 1 })[Symbol.asyncIterator]().next()).value;
  lengthOnlyPage.acknowledge();
  assert.strictEqual(lengthOnlyPage.checkpoint.acknowledgedCursor, undefined, "content length alone must not produce a recovery cursor");
  const malformedTokens = ["ic2.e30=", "ic2." + Buffer.from(JSON.stringify({ version: 2, provider: "open-icecat" })).toString("base64url")];
  for (const malformedToken of malformedTokens) await assert.rejects(async () => {
    for await (const page of makeProvider().discoverProducts({ limit: 10, cursor: malformedToken })) void page;
  }, /Invalid.*continuation|restart/i);
  await assert.rejects(async () => {
    for await (const page of makeProvider().discoverProducts({ limit: 10, cursor: "9|2026-09-16T00:00:00Z" })) void page;
  }, /Unsupported.*v2|restart/i);

  const errorIndex = '<ICECAT-interface><files.index><file Product_ID="bad" Model_Name="Missing path"/><file path="export/freexml/INT/2.xml" Product_ID="2" Prod_ID="MPN-2" Model_Name="Model 2"/></files.index></ICECAT-interface>';
  const errorProvider = makeProvider({ etag: "error-snapshot" }, errorIndex);
  const errorPages = [];
  for await (const page of errorProvider.discoverProducts({ limit: 1, pageSize: 1 })) {
    errorPages.push(page);
    page.acknowledge();
  }
  assert.strictEqual(errorPages[0].records.length, 0, "error-only pages must remain replayable");
  assert.strictEqual(errorPages[0].nextCursor, null, "error-only pages must not advance recovery");

  const controller = new AbortController();
  let sourceCancelled = false;
  const source = new ReadableStream({
    start(streamController) { streamController.enqueue(new TextEncoder().encode("<ICECAT-interface><files.index>")); },
    cancel() { sourceCancelled = true; },
  });
  const cancelledProvider = new OpenIcecatProvider({
    username: "u",
    password: "p",
    fetcher: async (url) => String(url).endsWith(".index.xml.gz") ? new Response(source) : new Response("never"),
  });
  const pending = (async () => {
    for await (const page of cancelledProvider.discoverProducts({ limit: 1, signal: controller.signal, inactivityTimeoutMs: 1000 })) void page;
  })();
  controller.abort();
  await assert.rejects(pending);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(sourceCancelled, true, "cancellation must close the source iterator");

  const preAbortedIndexController = new AbortController();
  preAbortedIndexController.abort(new Error("pre-aborted-index"));
  let preAbortedIndexRequests = 0;
  await assert.rejects(async () => {
    for await (const page of new OpenIcecatProvider({ username: "u", password: "p", fetcher: async () => { preAbortedIndexRequests += 1; return new Response(index); } }).discoverProducts({ signal: preAbortedIndexController.signal })) void page;
  }, /pre-aborted-index/);
  assert.strictEqual(preAbortedIndexRequests, 0, "pre-aborted index discovery must not start a request");

  const preAbortedDetailController = new AbortController();
  let preAbortedDetailRequests = 0;
  const preAbortedDetailProvider = new OpenIcecatProvider({
    username: "u",
    password: "p",
    fetcher: async (url) => {
      if (String(url).endsWith(".index.xml.gz")) {
        preAbortedDetailController.abort(new Error("pre-aborted-detail"));
        return new Response(index);
      }
      preAbortedDetailRequests += 1;
      return new Response("never");
    },
  });
  await assert.rejects(async () => {
    for await (const page of preAbortedDetailProvider.discoverProducts({ signal: preAbortedDetailController.signal })) void page;
  }, /pre-aborted-detail/);
  assert.strictEqual(preAbortedDetailRequests, 0, "pre-aborted detail enrichment must not start a request");

  const detailAbortController = new AbortController();
  let detailRequests = 0;
  let detailAborted = false;
  const twoCandidateIndex = '<ICECAT-interface><files.index>' + ["1", "2"].map((id) => `<file path="export/freexml/INT/${id}.xml" Product_ID="${id}" Prod_ID="MPN-${id}" Model_Name="Model ${id}"/>`).join("") + '</files.index></ICECAT-interface>';
  const detailAbortProvider = new OpenIcecatProvider({
    username: "u",
    password: "p",
    fetcher: async (url, init) => {
      if (String(url).endsWith(".index.xml.gz")) return new Response(twoCandidateIndex);
      detailRequests += 1;
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => { detailAborted = true; reject(init.signal.reason); }, { once: true }));
    },
  });
  const detailPending = (async () => {
    for await (const page of detailAbortProvider.discoverProducts({ signal: detailAbortController.signal, limit: 2, concurrency: 1 })) void page;
  })();
  while (detailRequests === 0) await new Promise((resolve) => setImmediate(resolve));
  detailAbortController.abort(new Error("detail-cancelled"));
  await assert.rejects(detailPending, /detail-cancelled/);
  assert.strictEqual(detailAborted, true, "detail request must receive cancellation");
  assert.strictEqual(detailRequests, 1, "cancellation must prevent subsequent detail requests");
  console.log("testV2ContinuationContract passed.");
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
        controller.enqueue(encoder.encode("<ICECAT-interface><files.index>"));
        return;
      }
      if (counters.sourceRecordsGenerated < TOTAL_AVAILABLE) {
        counters.sourceRecordsGenerated += 1;
        const id = counters.sourceRecordsGenerated;
        controller.enqueue(encoder.encode(`<file path="export/freexml/INT/${id}.xml" Product_ID="${id}" Prod_ID="MPN-${id}" Model_Name="Model ${id}" Updated="20260916060101"/>`));
        return;
      }
      counters.sourceCompletedNaturally = true;
      phase = "done";
      controller.enqueue(encoder.encode("</files.index></ICECAT-interface>"));
      controller.close();
    },
    cancel() {
      if (!counters.sourceCompletedNaturally) counters.sourceCancelledEarly = true;
    },
  });

  const detailFetcher = makeIcecatDiscoveryFetcher("");
  const provider = new OpenIcecatProvider({
    username: "u",
    password: "p",
    fetcher: async (url, init) => String(url).endsWith(".index.xml.gz") ? new Response(source) : detailFetcher(url, init),
  });
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
