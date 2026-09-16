#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

async function main() {
  const provider = await import("../lib/catalogProviders.ts");
  const { OpenIcecatProvider, parseIcecatXml, normalizeIcecatProduct, mapIcecatCategory } = provider;
  const fixture = fs.readFileSync(path.join(__dirname, "__fixtures__", "catalog-acquisition", "open-icecat-products.xml"), "utf8");
  const first = normalizeIcecatProduct(parseIcecatXml(fixture));

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

  console.log("Catalog provider fixture tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
