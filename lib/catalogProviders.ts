import { XMLParser } from "fast-xml-parser";
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
  fetchProducts(options?: ProviderFetchOptions): Promise<ProviderFetchResult<TRaw>>;
  normalizeProduct(rawRecord: TRaw): CatalogCandidateInput;
  getSourceMetadata(): { name: string; type: string; baseUrl: string; metadata: Record<string, unknown> };
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

function getProductNode(parsed: Record<string, unknown>): IcecatProduct {
  const root = (parsed["ICECAT-interface"] ?? parsed["icecat-interface"] ?? parsed) as Record<string, unknown>;
  const product = root.Product ?? root.product ?? root.products;
  if (Array.isArray(product)) return (product[0] ?? {}) as IcecatProduct;
  return (product ?? root) as IcecatProduct;
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

export function normalizeIcecatProduct(rawRecord: IcecatProduct, mappings = DEFAULT_ICECAT_TAXONOMY): CatalogCandidateInput {
  const productId = first(attr(rawRecord, "Product_ID", "ProductId", "id"), text(rawRecord.Product_ID));
  const brand = first(attr(rawRecord, "Brand", "Manufacturer"), attr(rawRecord.Supplier, "Name", "name"), text(rawRecord.Brand), text(rawRecord.Manufacturer));
  const productName = first(attr(rawRecord, "Name", "ProductName"), text(rawRecord.Name), text(rawRecord.ProductName));
  const mpn = first(attr(rawRecord, "Prod_ID", "ProductCode", "MPN", "Model"), text(rawRecord.ProductCode), text(rawRecord.MPN));
  const gtin = first(attr(rawRecord, "EAN_UPC", "EAN", "UPC", "GTIN"), text(rawRecord.EAN_UPC), text(rawRecord.EAN), text(rawRecord.GTIN));
  const model = first(attr(rawRecord, "Model_Name", "Model"), text(rawRecord.Model_Name), mpn);
  const sourceCategory = categoryName(rawRecord);
  const taxonomy = mapIcecatCategory(sourceCategory, mappings);
  if (!productId || !brand || !productName) throw new Error("Icecat product is missing Product_ID, brand/manufacturer, or product name");

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
    sourceUrl: first(attr(rawRecord, "ProductURL", "URL"), text(rawRecord.ProductURL), text(rawRecord.URL)),
    sourceType: "open-icecat",
    raw: {
      provider: "open-icecat",
      providerProductId: productId,
      sourceCategory,
      taxonomyMapping: taxonomy,
      record: rawRecord,
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
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

export type OpenIcecatProviderOptions = {
  baseUrl?: string;
  shopName?: string;
  username?: string;
  password?: string;
  fetcher?: typeof fetch;
  taxonomy?: Record<string, TaxonomyMapping>;
};

export class OpenIcecatProvider implements CatalogProvider<IcecatProduct> {
  private readonly config: Required<Pick<OpenIcecatProviderOptions, "baseUrl" | "shopName" | "fetcher">> & OpenIcecatProviderOptions;

  constructor(options: OpenIcecatProviderOptions = {}) {
    this.config = {
      baseUrl: options.baseUrl ?? process.env.ICECAT_API_URL ?? "https://live.icecat.biz/api",
      shopName: options.shopName ?? process.env.ICECAT_SHOPNAME ?? "OpenIcecat-live",
      fetcher: options.fetcher ?? fetch,
      ...options,
    };
  }

  getSourceMetadata() {
    return {
      name: "Open Icecat",
      type: "external-provider",
      baseUrl: this.config.baseUrl,
      metadata: { provider: "open-icecat", accessMethod: "documented product lookup API", taxonomyMapping: "explicit configured mapping" },
    };
  }

  normalizeProduct(rawRecord: IcecatProduct): CatalogCandidateInput {
    return normalizeIcecatProduct(rawRecord, this.config.taxonomy ?? DEFAULT_ICECAT_TAXONOMY);
  }

  async fetchProducts(options: ProviderFetchOptions = {}): Promise<ProviderFetchResult<IcecatProduct>> {
    const lookups = [
      ...(options.productCodes ?? []).filter(Boolean).map((code) => ({ code, parameter: "productcode" as const })),
      ...(options.gtins ?? []).filter(Boolean).map((code) => ({ code, parameter: "ean_upc" as const })),
    ];
    if (!this.config.username || !this.config.password) {
      throw new Error("Open Icecat credentials are required for live access. Set ICECAT_USERNAME, ICECAT_PASSWORD, and optionally ICECAT_SHOPNAME.");
    }
    if (!lookups.length) throw new Error("Open Icecat requires product codes or GTINs; pass --product-code or set ICECAT_PRODUCT_CODES. Refusing an unbounded crawl.");
    const limit = Math.max(0, Math.min(options.limit ?? 10, 100));
    const pages = Math.max(1, Math.min(options.pages ?? Math.ceil(Math.max(limit, 1) / 10), 10));
    const selected = lookups.slice(0, Math.min(limit || lookups.length, pages * 10));
    const headers = { Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64")}`, Accept: "application/xml" };
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
}
