import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createGunzip, gunzipSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import { SaxesParser } from "saxes";
import type { CatalogCandidateInput, ExternalTaxonomyIdentity } from "./catalogStagingTypes.ts";

export type ProviderFetchOptions = {
  limit?: number;
  pages?: number;
  timeoutMs?: number;
  retries?: number;
  language?: string;
  productCodes?: string[];
  gtins?: string[];
};

export type ProviderCapabilities = {
  lookup: boolean;
  discovery: boolean;
};

export type IcecatDiscoveryMode = "initial" | "daily";

export type ProviderDiscoveryOptions = {
  limit?: number;
  pageSize?: number;
  requestTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  cursor?: string | null;
  checkpoint?: Record<string, unknown>;
  signal?: AbortSignal;
  mode?: IcecatDiscoveryMode | string;
  brand?: string;
  category?: string;
  onMarket?: boolean | string | number | null;
  country?: string;
  updatedSince?: string | null;
  diagnostics?: {
    onRecordSeen?: () => void;
    onRecordQualified?: () => void;
  };
};

export type ProviderDiscoveryPage<TRaw> = {
  records: TRaw[];
  nextCursor: string | null;
  done: boolean;
  errors: ProviderFetchError[];
  checkpoint?: Record<string, unknown>;
};

export type ProviderFetchError = {
  message: string;
  sourceExternalId?: string;
  retriable?: boolean;
};

export class CatalogProviderRequestError extends Error {
  readonly code: string;
  readonly retriable: boolean;

  constructor(message: string, code: string, retriable = true, options?: ErrorOptions) {
    super(message, options);
    this.name = "CatalogProviderRequestError";
    this.code = code;
    this.retriable = retriable;
  }
}

export type ProviderFetchResult<TRaw> = {
  records: TRaw[];
  errors: ProviderFetchError[];
  fetched: number;
  pages: number;
};

export interface CatalogProvider<TRaw = unknown> {
  readonly capabilities: ProviderCapabilities;
  lookupProducts(options?: ProviderFetchOptions): Promise<ProviderFetchResult<TRaw>>;
  discoverProducts?(options?: ProviderDiscoveryOptions): AsyncIterable<ProviderDiscoveryPage<TRaw>>;
  normalizeProduct(rawRecord: TRaw): CatalogCandidateInput;
  getSourceMetadata(): { name: string; type: string; baseUrl: string; metadata: Record<string, unknown> };
}

export function assertProviderSupports(provider: CatalogProvider, operation: keyof ProviderCapabilities): void {
  if (!provider.capabilities[operation]) {
    const label = operation === "discovery" ? "discovery" : "lookup/enrichment";
    throw new Error(`${provider.getSourceMetadata().name} does not support ${label} with the configured adapter. Supply product identifiers for lookup/enrichment.`);
  }
  if (operation === "discovery" && typeof provider.discoverProducts !== "function") {
    throw new Error(`${provider.getSourceMetadata().name} advertises no usable discovery operation.`);
  }
}

export async function processDiscoveredPages<TRaw>(
  provider: CatalogProvider<TRaw>,
  options: ProviderDiscoveryOptions,
  processPage: (page: ProviderDiscoveryPage<TRaw>) => Promise<void>
): Promise<void> {
  assertProviderSupports(provider, "discovery");
  for await (const page of provider.discoverProducts!(options)) await processPage(page);
}

type IcecatProduct = Record<string, unknown>;

type TaxonomyMapping = {
  category: string;
  subcategory?: string;
};

export const DEFAULT_ICECAT_TAXONOMY: Record<string, TaxonomyMapping> = {
  "portable speakers": { category: "Electronics", subcategory: "Portable Speakers" },
  headphones: { category: "Electronics", subcategory: "Headphones" },
  "action cameras": { category: "Electronics", subcategory: "Action Cameras" },
  laptops: { category: "Electronics", subcategory: "Laptops" },
  tablets: { category: "Electronics", subcategory: "Tablets" },
  smartphones: { category: "Electronics", subcategory: "Phones" },
};

function text(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return String(value).trim() || null;
  if (value && typeof value === "object" && "#text" in value) return text((value as Record<string, unknown>)["#text"]);
  return null;
}

function attr(value: unknown, ...names: string[]): string | null {
  if (!value || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  for (const name of names) {
    const result = text(object[`@_${name}`] ?? object[`@${name}`] ?? object[name]);
    if (result) return result;
  }
  return null;
}

function first(...values: unknown[]): string | null {
  for (const value of values) {
    const result = text(value);
    if (result) return result;
  }
  return null;
}

function categoryName(product: IcecatProduct): string | null {
  const category = product.Category ?? product.category;
  return first(attr(category, "Name", "name"), text(category));
}

function externalCategoryRecord(rawRecord: IcecatProduct | IcecatIndexRecord): { id: string | null; name: string | null } {
  const record = rawRecord as Record<string, unknown>;
  const raw = record.raw && typeof record.raw === "object" ? record.raw as Record<string, unknown> : {};
  const enrichedProduct = raw.enrichedProduct && typeof raw.enrichedProduct === "object" ? raw.enrichedProduct as Record<string, unknown> : null;
  const category = first(
    categoryName({ Category: record.Category } as IcecatProduct),
    categoryName(enrichedProduct ?? {}),
    categoryName(enrichedProduct?.record as IcecatProduct ?? {}),
  );
  const sourceCategoryId = first(raw.categoryId, attr(raw.record, "Catid", "CategoryId"), (rawRecord as IcecatIndexRecord).category);
  return { id: sourceCategoryId, name: category };
}

function collectNamedObjects(value: unknown, name: string, results: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return results;
  if (Array.isArray(value)) {
    for (const entry of value) collectNamedObjects(entry, name, results);
    return results;
  }
  const object = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(object)) {
    if (key === name) {
      const entries = Array.isArray(child) ? child : [child];
      for (const entry of entries) {
        if (entry && typeof entry === "object") results.push(entry as Record<string, unknown>);
      }
    }
    collectNamedObjects(child, name, results);
  }
  return results;
}

