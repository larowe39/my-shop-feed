import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";
import { SaxesParser } from "saxes";
import type { ExternalTaxonomyIdentity } from "./catalogStagingTypes.ts";

export const OPEN_ICECAT_CATEGORIES_URL = "https://data.icecat.biz/export/freexml/refs/CategoriesList.xml.gz";
const OPEN_ICECAT_LANGUAGE_ID = "1";
const CACHE_VERSION = 1;

type ParsedCategory = {
  id: string;
  name: string | null;
  parentId: string | null;
};

type TaxonomyCache = {
  version: number;
  provider: "open-icecat";
  sourceUrl: string;
  fetchedAt: string;
  identities: ExternalTaxonomyIdentity[];
};

export function getOpenIcecatTaxonomyCachePath(): string {
  return process.env.ICECAT_TAXONOMY_CACHE_PATH || path.join(process.cwd(), ".catalog-staging", "open-icecat-categories.en.json");
}

function buildIdentities(categories: ParsedCategory[]): ExternalTaxonomyIdentity[] {
  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  const identities = new Map<string, ExternalTaxonomyIdentity>();

  const resolve = (id: string, visiting = new Set<string>()): ExternalTaxonomyIdentity => {
    const existing = identities.get(id);
    if (existing) return existing;
    const category = categoriesById.get(id);
    if (!category) return { provider: "open-icecat", externalId: id, name: null, path: null, parentId: null, parentName: null, parentPath: null };
    if (visiting.has(id)) throw new Error(`Open Icecat category hierarchy contains a cycle at ${id}`);
    const nextVisiting = new Set(visiting).add(id);
    const parent = category.parentId ? resolve(category.parentId, nextVisiting) : null;
    const segment = category.name ? `${category.id} ${category.name}` : category.id;
    const identity: ExternalTaxonomyIdentity = {
      provider: "open-icecat",
      externalId: category.id,
      name: category.name,
      path: parent?.path ? `${parent.path} > ${segment}` : segment,
      parentId: category.parentId,
      parentName: parent?.name ?? null,
      parentPath: parent?.path ?? null,
    };
    identities.set(id, identity);
    return identity;
  };

  for (const category of categories) resolve(category.id);
  return categories.map((category) => identities.get(category.id)!);
}

export async function parseOpenIcecatCategories(source: AsyncIterable<string | Buffer>): Promise<ExternalTaxonomyIdentity[]> {
  const categories: ParsedCategory[] = [];
  let current: ParsedCategory | null = null;
  let currentDepth = 0;
  const elementStack: string[] = [];
  const parser = new SaxesParser();
  parser.on("opentag", (node) => {
    const attributes = node.attributes as Record<string, string>;
    const parent = elementStack[elementStack.length - 1];
    const grandparent = elementStack[elementStack.length - 2];
    if (node.name === "Category" && parent === "CategoriesList") {
      const id = String(attributes.ID ?? "").trim();
      current = id ? { id, name: null, parentId: null } : null;
      currentDepth = elementStack.length + 1;
    } else if (current && node.name === "ParentCategory" && parent === "Category" && elementStack.length === currentDepth) {
      const parentId = String(attributes.ID ?? "").trim() || null;
      current.parentId = parentId === current.id ? null : parentId;
    } else if (
      current &&
      node.name === "Name" &&
      ((parent === "Category" && elementStack.length === currentDepth) ||
        (parent === "Names" && grandparent === "Category" && elementStack.length === currentDepth + 1)) &&
      String(attributes.langid ?? "") === OPEN_ICECAT_LANGUAGE_ID
    ) {
      current.name = String(attributes.Value ?? "").trim() || null;
    }
    elementStack.push(node.name);
  });
  parser.on("closetag", (node) => {
    if (node.name === "Category" && current && elementStack.length === currentDepth) {
      categories.push(current);
      current = null;
      currentDepth = 0;
    }
    elementStack.pop();
  });
  for await (const chunk of source) parser.write(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  parser.close();
  return buildIdentities(categories);
}

export async function parseOpenIcecatCategoriesXml(xml: string): Promise<ExternalTaxonomyIdentity[]> {
  return parseOpenIcecatCategories((async function* () { yield xml; })());
}

export function loadOpenIcecatTaxonomyCache(cachePath = getOpenIcecatTaxonomyCachePath()): Map<string, ExternalTaxonomyIdentity> {
  if (!fs.existsSync(cachePath)) return new Map();
  const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as TaxonomyCache;
  if (parsed.version !== CACHE_VERSION || parsed.provider !== "open-icecat" || !Array.isArray(parsed.identities)) {
    throw new Error(`Unsupported Open Icecat taxonomy cache format at ${cachePath}`);
  }
  return new Map(parsed.identities.map((identity) => [identity.externalId, identity]));
}

export function saveOpenIcecatTaxonomyCache(
  identities: ExternalTaxonomyIdentity[],
  options: { cachePath?: string; sourceUrl?: string; fetchedAt?: string } = {}
): string {
  const cachePath = options.cachePath ?? getOpenIcecatTaxonomyCachePath();
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const cache: TaxonomyCache = {
    version: CACHE_VERSION,
    provider: "open-icecat",
    sourceUrl: options.sourceUrl ?? OPEN_ICECAT_CATEGORIES_URL,
    fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    identities,
  };
  fs.writeFileSync(cachePath, JSON.stringify(cache));
  return cachePath;
}

export async function fetchOpenIcecatTaxonomy(options: {
  headers: Record<string, string>;
  endpoint?: string;
  fetcher?: typeof fetch;
}): Promise<ExternalTaxonomyIdentity[]> {
  const endpoint = options.endpoint ?? OPEN_ICECAT_CATEGORIES_URL;
  const response = await (options.fetcher ?? fetch)(endpoint, {
    headers: { ...options.headers, Accept: "application/xml, application/gzip, */*" },
  });
  if (!response.ok) throw new Error(`Icecat taxonomy HTTP ${response.status} ${response.statusText}`);
  if (!response.body) throw new Error("Icecat taxonomy response has no body");

  const compressed = Readable.fromWeb(response.body as never);
  const gunzip = createGunzip();
  compressed.pipe(gunzip);
  const decoder = new StringDecoder("utf8");
  try {
    return await parseOpenIcecatCategories((async function* () {
      for await (const chunk of gunzip) yield decoder.write(chunk as Buffer);
      const remaining = decoder.end();
      if (remaining) yield remaining;
    })());
  } finally {
    gunzip.destroy();
    compressed.destroy();
  }
}
