import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createGunzip, gunzipSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import { SaxesParser } from "saxes";
import type { CatalogCandidateInput } from "./catalogStagingTypes.ts";

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
  brand: string;
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
  raw: Record<string, unknown>;
};

function readIcecatIndexProducts(root: Record<string, unknown>): Record<string, unknown>[] {
  const fileEntry = root.file ?? root.files ?? root.File ?? root.Files ?? root;
  if (!fileEntry || typeof fileEntry !== "object") return [];
  const productNode = (fileEntry as Record<string, unknown>).Product ?? (fileEntry as Record<string, unknown>).product ?? (fileEntry as Record<string, unknown>).Products ?? (fileEntry as Record<string, unknown>).products;
  if (Array.isArray(productNode)) return productNode.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"));
  if (productNode && typeof productNode === "object") return [productNode as Record<string, unknown>];
  return Object.values(fileEntry as Record<string, unknown>).filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"));
}

export function parseIcecatIndexXml(xml: string): IcecatIndexRecord[] {
  if (!xml.trim()) throw new Error("Icecat index is empty");
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false }).parse(xml) as Record<string, unknown>;
  const root = (parsed["ICECAT-interface"] ?? parsed["icecat-interface"] ?? parsed) as Record<string, unknown>;
  const products = readIcecatIndexProducts(root);
  const records: IcecatIndexRecord[] = [];
  for (const product of products) {
    const productId = first(attr(product, "Product_ID", "ProductId"), text((product as Record<string, unknown>).Product_ID), text((product as Record<string, unknown>).ProductId));
    if (!productId) continue;
    const modelNumber = first(attr(product, "Model_Name", "ModelName"), text((product as Record<string, unknown>).Model_Name), text((product as Record<string, unknown>).ModelName), text((product as Record<string, unknown>).Prod_ID));
    const mpn = first(attr(product, "Prod_ID", "ProductCode", "MPN"), text((product as Record<string, unknown>).Prod_ID), text((product as Record<string, unknown>).ProductCode), text((product as Record<string, unknown>).MPN));
    const gtin = first(attr(product, "EAN_UPC", "EAN", "UPC", "GTIN"), text((product as Record<string, unknown>).EAN_UPC), text((product as Record<string, unknown>).EAN), text((product as Record<string, unknown>).GTIN));
    const country = first(attr(product, "Country"), text((product as Record<string, unknown>).Country));
    const updated = first(attr(product, "Updated"), text((product as Record<string, unknown>).Updated));
    const onMarket = normalizeIcecatBoolean(first(attr(product, "On_Market"), text((product as Record<string, unknown>).On_Market)) ?? "0");
    const category = first(attr(product, "Catid"), text((product as Record<string, unknown>).Catid));
    const brand = first(attr(product, "Brand", "Manufacturer"), text((product as Record<string, unknown>).Brand), text((product as Record<string, unknown>).Manufacturer), "Open Icecat") ?? "Open Icecat";
    const productName = first(attr(product, "Model_Name", "Name", "ProductName"), text((product as Record<string, unknown>).Model_Name), text((product as Record<string, unknown>).Name), text((product as Record<string, unknown>).ProductName), mpn, productId) ?? productId;
    records.push({
      sourceExternalId: String(productId),
      brand: String(brand),
      productName: String(productName),
      modelNumber: modelNumber ? String(modelNumber) : null,
      mpn: mpn ? String(mpn) : null,
      gtin: gtin ? String(gtin) : null,
      sourceUrl: null,
      category: category ? String(category) : null,
      subcategory: null,
      onMarket,
      country: country ? String(country) : null,
      updated: updated ? String(updated) : null,
      raw: {
        provider: "open-icecat",
        providerProductId: productId,
        record: product,
        sourceType: "open-icecat-index",
        categoryId: category,
        onMarket,
        country,
        updated,
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

export function normalizeIcecatProduct(rawRecord: IcecatProduct | IcecatIndexRecord, mappings = DEFAULT_ICECAT_TAXONOMY): CatalogCandidateInput {
  const productId = first(
    attr(rawRecord as Record<string, unknown>, "Product_ID", "ProductId", "id"),
    text((rawRecord as Record<string, unknown>).Product_ID),
    text((rawRecord as Record<string, unknown>).ProductId),
    typeof (rawRecord as IcecatIndexRecord).sourceExternalId === "string" ? (rawRecord as IcecatIndexRecord).sourceExternalId : null
  );
  const brand = first(
    attr(rawRecord as Record<string, unknown>, "Brand", "Manufacturer"),
    attr((rawRecord as Record<string, unknown>).Supplier, "Name", "name"),
    text((rawRecord as Record<string, unknown>).Brand),
    text((rawRecord as Record<string, unknown>).Manufacturer),
    typeof (rawRecord as IcecatIndexRecord).brand === "string" ? (rawRecord as IcecatIndexRecord).brand : null
  ) ?? "Open Icecat";
  const productName = first(
    attr(rawRecord as Record<string, unknown>, "Name", "ProductName"),
    text((rawRecord as Record<string, unknown>).Name),
    text((rawRecord as Record<string, unknown>).ProductName),
    typeof (rawRecord as IcecatIndexRecord).productName === "string" ? (rawRecord as IcecatIndexRecord).productName : null,
    typeof (rawRecord as IcecatIndexRecord).modelNumber === "string" ? (rawRecord as IcecatIndexRecord).modelNumber : null,
    typeof (rawRecord as IcecatIndexRecord).mpn === "string" ? (rawRecord as IcecatIndexRecord).mpn : null,
    typeof (rawRecord as IcecatIndexRecord).sourceExternalId === "string" ? (rawRecord as IcecatIndexRecord).sourceExternalId : null
  );
  const mpn = first(
    attr(rawRecord as Record<string, unknown>, "Prod_ID", "ProductCode", "MPN", "Model"),
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
    attr(rawRecord as Record<string, unknown>, "Model_Name", "Model"),
    text((rawRecord as Record<string, unknown>).Model_Name),
    text((rawRecord as Record<string, unknown>).Model),
    typeof (rawRecord as IcecatIndexRecord).modelNumber === "string" ? (rawRecord as IcecatIndexRecord).modelNumber : null,
    mpn
  );
  const sourceCategory = categoryName(rawRecord as IcecatProduct) ?? (rawRecord as IcecatIndexRecord).category ?? null;
  const taxonomy = mapIcecatCategory(sourceCategory, mappings);
  if (!productId || !brand || !productName) throw new Error("Icecat product is missing Product_ID, brand/manufacturer, or product name");

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
    sourceType: "open-icecat",
    raw: {
      provider: "open-icecat",
      providerProductId: productId,
      sourceCategory,
      taxonomyMapping: taxonomy,
      record: (rawRecord as Record<string, unknown>).record ?? rawRecord,
      sourceType: "open-icecat",
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
    const contentEncoding = response.headers.get("content-encoding")?.toLowerCase() ?? "";
    const isGzipPayload = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
    if (contentEncoding.includes("gzip") || (String(url).endsWith(".gz") && isGzipPayload)) {
      return gunzipSync(buffer).toString("utf8");
    }
    return buffer.toString("utf8");
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
    compressedStream.pipe(gunzip);
    try {
      for await (const chunk of gunzip) yield normalizeChunk(chunk);
    } finally {
      gunzip.destroy();
      compressedStream.destroy();
      await sourceIterator.return?.();
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
    const timeout = setTimeout(() => controller.abort(), 30000);
    const resumeCursor = decodeDiscoveryCursor(options.cursor ?? (typeof checkpoint.cursor === "string" ? checkpoint.cursor : null));
    const resumeEnabled = Boolean(resumeCursor.productId || resumeCursor.updated);
    let cleanup: (() => void) | undefined;

    try {
      const response = await this.config.fetcher(url, { headers, signal: controller.signal });
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
      let currentRecord: Record<string, string> | null = null;
      let page: IcecatIndexRecord[] = [];
      let pageErrors: ProviderFetchError[] = [];
      let readyPages: ProviderDiscoveryPage<IcecatIndexRecord>[] = [];
      let emittedCount = 0;
      let qualifyingCount = 0;
      let processedCount = 0;
      let lastSourceIdentity: string | null = null;
      let lastUpdatedValue: string | null = null;
      let limitReached = false;
      let resumeSatisfied = !resumeEnabled;

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

      cleanup = () => {
        void decompressedStream.return(undefined);
        if (!bodyStream.destroyed) bodyStream.destroy();
      };

      parser.on("opentag", (node) => {
        if (limitReached) return;
        if (node.name === "Product") {
          currentRecord = { ...(node.attributes as Record<string, unknown> as Record<string, string>) };
        }
      });

      parser.on("closetag", (node) => {
        if (limitReached) return;
        if (node.name !== "Product" || !currentRecord) return;

        processedCount += 1;
        options.diagnostics?.onRecordSeen?.();
        const productId = first(currentRecord.Product_ID, currentRecord.ProductId, currentRecord.id);
        const productBrand = first(currentRecord.Brand, currentRecord.Manufacturer, currentRecord.Supplier_Name, currentRecord.Supplier);
        const productName = first(currentRecord.Model_Name, currentRecord.Name, currentRecord.ProductName, currentRecord.Prod_ID);
        if (!productId || !productBrand || !productName) {
          pageErrors.push({
            sourceExternalId: productId ?? undefined,
            message: "Icecat index record is missing Product_ID, brand/manufacturer, or product name",
            retriable: false,
          });
          currentRecord = null;
          if (page.length + pageErrors.length >= pageSize) flushPage();
          return;
        }
        const updated = first(currentRecord.Updated, currentRecord.updated) ?? null;
        const onMarket = normalizeIcecatBoolean(first(currentRecord.On_Market, currentRecord.onMarket) ?? "0");
        const category = first(currentRecord.Catid, currentRecord.category, currentRecord.CategoryId) ?? null;
        const country = first(currentRecord.Country, currentRecord.country) ?? null;
        const gtin = first(currentRecord.EAN_UPC, currentRecord.EAN, currentRecord.UPC, currentRecord.GTIN) ?? null;
        const mpn = first(currentRecord.Prod_ID, currentRecord.ProductCode, currentRecord.MPN) ?? null;
        const modelNumber = first(currentRecord.Model_Name, currentRecord.ModelName, currentRecord.Model, mpn) ?? null;
        const record: IcecatIndexRecord = {
          sourceExternalId: String(productId),
          brand: String(productBrand),
          productName: String(productName),
          modelNumber: modelNumber ? String(modelNumber) : null,
          mpn: mpn ? String(mpn) : null,
          gtin: gtin ? String(gtin) : null,
          sourceUrl: null,
          category: category ? String(category) : null,
          subcategory: null,
          onMarket,
          country: country ? String(country) : null,
          updated: updated ? String(updated) : null,
          raw: {
            provider: "open-icecat",
            providerProductId: productId,
            record: currentRecord,
            sourceType: "open-icecat-index",
            categoryId: category,
            onMarket,
            country,
            updated,
          },
        };

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
            currentRecord = null;
            return;
          }
          resumeSatisfied = true;
        }

        if (!matchesDiscoveryFilter(record, options)) {
          currentRecord = null;
          return;
        }

        qualifyingCount += 1;
        options.diagnostics?.onRecordQualified?.();
        lastSourceIdentity = record.sourceExternalId;
        lastUpdatedValue = record.updated ?? lastUpdatedValue;
        page.push(record);

        if (page.length + pageErrors.length >= pageSize || (limit > 0 && qualifyingCount >= limit)) {
          flushPage();
        }

        currentRecord = null;
      });

      parser.on("error", (error) => {
        if (limitReached) return;
        throw error;
      });

      const feedParser = async function* (textChunk: string): AsyncGenerator<ProviderDiscoveryPage<IcecatIndexRecord>> {
        const maxParserFeedChars = 1024;
        for (let offset = 0; offset < textChunk.length && !limitReached; offset += maxParserFeedChars) {
          parser.write(textChunk.slice(offset, offset + maxParserFeedChars));
          while (readyPages.length) {
            yield readyPages.shift()!;
          }
        }
      };

      for await (const chunk of decompressedStream) {
        for await (const readyPage of feedParser(decoder.write(chunk))) {
          yield readyPage;
          if (readyPage.done) {
            cleanup();
            return;
          }
        }
      }

      if (!limitReached) {
        for await (const readyPage of feedParser(decoder.end())) yield readyPage;
        parser.close();
        flushPage();
      }

      while (readyPages.length) {
        const pageToYield = readyPages.shift()!;
        yield pageToYield;
        if (pageToYield.done) {
          limitReached = true;
          cleanup();
          return;
        }
      }
    } finally {
      cleanup?.();
      clearTimeout(timeout);
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