function readProductSupplier(product: IcecatProduct): { id: string | null; name: string } | null {
  const suppliers = collectNamedObjects(product, "Supplier")
    .map((supplier) => ({ id: attr(supplier, "ID", "Id", "id"), name: attr(supplier, "Name", "name") }))
    .filter((supplier): supplier is { id: string | null; name: string } => Boolean(supplier.name));
  const uniqueNames = new Map<string, { id: string | null; name: string }>();
  for (const supplier of suppliers) uniqueNames.set(supplier.name.trim().toLowerCase(), supplier);
  if (uniqueNames.size > 1) {
    throw new Error(`Icecat product has conflicting Supplier names: ${[...uniqueNames.values()].map((supplier) => supplier.name).sort().join(", ")}`);
  }
  return uniqueNames.values().next().value ?? null;
}

function readBrandProductCodes(product: IcecatProduct): string[] {
  return [...new Set(
    collectNamedObjects(product, "Identifier")
      .filter((identifier) => attr(identifier, "Type") === "BrandProductCode")
      .map((identifier) => attr(identifier, "Value"))
      .filter((value): value is string => Boolean(value))
  )];
}

function normalizeIcecatBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 0 ? false : value === 1 ? true : null;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(lowered)) return true;
    if (["0", "false", "no", "n", "off"].includes(lowered)) return false;
  }
  return null;
}

export type IcecatIndexRecord = {
  sourceExternalId: string;
  brand: string | null;
  productName: string;
  modelNumber: string | null;
  mpn: string | null;
  gtin: string | null;
  sourceUrl: string | null;
  category: string | null;
  subcategory: string | null;
  onMarket: boolean | null;
  country: string | null;
  updated: string | null;
  supplierId: string | null;
  dateAdded: string | null;
  imageUrl: string | null;
  countryMarkets: string[];
  raw: Record<string, unknown>;
};

