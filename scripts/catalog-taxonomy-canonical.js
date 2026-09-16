#!/usr/bin/env node
require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });

const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { getFlagValue } = require("./lib/cliArgs");
const { loadAndValidateCatalogData } = require("./lib/catalogDataLoader");

const args = process.argv.slice(2);
const backend = getFlagValue(args, "--backend") || "supabase";
const visibleOnly = args.includes("--visible-only");
const dataDir = path.join(__dirname, "..", "catalog-data");

function printTree(categories, subcategories, isDiscoveryVisible) {
  const childrenByParent = new Map();
  for (const row of subcategories) {
    const key = row.parent_subcategory_id || `category:${row.category_id}`;
    childrenByParent.set(key, [...(childrenByParent.get(key) || []), row]);
  }
  for (const category of categories.sort((left, right) => left.sort_order - right.sort_order)) {
    const visible = isDiscoveryVisible(category.slug);
    if (visibleOnly && !visible) continue;
    console.log(`${category.name} [${category.slug}] | ${visible ? "discovery-visible" : "internal-only"}`);
    function walk(parentId, depth) {
      for (const subcategory of (childrenByParent.get(parentId) || []).sort((left, right) => left.sort_order - right.sort_order)) {
        console.log(`${"  ".repeat(depth)}- ${subcategory.name} [${subcategory.slug}] | internal-only`);
        walk(subcategory.id, depth + 1);
      }
    }
    walk(`category:${category.id}`, 1);
  }
}

async function main() {
  const { isDiscoveryCategoryVisible } = await import("../lib/discoveryTaxonomy.ts");
  const { normalizeCatalogText } = await import("../lib/catalogMatching.ts");
  if (backend === "local") {
    const loaded = loadAndValidateCatalogData(dataDir, normalizeCatalogText);
    if (loaded.errors.length) throw new Error(`catalog-data validation failed with ${loaded.errors.length} error(s)`);
    const categories = [...loaded.taxonomy.categories.values()].map((row) => ({ id: row.slug, slug: row.slug, name: row.name, sort_order: row.sortOrder || 0 }));
    const subcategories = [...loaded.taxonomy.subcategoryByPath.values()].map((row) => ({
      id: row.path.join("/"),
      category_id: row.categorySlug,
      parent_subcategory_id: row.path.length > 1 ? row.path.slice(0, -1).join("/") : null,
      slug: row.path[row.path.length - 1],
      name: row.name,
      sort_order: row.sortOrder || 0,
    }));
    console.log("CANONICAL TAXONOMY BACKEND: local catalog-data");
    printTree(categories, subcategories, isDiscoveryCategoryVisible);
    return;
  }

  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase canonical taxonomy inspection requires EXPO_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const [{ data: categories, error: categoryError }, { data: subcategories, error: subcategoryError }] = await Promise.all([
    supabase.from("catalog_categories").select("id, slug, name, sort_order"),
    supabase.from("catalog_subcategories").select("id, category_id, parent_subcategory_id, slug, name, sort_order"),
  ]);
  if (categoryError) throw categoryError;
  if (subcategoryError) throw subcategoryError;
  console.log("CANONICAL TAXONOMY BACKEND: supabase read-only");
  printTree(categories || [], subcategories || [], isDiscoveryCategoryVisible);
}

main().catch((error) => { console.error(error.message || error); process.exit(1); });