function normalizeIcecatTimestamp(value: string | null): string | null {
  if (!value || !/^\d{14}$/.test(value)) return value;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}Z`;
}

function buildIcecatProductUrl(indexUrl: string, productPath: string): string {
  return new URL(productPath.replace(/^\/+/, ""), new URL("/", indexUrl)).toString();
}

function readIcecatIndexProducts(root: Record<string, unknown>): Record<string, unknown>[] {
  const index = root["files.index"];
  if (!index || typeof index !== "object") return [];
  const files = (index as Record<string, unknown>).file;
  if (Array.isArray(files)) return files.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"));
  return files && typeof files === "object" ? [files as Record<string, unknown>] : [];
}

export function parseIcecatIndexXml(xml: string): IcecatIndexRecord[] {
  if (!xml.trim()) throw new Error("Icecat index is empty");
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false }).parse(xml) as Record<string, unknown>;
  const root = (parsed["ICECAT-interface"] ?? parsed["icecat-interface"] ?? parsed) as Record<string, unknown>;
  const products = readIcecatIndexProducts(root);
  if (!products.length && root["files.index"]) throw new Error("Icecat files.index contains no parseable file records");
  const records: IcecatIndexRecord[] = [];
  for (const product of products) {
    const productId = first(attr(product, "Product_ID", "ProductId"), text((product as Record<string, unknown>).Product_ID), text((product as Record<string, unknown>).ProductId));
    if (!productId) continue;
    const modelNumber = first(attr(product, "Model_Name", "ModelName"), text((product as Record<string, unknown>).Model_Name), text((product as Record<string, unknown>).ModelName), text((product as Record<string, unknown>).Prod_ID));
    const mpn = first(attr(product, "Prod_ID", "ProductCode", "MPN"), text((product as Record<string, unknown>).Prod_ID), text((product as Record<string, unknown>).ProductCode), text((product as Record<string, unknown>).MPN));
    const eanNode = (product.EAN_UPCS as Record<string, unknown> | undefined)?.EAN_UPC;
    const eans = (Array.isArray(eanNode) ? eanNode : eanNode ? [eanNode] : []).map((entry) => attr(entry, "Value")).filter((value): value is string => Boolean(value));
    const countryNode = (product.Country_Markets as Record<string, unknown> | undefined)?.Country_Market;
    const countryMarkets = (Array.isArray(countryNode) ? countryNode : countryNode ? [countryNode] : []).map((entry) => attr(entry, "Value")).filter((value): value is string => Boolean(value));
    const gtin = eans[0] ?? null;
    const country = countryMarkets[0] ?? null;
    const updated = normalizeIcecatTimestamp(first(attr(product, "Updated"), text(product.Updated)));
    const onMarket = normalizeIcecatBoolean(first(attr(product, "On_Market"), text((product as Record<string, unknown>).On_Market)) ?? "0");
    const category = first(attr(product, "Catid"), text((product as Record<string, unknown>).Catid));
    const productName = first(attr(product, "Model_Name", "Name", "ProductName"), text((product as Record<string, unknown>).Model_Name), text((product as Record<string, unknown>).Name), text((product as Record<string, unknown>).ProductName), mpn, productId) ?? productId;
    const productPath = attr(product, "path");
    records.push({
      sourceExternalId: String(productId),
      brand: null,
      productName: String(productName),
      modelNumber: modelNumber ? String(modelNumber) : null,
      mpn: mpn ? String(mpn) : null,
      gtin: gtin ? String(gtin) : null,
      sourceUrl: productPath,
      category: category ? String(category) : null,
      subcategory: null,
      onMarket,
      country: country ? String(country) : null,
      updated: updated ? String(updated) : null,
      supplierId: attr(product, "Supplier_id"),
      dateAdded: normalizeIcecatTimestamp(attr(product, "Date_Added")),
      imageUrl: attr(product, "HighPic"),
      countryMarkets,
      raw: {
        provider: "open-icecat",
        providerProductId: productId,
        record: product,
        sourceType: "open-icecat-index",
        categoryId: category,
        onMarket,
        country,
        updated,
        path: productPath,
        eans,
        countryMarkets,
        alternateManufacturerPartNumbers: product.M_Prod_ID,
      },
    });
  }
  return records;
}

export function parseIcecatXml(xml: string): IcecatProduct {
  return parseIcecatProductsXml(xml)[0];
}

export function parseIcecatProductsXml(xml: string): IcecatProduct[] {
  if (!xml.trim()) throw new Error("Icecat response is empty");
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false }).parse(xml) as Record<string, unknown>;
  const root = (parsed["ICECAT-interface"] ?? parsed["icecat-interface"] ?? parsed) as Record<string, unknown>;
  const products = root.Product ?? root.product ?? root.products;
  const list = Array.isArray(products) ? products : products ? [products] : [];
  if (!list.length) throw new Error("Icecat response contains no products");
  return list.filter((product): product is IcecatProduct => Boolean(product && typeof product === "object"));
}

export function mapIcecatCategory(sourceCategory: string | null | undefined, mappings = DEFAULT_ICECAT_TAXONOMY): TaxonomyMapping | null {
  if (!sourceCategory) return null;
  return mappings[sourceCategory.trim().toLowerCase()] ?? null;
}

function externalCategoryPath(rawRecord: IcecatProduct | IcecatIndexRecord): string | null {
  const record = rawRecord as Record<string, unknown>;
  const raw = record.raw && typeof record.raw === "object" ? record.raw as Record<string, unknown> : {};
  const enrichedProduct = raw.enrichedProduct && typeof raw.enrichedProduct === "object" ? raw.enrichedProduct as Record<string, unknown> : null;
  return first(
    attr(record.Category, "Path", "path", "CategoryPath"),
    attr(enrichedProduct?.Category, "Path", "path", "CategoryPath"),
    attr((enrichedProduct?.record as Record<string, unknown> | undefined)?.Category, "Path", "path", "CategoryPath")
  );
}

export function normalizeIcecatProduct(rawRecord: IcecatProduct | IcecatIndexRecord, mappings = DEFAULT_ICECAT_TAXONOMY): CatalogCandidateInput {
  const supplier = readProductSupplier(rawRecord as IcecatProduct);
  const brandProductCodes = readBrandProductCodes(rawRecord as IcecatProduct);
  const productId = first(
    attr(rawRecord as Record<string, unknown>, "Product_ID", "ProductId", "ID", "id"),
    text((rawRecord as Record<string, unknown>).Product_ID),
    text((rawRecord as Record<string, unknown>).ProductId),
    typeof (rawRecord as IcecatIndexRecord).sourceExternalId === "string" ? (rawRecord as IcecatIndexRecord).sourceExternalId : null
  );
  const brand = first(
    attr(rawRecord as Record<string, unknown>, "Brand", "Manufacturer"),
    supplier?.name,
    text((rawRecord as Record<string, unknown>).Brand),
    text((rawRecord as Record<string, unknown>).Manufacturer),
    typeof (rawRecord as IcecatIndexRecord).brand === "string" ? (rawRecord as IcecatIndexRecord).brand : null
  );
  const productName = first(
    attr(rawRecord as Record<string, unknown>, "GeneratedIntTitle"),
    attr(rawRecord as Record<string, unknown>, "Title"),
    attr(rawRecord as Record<string, unknown>, "IntName"),
    attr(rawRecord as Record<string, unknown>, "Name", "ProductName"),
    text((rawRecord as Record<string, unknown>).Name),
    text((rawRecord as Record<string, unknown>).ProductName),
    typeof (rawRecord as IcecatIndexRecord).productName === "string" ? (rawRecord as IcecatIndexRecord).productName : null,
    typeof (rawRecord as IcecatIndexRecord).modelNumber === "string" ? (rawRecord as IcecatIndexRecord).modelNumber : null,
    typeof (rawRecord as IcecatIndexRecord).mpn === "string" ? (rawRecord as IcecatIndexRecord).mpn : null,
    typeof (rawRecord as IcecatIndexRecord).sourceExternalId === "string" ? (rawRecord as IcecatIndexRecord).sourceExternalId : null
  );
  const mpn = first(
    attr(rawRecord as Record<string, unknown>, "Prod_ID", "Prod_id", "ProductCode", "MPN", "Model"),
    text((rawRecord as Record<string, unknown>).ProductCode),
    text((rawRecord as Record<string, unknown>).MPN),
    typeof (rawRecord as IcecatIndexRecord).mpn === "string" ? (rawRecord as IcecatIndexRecord).mpn : null
  );
  const gtin = first(
    attr(rawRecord as Record<string, unknown>, "EAN_UPC", "EAN", "UPC", "GTIN"),
    text((rawRecord as Record<string, unknown>).EAN_UPC),
    text((rawRecord as Record<string, unknown>).EAN),
    text((rawRecord as Record<string, unknown>).GTIN),
    typeof (rawRecord as IcecatIndexRecord).gtin === "string" ? (rawRecord as IcecatIndexRecord).gtin : null
  );
  const model = first(
    attr(rawRecord as Record<string, unknown>, "Model_Name", "Model", "Prod_id"),
    text((rawRecord as Record<string, unknown>).Model_Name),
    text((rawRecord as Record<string, unknown>).Model),
    typeof (rawRecord as IcecatIndexRecord).modelNumber === "string" ? (rawRecord as IcecatIndexRecord).modelNumber : null,
    mpn
  );
  const externalCategory = { ...externalCategoryRecord(rawRecord), path: externalCategoryPath(rawRecord) };
  const sourceCategory = externalCategory.name ?? (rawRecord as IcecatIndexRecord).category ?? null;
  const taxonomy = mapIcecatCategory(sourceCategory, mappings);
  if (!productId || !brand || !productName) throw new Error("Icecat product is missing ID/Product_ID, explicit Supplier/brand/manufacturer, or product title/name");

  const rawPayload = "raw" in (rawRecord as Record<string, unknown>) ? (rawRecord as Record<string, unknown>).raw : null;
  const spreadableRaw = rawPayload && typeof rawPayload === "object" ? rawPayload : {};

  return {
    sourceExternalId: productId,
    brand,
    productName,
    modelNumber: model,
    mpn,
    gtin,
    category: taxonomy?.category ?? null,
    subcategory: taxonomy?.subcategory ?? null,
    aliases: [],
    sourceUrl: first(
      attr(rawRecord as Record<string, unknown>, "ProductURL", "URL"),
      text((rawRecord as Record<string, unknown>).ProductURL),
      text((rawRecord as Record<string, unknown>).URL),
      typeof (rawRecord as IcecatIndexRecord).sourceUrl === "string" ? (rawRecord as IcecatIndexRecord).sourceUrl : null
    ),
    imageUrl: first(
      attr(rawRecord as Record<string, unknown>, "HighPic"),
      text((rawRecord as Record<string, unknown>).HighPic),
      typeof (rawRecord as IcecatIndexRecord).imageUrl === "string" ? (rawRecord as IcecatIndexRecord).imageUrl : null
    ),
    sourceType: "open-icecat",
    externalTaxonomy: externalCategory.id || externalCategory.name
      ? {
          provider: "open-icecat",
          externalId: externalCategory.id ?? externalCategory.name!,
          name: externalCategory.name,
          path: externalCategory.path,
        } satisfies ExternalTaxonomyIdentity
      : null,
    raw: {
      provider: "open-icecat",
      providerProductId: productId,
      sourceCategory,
      externalCategory,
      externalTaxonomy: externalCategory.id || externalCategory.name
        ? { provider: "open-icecat", externalId: externalCategory.id ?? externalCategory.name!, name: externalCategory.name, path: externalCategory.path }
        : null,
      taxonomyMapping: taxonomy,
      record: (rawRecord as Record<string, unknown>).record ?? rawRecord,
      sourceType: "open-icecat",
      supplier,
      brandProductCodes,
      ...spreadableRaw,
    },
  };
}

function buildRequestUrl(baseUrl: string, code: string, parameter: "productcode" | "ean_upc", options: ProviderFetchOptions, shopName: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("shopname", shopName);
  url.searchParams.set("lang", options.language ?? "EN");
  url.searchParams.set(parameter, code);
  return url.toString();
}

async function fetchWithTimeout(fetcher: typeof fetch, url: string, headers: Record<string, string>, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`Icecat HTTP ${response.status} ${response.statusText}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const isGzipPayload = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
    return (isGzipPayload ? gunzipSync(buffer) : buffer).toString("utf8");
  } finally {
    clearTimeout(timeout);
  }
}

export type OpenIcecatProviderOptions = {
  baseUrl?: string;
  indexBaseUrl?: string;
  shopName?: string;
  apiToken?: string;
  username?: string;
  password?: string;
  fetcher?: typeof fetch;
  taxonomy?: Record<string, TaxonomyMapping>;
};

function buildIcecatAuthHeaders(config: OpenIcecatProviderOptions): Record<string, string> {
  if (config.apiToken) return { "Api-Token": config.apiToken };
  if (config.username && config.password) {
    return { Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}` };
  }
  throw new Error("Open Icecat credentials are required. Set ICECAT_API_TOKEN or ICECAT_USERNAME and ICECAT_PASSWORD.");
}

function buildIndexUrl(baseUrl: string, mode: string): string {
  const url = new URL(baseUrl);
  const filename = mode === "daily" ? "daily.index.xml.gz" : "files.index.xml.gz";
  const pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  url.pathname = `${pathname}${filename}`;
  return url.toString();
}

function encodeDiscoveryCursor(record: IcecatIndexRecord): string {
  const productId = String(record.sourceExternalId ?? "");
  const updated = record.updated ?? "";
  return productId && updated ? `${productId}|${updated}` : productId || "";
}

function decodeDiscoveryCursor(cursor: string | null | undefined): { productId: string | null; updated: string | null } {
  if (!cursor) return { productId: null, updated: null };
  const [productId, updated] = String(cursor).split("|");
  return { productId: productId || null, updated: updated || null };
}

async function* streamIcecatIndex(url: string, headers: Headers, source: Readable): AsyncGenerator<Buffer> {
  const contentEncoding = headers.get("content-encoding")?.toLowerCase() ?? "";
  const shouldGunzip = contentEncoding.includes("gzip") || /\.gz(?:\?|$)/i.test(url);
  const normalizeChunk = (chunk: unknown): Buffer => {
    if (Buffer.isBuffer(chunk)) return chunk;
    if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
    if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    return Buffer.from(String(chunk ?? ""));
  };

  const sourceIterator = source[Symbol.asyncIterator]();
  const first = await sourceIterator.next();
  if (first.done) return;
  const firstChunk = normalizeChunk(first.value);
  const isGzipPayload = firstChunk.length >= 2 && firstChunk[0] === 0x1f && firstChunk[1] === 0x8b;

  const replaySource = async function* () {
    yield firstChunk;
    for (;;) {
      const next = await sourceIterator.next();
      if (next.done) return;
      yield normalizeChunk(next.value);
    }
  };

  if (shouldGunzip && isGzipPayload) {
    const compressedStream = Readable.from(replaySource());
    const gunzip = createGunzip();
    const pipelineResult = pipeline(compressedStream, gunzip).then(
      () => null,
      (error: unknown) => error
    );
    let iterationError: unknown;
    let completedNaturally = false;
    try {
      for await (const chunk of gunzip) yield normalizeChunk(chunk);
      completedNaturally = true;
    } catch (error) {
      iterationError = error;
      throw error;
    } finally {
      gunzip.destroy();
      compressedStream.destroy();
      await sourceIterator.return?.();
      const pipelineError = await pipelineResult;
      if (!iterationError && completedNaturally && pipelineError) throw pipelineError;
    }
    return;
  }

  try {
    yield firstChunk;
    for (;;) {
      const next = await sourceIterator.next();
      if (next.done) return;
      yield normalizeChunk(next.value);
    }
  } finally {
    await sourceIterator.return?.();
  }
}

function matchesDiscoveryFilter(record: IcecatIndexRecord, filters: ProviderDiscoveryOptions): boolean {
  if (filters.brand) {
    const wanted = filters.brand.trim().toLowerCase();
    const candidates = [record.brand, record.raw.Brand, record.raw.Manufacturer, record.raw.Supplier].map((value) => String(value ?? "").trim().toLowerCase());
    if (!candidates.some((value) => value && value.includes(wanted)) && !String(record.productName).toLowerCase().includes(wanted)) return false;
  }
  if (filters.category) {
    const wanted = filters.category.trim().toLowerCase();
    const categoryId = String(record.category ?? record.raw.Catid ?? "").trim();
    const categoryName = String(record.raw.Category ?? record.raw.category ?? "").trim();
    if (!categoryId.toLowerCase().includes(wanted) && !categoryName.toLowerCase().includes(wanted)) return false;
  }
  if (filters.country) {
    const wanted = filters.country.trim().toLowerCase();
    if (!String(record.country ?? "").trim().toLowerCase().includes(wanted)) return false;
  }
  if (filters.onMarket !== undefined && filters.onMarket !== null) {
    const wanted = normalizeIcecatBoolean(filters.onMarket);
    if (wanted !== null && record.onMarket !== wanted) return false;
  }
  if (filters.updatedSince) {
    const threshold = new Date(filters.updatedSince).getTime();
    if (Number.isNaN(threshold) || !record.updated) return false;
    const recordTime = new Date(record.updated).getTime();
    if (Number.isNaN(recordTime) || recordTime < threshold) return false;
  }
  return true;
}

export class OpenIcecatProvider implements CatalogProvider<IcecatProduct | IcecatIndexRecord> {
  readonly capabilities: ProviderCapabilities = { lookup: true, discovery: true };
  private readonly config: Required<Pick<OpenIcecatProviderOptions, "baseUrl" | "indexBaseUrl" | "shopName" | "fetcher">> & OpenIcecatProviderOptions;

  constructor(options: OpenIcecatProviderOptions = {}) {
    this.config = {
      ...options,
      baseUrl: options.baseUrl ?? process.env.ICECAT_API_URL ?? "https://live.icecat.biz/api",
      indexBaseUrl: options.indexBaseUrl ?? process.env.ICECAT_INDEX_URL ?? "https://data.icecat.biz/export/freexml",
      shopName: options.shopName ?? process.env.ICECAT_SHOPNAME ?? "OpenIcecat-live",
      apiToken: options.apiToken ?? process.env.ICECAT_API_TOKEN,
      fetcher: options.fetcher ?? fetch,
    };
  }

  getSourceMetadata() {
    return {
      name: "Open Icecat",
      type: "external-provider",
      baseUrl: this.config.indexBaseUrl,
      metadata: {
        provider: "open-icecat",
        accessMethod: "documented Open Icecat XML index discovery + product lookup API",
        taxonomyMapping: "explicit configured mapping",
        discoveryMode: "files.index.xml.gz or daily.index.xml.gz",
      },
    };
  }

  normalizeProduct(rawRecord: IcecatProduct | IcecatIndexRecord): CatalogCandidateInput {
    return normalizeIcecatProduct(rawRecord, this.config.taxonomy ?? DEFAULT_ICECAT_TAXONOMY);
  }

  async *discoverProducts(options: ProviderDiscoveryOptions = {}): AsyncIterable<ProviderDiscoveryPage<IcecatIndexRecord>> {
    const mode = (options.mode ?? "initial").toString().toLowerCase() === "daily" ? "daily" : "initial";
    const pageSize = Math.max(1, Math.min(options.pageSize ?? 25, 5000));
    const limit = Math.max(0, Math.min(options.limit ?? 100, 100000));
    const checkpoint = options.checkpoint ?? {};
    const url = buildIndexUrl(this.config.indexBaseUrl, mode);
    const headers = {
      ...buildIcecatAuthHeaders(this.config),
      Accept: "application/xml, application/gzip, */*",
    };

    const controller = new AbortController();
    const requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 30000);
    const inactivityTimeoutMs = Math.max(1, options.inactivityTimeoutMs ?? 120000);
    const requestTimeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    const resumeCursor = decodeDiscoveryCursor(options.cursor ?? (typeof checkpoint.cursor === "string" ? checkpoint.cursor : null));
    const resumeEnabled = Boolean(resumeCursor.productId || resumeCursor.updated);
    let cleanup: (() => Promise<void>) | undefined;

    try {
      let response: Response;
      try {
        response = await this.config.fetcher(url, { headers, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted && !options.signal?.aborted) {
          throw new CatalogProviderRequestError(
            `Open Icecat discovery request timed out before response headers after ${requestTimeoutMs}ms`,
            "ICECAT_DISCOVERY_REQUEST_TIMEOUT",
            true,
            { cause: error }
          );
        }
        throw error;
      } finally {
        clearTimeout(requestTimeout);
      }
      if (!response.ok) throw new Error(`Icecat HTTP ${response.status} ${response.statusText}`);

      const checkpointUrl = typeof checkpoint.sourceUrl === "string" ? checkpoint.sourceUrl : null;
      const checkpointMode = typeof checkpoint.mode === "string" ? checkpoint.mode : null;
      const checkpointVersion = typeof checkpoint.checkpointVersion === "string" ? checkpoint.checkpointVersion : null;
      const currentMeta = {
        sourceUrl: url,
        mode,
        checkpointVersion: "icecat-index-v1",
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        contentLength: response.headers.get("content-length"),
        contentEncoding: response.headers.get("content-encoding"),
      };

      if (checkpointUrl && checkpointUrl !== url) throw new Error("Icecat discovery checkpoint is for a different source URL and cannot be resumed safely.");
      if (checkpointMode && checkpointMode !== mode) throw new Error("Icecat discovery checkpoint mode does not match the requested discovery mode.");
      if (checkpointVersion && checkpointVersion !== currentMeta.checkpointVersion) throw new Error("Icecat discovery checkpoint version is incompatible with the current index format.");
      if (checkpoint.etag && currentMeta.etag && checkpoint.etag !== currentMeta.etag) throw new Error("Icecat discovery checkpoint ETag does not match the current source snapshot.");
      if (checkpoint.lastModified && currentMeta.lastModified && checkpoint.lastModified !== currentMeta.lastModified) throw new Error("Icecat discovery checkpoint Last-Modified does not match the current source snapshot.");

      const bodyStream = Readable.fromWeb(response.body as any);
      const decompressedStream = streamIcecatIndex(url, response.headers, bodyStream);
      const parser = new SaxesParser();
      const decoder = new StringDecoder("utf8");
      let currentFile: Record<string, string> | null = null;
      let currentTextElement: { name: string; attributes: Record<string, string>; value: string } | null = null;
      let currentEans: string[] = [];
      let currentCountryMarkets: string[] = [];
      let currentAlternateMpns: Array<{ value: string; supplierId: string | null; supplierName: string | null }> = [];
      let candidateRecords: IcecatIndexRecord[] = [];
      let page: IcecatIndexRecord[] = [];
      let pageErrors: ProviderFetchError[] = [];
      let readyPages: ProviderDiscoveryPage<IcecatIndexRecord>[] = [];
      let emittedCount = 0;
      let processedCount = 0;
      let enrichmentAttempts = 0;
      let filesIndexSeen = false;
      let fileElementsSeen = 0;
      let parsedFileRecords = 0;
      let lastSourceIdentity: string | null = null;
      let lastUpdatedValue: string | null = null;
      let limitReached = false;
      let resumeSatisfied = !resumeEnabled;
      const maxEnrichmentAttempts = limit > 0 ? Math.min(100000, Math.max(pageSize, limit * 10)) : 100000;

      const flushPage = () => {
        if (!page.length && !pageErrors.length) return null;
        const currentPage = page.slice();
        const currentErrors = pageErrors.slice();
        const lastRecord = currentPage[currentPage.length - 1];
        const nextCursor = lastRecord ? encodeDiscoveryCursor(lastRecord) : null;
        page = [];
        pageErrors = [];
        emittedCount += currentPage.length;
        const nextPage: ProviderDiscoveryPage<IcecatIndexRecord> = {
          records: currentPage,
          nextCursor,
          done: limit > 0 && emittedCount >= limit,
          errors: currentErrors,
          checkpoint: {
            checkpointVersion: currentMeta.checkpointVersion,
            sourceUrl: url,
            mode,
            etag: currentMeta.etag,
            lastModified: currentMeta.lastModified,
            contentLength: currentMeta.contentLength,
            contentEncoding: currentMeta.contentEncoding,
            lastProcessedIdentity: lastSourceIdentity,
            lastProcessedUpdated: lastUpdatedValue,
            processedCount,
            cursor: nextCursor,
          },
        };
        readyPages.push(nextPage);
        if (nextPage.done) limitReached = true;
        return nextPage;
      };

      cleanup = async () => {
        if (!bodyStream.destroyed) bodyStream.destroy();
        try {
          await decompressedStream.return(undefined);
        } catch {}
      };

      parser.on("opentag", (node) => {
        if (limitReached) return;
        const attributes = { ...(node.attributes as Record<string, unknown> as Record<string, string>) };
        if (node.name === "files.index") filesIndexSeen = true;
        if (node.name === "file") {
          fileElementsSeen += 1;
          currentFile = attributes;
          currentEans = [];
          currentCountryMarkets = [];
          currentAlternateMpns = [];
        } else if (currentFile && node.name === "EAN_UPC") {
          const value = first(attributes.Value, attributes.value);
          if (value) currentEans.push(value);
        } else if (currentFile && node.name === "Country_Market") {
          const value = first(attributes.Value, attributes.value);
          if (value) currentCountryMarkets.push(value);
        } else if (currentFile && node.name === "M_Prod_ID") {
          currentTextElement = { name: node.name, attributes, value: "" };
        }
      });

      parser.on("text", (value) => {
        if (currentTextElement) currentTextElement.value += value;
      });

      parser.on("closetag", (node) => {
        if (limitReached) return;
        if (node.name === "M_Prod_ID" && currentTextElement) {
          const value = currentTextElement.value.trim();
          if (value) {
            currentAlternateMpns.push({
              value,
              supplierId: first(currentTextElement.attributes.Supplier_id),
              supplierName: first(currentTextElement.attributes.Supplier_name),
            });
          }
          currentTextElement = null;
          return;
        }
        if (node.name !== "file" || !currentFile) return;

        processedCount += 1;
        options.diagnostics?.onRecordSeen?.();
        const productId = first(currentFile.Product_ID, currentFile.ProductId);
        const productName = first(currentFile.Model_Name, currentFile.Prod_ID);
        const productPath = first(currentFile.path, currentFile.Path);
        if (!productId || !productName || !productPath) {
          pageErrors.push({
            sourceExternalId: productId ?? undefined,
            message: "Icecat files.index record is missing Product_ID, Model_Name/Prod_ID, or product XML path",
            retriable: false,
          });
          currentFile = null;
          if (page.length + pageErrors.length >= pageSize) flushPage();
          return;
        }
        const updated = normalizeIcecatTimestamp(first(currentFile.Updated, currentFile.updated));
        const onMarket = normalizeIcecatBoolean(first(currentFile.On_Market, currentFile.onMarket) ?? "0");
        const category = first(currentFile.Catid, currentFile.CategoryId);
        const country = currentCountryMarkets[0] ?? null;
        const gtin = currentEans[0] ?? null;
        const mpn = first(currentFile.Prod_ID);
        const modelNumber = first(currentFile.Model_Name, mpn);
        const record: IcecatIndexRecord = {
          sourceExternalId: String(productId),
          brand: null,
          productName: String(productName),
          modelNumber: modelNumber ? String(modelNumber) : null,
          mpn: mpn ? String(mpn) : null,
          gtin: gtin ? String(gtin) : null,
          sourceUrl: buildIcecatProductUrl(url, productPath),
          category: category ? String(category) : null,
          subcategory: null,
          onMarket,
          country: country ? String(country) : null,
          updated: updated ? String(updated) : null,
          supplierId: first(currentFile.Supplier_id),
          dateAdded: normalizeIcecatTimestamp(first(currentFile.Date_Added)),
          imageUrl: first(currentFile.HighPic),
          countryMarkets: currentCountryMarkets.slice(),
          raw: {
            provider: "open-icecat",
            providerProductId: productId,
            record: currentFile,
            sourceType: "open-icecat-index",
            categoryId: category,
            onMarket,
            country,
            updated,
            path: productPath,
            supplierId: first(currentFile.Supplier_id),
            highPic: first(currentFile.HighPic),
            dateAdded: normalizeIcecatTimestamp(first(currentFile.Date_Added)),
            eans: currentEans.slice(),
            countryMarkets: currentCountryMarkets.slice(),
            alternateManufacturerPartNumbers: currentAlternateMpns.slice(),
          },
        };
        parsedFileRecords += 1;

        if (resumeEnabled) {
          const cursorProductId = resumeCursor.productId ?? "";
          const cursorUpdated = resumeCursor.updated ?? "";
          const recordProductId = String(record.sourceExternalId ?? "");
          const recordUpdated = record.updated ?? "";
          const recordIsAfterCursor =
            recordProductId === cursorProductId
              ? Boolean(cursorUpdated && recordUpdated && recordUpdated > cursorUpdated)
              : Number(recordProductId) > Number(cursorProductId) || String(recordProductId) > String(cursorProductId);
          if (!recordIsAfterCursor) {
            currentFile = null;
            return;
          }
          resumeSatisfied = true;
        }

        if (!matchesDiscoveryFilter(record, { ...options, brand: undefined })) {
          currentFile = null;
          return;
        }
        candidateRecords.push(record);
        currentFile = null;
      });

      parser.on("error", (error) => {
        if (limitReached) return;
        throw error;
      });

      const enrichCandidates = async () => {
        while (candidateRecords.length && !limitReached && enrichmentAttempts < maxEnrichmentAttempts) {
          const indexRecord = candidateRecords.shift()!;
          enrichmentAttempts += 1;
          try {
            const detailXml = await fetchWithTimeout(this.config.fetcher, indexRecord.sourceUrl!, { ...headers, Accept: "application/xml" }, 15000);
            const detail = normalizeIcecatProduct(parseIcecatXml(detailXml), this.config.taxonomy ?? DEFAULT_ICECAT_TAXONOMY);
            if (detail.sourceExternalId !== indexRecord.sourceExternalId) {
              throw new Error(`Icecat enrichment identity mismatch: index Product_ID ${indexRecord.sourceExternalId} does not match product ID ${detail.sourceExternalId}`);
            }
            if (indexRecord.mpn && detail.mpn && indexRecord.mpn !== detail.mpn) {
              throw new Error(`Icecat enrichment MPN mismatch: index Prod_ID ${indexRecord.mpn} does not match product Prod_id ${detail.mpn}`);
            }
            const enrichedRecord: IcecatIndexRecord = {
              ...indexRecord,
              brand: detail.brand,
              productName: detail.productName,
              modelNumber: detail.modelNumber ?? indexRecord.modelNumber,
              mpn: detail.mpn ?? indexRecord.mpn,
              gtin: detail.gtin ?? indexRecord.gtin,
              imageUrl: detail.imageUrl ?? indexRecord.imageUrl,
              raw: {
                ...indexRecord.raw,
                indexProductId: indexRecord.sourceExternalId,
                detailProductId: detail.sourceExternalId,
                indexMpn: indexRecord.mpn,
                detailMpn: detail.mpn,
                enrichedProduct: detail.raw,
              },
            };
            if (!matchesDiscoveryFilter(enrichedRecord, options)) continue;
            options.diagnostics?.onRecordQualified?.();
            lastSourceIdentity = enrichedRecord.sourceExternalId;
            lastUpdatedValue = enrichedRecord.updated ?? lastUpdatedValue;
            page.push(enrichedRecord);
            if (page.length >= pageSize || (limit > 0 && emittedCount + page.length >= limit)) flushPage();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const isDataError = /identity mismatch|MPN mismatch|conflicting Supplier names|missing ID\/Product_ID/.test(message);
            pageErrors.push({
              sourceExternalId: indexRecord.sourceExternalId,
              message: `Icecat product enrichment failed: ${message}`,
              retriable: !isDataError,
            });
            if (page.length + pageErrors.length >= pageSize) flushPage();
          }
        }
        if (enrichmentAttempts >= maxEnrichmentAttempts && !limitReached && candidateRecords.length) {
          pageErrors.push({ message: `Icecat discovery stopped after ${maxEnrichmentAttempts} bounded enrichment attempts`, retriable: true });
          candidateRecords = [];
          flushPage();
          limitReached = true;
        }
      };

      const feedParser = async function* (textChunk: string): AsyncGenerator<ProviderDiscoveryPage<IcecatIndexRecord>> {
        const maxParserFeedChars = 1024;
        for (let offset = 0; offset < textChunk.length && !limitReached; offset += maxParserFeedChars) {
          parser.write(textChunk.slice(offset, offset + maxParserFeedChars));
          await enrichCandidates();
          while (readyPages.length) {
            yield readyPages.shift()!;
          }
        }
      };

      const decompressedIterator = decompressedStream[Symbol.asyncIterator]();
      for (;;) {
        let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
        const nextChunk = await Promise.race([
          decompressedIterator.next(),
          new Promise<never>((_resolve, reject) => {
            inactivityTimer = setTimeout(() => {
              const error = new CatalogProviderRequestError(
                `Open Icecat discovery stream made no progress for ${inactivityTimeoutMs}ms`,
                "ICECAT_DISCOVERY_INACTIVITY_TIMEOUT",
                true
              );
              controller.abort(error);
              reject(error);
            }, inactivityTimeoutMs);
          }),
        ]).finally(() => clearTimeout(inactivityTimer));
        if (nextChunk.done) break;
        const chunk = nextChunk.value;
        for await (const readyPage of feedParser(decoder.write(chunk))) {
          yield readyPage;
          if (readyPage.done) {
            await cleanup();
            return;
          }
        }
      }

      if (!limitReached) {
        for await (const readyPage of feedParser(decoder.end())) yield readyPage;
        parser.close();
        await enrichCandidates();
        if (filesIndexSeen && fileElementsSeen > 0 && parsedFileRecords === 0) {
          throw new Error("Icecat files.index schema mismatch: file elements were present but none could be parsed");
        }
        flushPage();
      }

      while (readyPages.length) {
        const pageToYield = readyPages.shift()!;
        yield pageToYield;
        if (pageToYield.done) {
          limitReached = true;
          await cleanup();
          return;
        }
      }
    } finally {
      await cleanup?.();
      clearTimeout(requestTimeout);
    }
  }

  async lookupProducts(options: ProviderFetchOptions = {}): Promise<ProviderFetchResult<IcecatProduct>> {
    const lookups = [
      ...(options.productCodes ?? []).filter(Boolean).map((code) => ({ code, parameter: "productcode" as const })),
      ...(options.gtins ?? []).filter(Boolean).map((code) => ({ code, parameter: "ean_upc" as const })),
    ];
    const authHeaders = buildIcecatAuthHeaders(this.config);
    if (!lookups.length) throw new Error("Open Icecat requires product codes or GTINs; pass --product-code or set ICECAT_PRODUCT_CODES. Refusing an unbounded crawl.");
    const limit = Math.max(0, Math.min(options.limit ?? 10, 100));
    const pages = Math.max(1, Math.min(options.pages ?? Math.ceil(Math.max(limit, 1) / 10), 10));
    const selected = lookups.slice(0, Math.min(limit || lookups.length, pages * 10));
    const headers = { ...authHeaders, Accept: "application/xml" };
    const records: IcecatProduct[] = [];
    const errors: ProviderFetchError[] = [];
    for (const lookup of selected) {
      const retries = Math.max(0, Math.min(options.retries ?? 2, 5));
      let lastError: unknown;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const xml = await fetchWithTimeout(this.config.fetcher, buildRequestUrl(this.config.baseUrl, lookup.code, lookup.parameter, options, this.config.shopName), headers, options.timeoutMs ?? 15000);
          records.push(parseIcecatXml(xml));
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
        }
      }
      if (lastError) errors.push({ sourceExternalId: lookup.code, message: lastError instanceof Error ? lastError.message : String(lastError), retriable: true });
    }
    return { records, errors, fetched: selected.length, pages };
  }

  async fetchProducts(options: ProviderFetchOptions = {}): Promise<ProviderFetchResult<IcecatProduct>> {
    return this.lookupProducts(options);
  }
}
