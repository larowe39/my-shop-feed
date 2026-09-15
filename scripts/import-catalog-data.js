#!/usr/bin/env node
// scripts/import-catalog-data.js
//
// Data-driven importer for the canonical catalog (catalog-data/*.json ->
// public.catalog_* tables). See docs/catalog-data.md for the full format and
// safety rules. Short version:
//
//   npm run catalog:import               (no flag => --dry-run, no writes)
//   npm run catalog:import -- --dry-run  (explicit, same as above)
//   npm run catalog:import -- --apply    (writes to Supabase)
//
// Import order (FK dependency order): categories -> subcategories -> brands
// -> families -> products -> variants -> aliases. Every entity is matched
// against the database by its stable natural key (slug, or a composite of
// slugs) — never by hardcoded UUID — so re-running the importer is
// idempotent: unchanged rows are left alone, only real differences produce
// UPDATEs, and nothing is ever deleted.
//
// This script NEVER touches public.products (user listings), moderation
// state, likes/saves/follows, or existing catalog rows it doesn't recognize.
// It only ever writes to the seven public.catalog_* tables.
//
// REQUIRES SUPABASE_SERVICE_ROLE_KEY in a local, gitignored .env.local (same
// requirement as scripts/backfill-catalog-matches.js). Never expose this key
// to Expo/client code.

const path = require("path");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
require("dotenv").config({ path: ".env.local", override: true });

const { loadAndValidateCatalogData } = require("./lib/catalogDataLoader");

const CATALOG_DATA_DIR = path.join(__dirname, "..", "catalog-data");
// Bounded batch size for inserts so a future catalog with hundreds of
// thousands of rows never gets sent to Supabase (or held in memory as one
// request) all at once. Updates are applied one row at a time below because
// they're expected to stay a small minority of any given import (metadata
// corrections), not the bulk of the traffic.
const INSERT_BATCH_SIZE = 500;
const FETCH_PAGE_SIZE = 1000;

function chunk(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

async function loadCatalogMatching() {
  const mod = await import("../lib/catalogMatching.ts");
  return mod;
}

async function fetchAllRows(supabase, table, select) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase.from(table).select(select).range(from, from + FETCH_PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < FETCH_PAGE_SIZE) break;
    from += FETCH_PAGE_SIZE;
  }
  return rows;
}

function fieldsDiffer(existing, desired, fields) {
  return fields.some((field) => {
    const a = existing[field] ?? null;
    const b = desired[field] ?? null;
    if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) !== JSON.stringify(b);
    return a !== b;
  });
}

// Generic level processor shared by categories/brands/families/products/
// variants. Subcategories and aliases have slightly different key/parent
// semantics and are handled by their own (similar) blocks below.
function classify(desiredList, existingByKey, keyFn, fields) {
  const toInsert = [];
  const toUpdate = [];
  let unchanged = 0;
  const idByKey = new Map();

  for (const desired of desiredList) {
    const key = keyFn(desired);
    const existing = existingByKey.get(key);
    if (!existing) {
      toInsert.push(desired);
      continue;
    }
    idByKey.set(key, existing.id);
    if (fieldsDiffer(existing, desired.row, fields)) {
      toUpdate.push({ id: existing.id, row: desired.row, key, label: desired.label });
    } else {
      unchanged += 1;
    }
  }

  return { toInsert, toUpdate, unchanged, idByKey };
}

async function insertBatched(supabase, table, rows, selectCols) {
  const inserted = [];
  for (const batch of chunk(rows, INSERT_BATCH_SIZE)) {
    if (!batch.length) continue;
    const { data, error } = await supabase.from(table).insert(batch.map((r) => r.row)).select(selectCols);
    if (error) throw new Error(`Insert into ${table} failed: ${error.message}`);
    inserted.push(...(data ?? []));
  }
  return inserted;
}

async function updateOneByOne(supabase, table, updates) {
  let count = 0;
  for (const update of updates) {
    const { error } = await supabase.from(table).update(update.row).eq("id", update.id);
    if (error) throw new Error(`Update ${table}.${update.id} failed: ${error.message}`);
    count += 1;
  }
  return count;
}

function printSummary(name, counts) {
  console.log(`${name}`);
  console.log(`  Insert: ${counts.insert}`);
  if (counts.update !== undefined) console.log(`  Update: ${counts.update}`);
  console.log(`  Unchanged: ${counts.unchanged}`);
  if (counts.conflict !== undefined) console.log(`  Conflict: ${counts.conflict}`);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const dryRun = !apply; // default-safe: no flag => dry run, same as --dry-run

  const { normalizeCatalogText } = await loadCatalogMatching();
  const loaded = loadAndValidateCatalogData(CATALOG_DATA_DIR, normalizeCatalogText);

  if (loaded.fileCount === 0) {
    console.log(`No catalog-data files found under ${path.relative(process.cwd(), CATALOG_DATA_DIR)}/. Nothing to import.`);
    return;
  }

  if (loaded.errors.length > 0) {
    console.error(`\ncatalog-data failed validation (${loaded.errors.length} error(s)). Fix these before importing:\n`);
    for (const { file, entity, problem } of loaded.errors) {
      console.error(file);
      console.error(entity);
      console.error(`ERROR: ${problem}\n`);
    }
    process.exit(1);
  }

  console.log(`Loaded ${loaded.fileCount} valid catalog-data file(s).`);
  console.log(`Mode: ${dryRun ? "DRY RUN (no writes)" : "APPLY (writing to database)"}\n`);

  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl) {
    console.error("Missing EXPO_PUBLIC_SUPABASE_URL in .env");
    process.exit(1);
  }
  if (!serviceRoleKey) {
    console.error(
      "\nMissing SUPABASE_SERVICE_ROLE_KEY.\n" +
        "Catalog import writes canonical rows visible to every user, which requires\n" +
        "bypassing RLS, so it must not run with the anon key. Add it to a local,\n" +
        "gitignored `.env.local` file:\n\n" +
        "  SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here\n\n" +
        "Find it in Supabase Dashboard -> Project Settings -> API -> service_role.\n" +
        "Never commit this key or use an EXPO_PUBLIC_ prefix for it.\n"
    );
    process.exit(1);
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ---- 1. Categories ----
  const existingCategories = await fetchAllRows(supabase, "catalog_categories", "id, slug, name, description, sort_order");
  const existingCategoryByKey = new Map(existingCategories.map((c) => [c.slug, c]));
  const categoryIdToSlug = new Map(existingCategories.map((c) => [c.id, c.slug]));

  const desiredCategories = [...loaded.taxonomy.categories.values()].map((c) => ({
    label: `Category: ${c.slug}`,
    row: { slug: c.slug, name: c.name, description: c.description ?? null, sort_order: c.sortOrder ?? 0 },
  }));
  const categoryPlan = classify(desiredCategories, existingCategoryByKey, (d) => d.row.slug, [
    "name",
    "description",
    "sort_order",
  ]);

  // ---- 2. Subcategories (processed in taxonomy-walk order, so parents are
  // always resolved before their children within the same run) ----
  const existingSubcategories = await fetchAllRows(
    supabase,
    "catalog_subcategories",
    "id, category_id, parent_subcategory_id, slug, name, description, sort_order"
  );
  const subIdToPathKey = new Map();
  for (const sub of existingSubcategories) {
    const categorySlug = categoryIdToSlug.get(sub.category_id);
    if (categorySlug) subIdToPathKey.set(sub.id, categorySlug);
  }
  // Build existing path-key ("categorySlug::a/b/c") -> row, resolving parent
  // chains via the id map above.
  const existingSubcategoryByPathKey = new Map();
  {
    const byId = new Map(existingSubcategories.map((s) => [s.id, s]));
    function resolvePath(sub) {
      const parts = [sub.slug];
      let current = sub;
      while (current.parent_subcategory_id) {
        current = byId.get(current.parent_subcategory_id);
        if (!current) return null;
        parts.unshift(current.slug);
      }
      const categorySlug = categoryIdToSlug.get(sub.category_id);
      return categorySlug ? `${categorySlug}::${parts.join("/")}` : null;
    }
    for (const sub of existingSubcategories) {
      const key = resolvePath(sub);
      if (key) existingSubcategoryByPathKey.set(key, sub);
    }
  }

  const desiredSubcategories = [...loaded.taxonomy.subcategoryByPath.entries()].map(([pathKey, sub]) => ({
    label: `Subcategory: ${pathKey}`,
    pathKey,
    categorySlug: sub.categorySlug,
    parentPath: sub.path.slice(0, -1),
    slug: sub.path[sub.path.length - 1],
    name: sub.name,
    description: sub.description ?? null,
    sortOrder: sub.sortOrder ?? 0,
  }));

  // ---- 3. Brands ----
  const existingBrands = await fetchAllRows(supabase, "catalog_brands", "id, slug, name, website_url, logo_url, description");
  const existingBrandByKey = new Map(existingBrands.map((b) => [b.slug, b]));
  const desiredBrands = loaded.brands.map((b) => ({
    label: `Brand: ${b.slug}`,
    row: {
      slug: b.slug,
      name: b.name,
      website_url: b.websiteUrl ?? null,
      logo_url: b.logoUrl ?? null,
      description: b.description ?? null,
    },
  }));
  const brandPlan = classify(desiredBrands, existingBrandByKey, (d) => d.row.slug, [
    "name",
    "website_url",
    "logo_url",
    "description",
  ]);

  // ---- 4. Families ----
  const existingFamilies = await fetchAllRows(supabase, "catalog_product_families", "id, brand_id, subcategory_id, slug, name, description");
  const brandIdToSlug = new Map(existingBrands.map((b) => [b.id, b.slug]));
  const existingFamilyByKey = new Map(
    existingFamilies.map((f) => [`${brandIdToSlug.get(f.brand_id)}::${f.slug}`, f])
  );
  const desiredFamilies = loaded.families.map((f) => ({
    label: `Family: ${f.brandSlug}/${f.slug}`,
    key: `${f.brandSlug}::${f.slug}`,
    brandSlug: f.brandSlug,
    subcategoryKey: f.subcategoryKey,
    row: { slug: f.slug, name: f.name, description: f.description ?? null },
  }));

  // ---- 5. Products ----
  const existingProducts = await fetchAllRows(
    supabase,
    "catalog_products",
    "id, brand_id, family_id, subcategory_id, slug, name, model_number, release_year, description, upc, gtin, mpn, status, attributes"
  );
  const existingProductByKey = new Map(existingProducts.map((p) => [p.slug, p]));
  const desiredProducts = loaded.products.map((p) => ({
    label: `Product: ${p.brandSlug} ${p.name}`,
    key: p.slug,
    brandSlug: p.brandSlug,
    familyKey: p.family ? `${p.brandSlug}::${p.family}` : null,
    subcategoryKey: p.subcategoryKey,
    row: {
      slug: p.slug,
      name: p.name,
      model_number: p.modelNumber ?? null,
      release_year: p.releaseYear ?? null,
      description: p.description ?? null,
      upc: p.upc ?? null,
      gtin: p.gtin ?? null,
      mpn: p.mpn ?? null,
      status: p.status ?? "active",
      attributes: p.source ? { ...(p.attributes ?? {}), source: p.source } : p.attributes ?? {},
    },
  }));

  // ---- 6. Variants ----
  const existingVariants = await fetchAllRows(
    supabase,
    "catalog_product_variants",
    "id, product_id, slug, name, sku, upc, gtin, color, size, attributes"
  );
  const productIdToSlug = new Map(existingProducts.map((p) => [p.id, p.slug]));
  const existingVariantByKey = new Map(
    existingVariants.map((v) => [`${productIdToSlug.get(v.product_id)}::${v.slug}`, v])
  );
  const desiredVariants = [];
  for (const p of loaded.products) {
    for (const v of p.variants ?? []) {
      desiredVariants.push({
        label: `Variant: ${p.name} / ${v.name}`,
        key: `${p.slug}::${v.slug}`,
        productSlug: p.slug,
        row: {
          slug: v.slug,
          name: v.name,
          sku: v.sku ?? null,
          upc: v.upc ?? null,
          gtin: v.gtin ?? null,
          color: v.color ?? null,
          size: v.size ?? null,
          attributes: v.attributes ?? {},
        },
      });
    }
  }

  // ---- 7. Aliases ----
  const existingAliases = await fetchAllRows(supabase, "catalog_aliases", "id, entity_type, entity_id, normalized_alias");
  const existingAliasByKey = new Map(existingAliases.map((a) => [`${a.entity_type}::${a.normalized_alias}`, a]));

  const desiredAliases = [];
  function pushAliases(entityType, entityKey, aliases, label) {
    for (const alias of aliases ?? []) {
      const normalized = normalizeCatalogText(alias);
      desiredAliases.push({
        label: `${label} alias "${alias}"`,
        key: `${entityType}::${normalized}`,
        entityType,
        resolveEntityKey: entityKey,
        alias,
        normalized,
      });
    }
  }
  for (const b of loaded.brands) pushAliases("brand", b.slug, b.aliases, `Brand ${b.slug}`);
  for (const f of loaded.families) pushAliases("family", `${f.brandSlug}::${f.slug}`, f.aliases, `Family ${f.brandSlug}/${f.slug}`);
  for (const p of loaded.products) {
    pushAliases("product", p.slug, p.aliases, `Product ${p.name}`);
    for (const v of p.variants ?? []) {
      pushAliases("variant", `${p.slug}::${v.slug}`, v.aliases, `Variant ${p.name}/${v.name}`);
    }
  }

  // ================= Apply-order execution =================
  // Each level resolves parent ids from either the pre-existing snapshot or
  // (in --apply mode) ids just inserted/updated at the previous level. In
  // --dry-run mode we never need a real id for a not-yet-existing parent, so
  // resolvers fall back to null and downstream classification still works
  // correctly for insert/update/unchanged/conflict reporting.

  console.log("Categories");
  console.log(`  Insert: ${categoryPlan.toInsert.length}`);
  console.log(`  Update: ${categoryPlan.toUpdate.length}`);
  console.log(`  Unchanged: ${categoryPlan.unchanged}`);

  let categoryIdBySlug = new Map(existingCategories.map((c) => [c.slug, c.id]));
  if (apply) {
    const inserted = await insertBatched(supabase, "catalog_categories", categoryPlan.toInsert, "id, slug");
    for (const row of inserted) categoryIdBySlug.set(row.slug, row.id);
    await updateOneByOne(supabase, "catalog_categories", categoryPlan.toUpdate);
  }

  // Subcategories: `desiredSubcategories` is already in taxonomy-walk order
  // (parents before children — see catalogDataLoader's walkSubcategories),
  // so processing it in a single forward pass means a brand-new parent's id
  // is always in `subIdByPathKey` before its children are reached.
  function parentPathKeyOf(pathKey) {
    const [categorySlug, pathStr] = pathKey.split("::");
    const parts = pathStr.split("/");
    return parts.length > 1 ? `${categorySlug}::${parts.slice(0, -1).join("/")}` : null;
  }

  const subcategoryCounts = { insert: 0, update: 0, unchanged: 0 };
  const subcategoryToInsert = [];
  const subcategoryToUpdate = [];
  const subIdByPathKey = new Map();
  for (const desired of desiredSubcategories) {
    const existing = existingSubcategoryByPathKey.get(desired.pathKey);
    if (existing) subIdByPathKey.set(desired.pathKey, existing.id);
    const row = {
      slug: desired.slug,
      name: desired.name,
      description: desired.description,
      sort_order: desired.sortOrder,
    };
    if (!existing) {
      subcategoryCounts.insert += 1;
      subcategoryToInsert.push({ pathKey: desired.pathKey, categorySlug: desired.categorySlug, row });
      continue;
    }
    if (fieldsDiffer(existing, row, ["name", "description", "sort_order"])) {
      subcategoryCounts.update += 1;
      subcategoryToUpdate.push({ id: existing.id, row: { name: row.name, description: row.description, sort_order: row.sort_order } });
    } else {
      subcategoryCounts.unchanged += 1;
    }
  }
  printSummary("Subcategories", subcategoryCounts);

  if (apply) {
    // One insert per row (not batched): each row's parent_subcategory_id can
    // depend on the row immediately before it in taxonomy-walk order.
    for (const item of subcategoryToInsert) {
      const parentPathKey = parentPathKeyOf(item.pathKey);
      const row = {
        ...item.row,
        category_id: categoryIdBySlug.get(item.categorySlug) ?? null,
        parent_subcategory_id: parentPathKey ? subIdByPathKey.get(parentPathKey) ?? null : null,
      };
      const { data, error } = await supabase.from("catalog_subcategories").insert(row).select("id").single();
      if (error) throw new Error(`Insert into catalog_subcategories failed: ${error.message}`);
      subIdByPathKey.set(item.pathKey, data.id);
    }
    await updateOneByOne(supabase, "catalog_subcategories", subcategoryToUpdate);
  }

  printSummary("Brands", { insert: brandPlan.toInsert.length, update: brandPlan.toUpdate.length, unchanged: brandPlan.unchanged });
  let brandIdBySlug = new Map(existingBrands.map((b) => [b.slug, b.id]));
  if (apply) {
    const inserted = await insertBatched(supabase, "catalog_brands", brandPlan.toInsert, "id, slug");
    for (const row of inserted) brandIdBySlug.set(row.slug, row.id);
    await updateOneByOne(supabase, "catalog_brands", brandPlan.toUpdate);
  }

  // Families
  const familyCounts = { insert: 0, update: 0, unchanged: 0 };
  const familyToInsert = [];
  const familyToUpdate = [];
  let familyIdByKey = new Map(
    existingFamilies.map((f) => [`${brandIdToSlug.get(f.brand_id)}::${f.slug}`, f.id])
  );
  for (const desired of desiredFamilies) {
    const existing = existingFamilyByKey.get(desired.key);
    const brandId = apply ? brandIdBySlug.get(desired.brandSlug) ?? null : null;
    const subcategoryId = desired.subcategoryKey && apply ? subIdByPathKey.get(desired.subcategoryKey) ?? null : null;
    const row = { ...desired.row, brand_id: brandId, subcategory_id: subcategoryId };
    if (!existing) {
      familyCounts.insert += 1;
      familyToInsert.push({ key: desired.key, row });
      continue;
    }
    if (fieldsDiffer(existing, row, ["name", "description"])) {
      familyCounts.update += 1;
      familyToUpdate.push({ id: existing.id, row: { name: row.name, description: row.description } });
    } else {
      familyCounts.unchanged += 1;
    }
  }
  printSummary("Product families", familyCounts);
  if (apply) {
    for (const batch of chunk(familyToInsert, INSERT_BATCH_SIZE)) {
      if (!batch.length) continue;
      // Postgres preserves row order for a multi-row INSERT ... RETURNING, so
      // zip the returned ids back onto `batch` by index rather than trying to
      // reverse-resolve a natural key from the raw returned columns.
      const { data, error } = await supabase
        .from("catalog_product_families")
        .insert(batch.map((b) => b.row))
        .select("id");
      if (error) throw new Error(`Insert into catalog_product_families failed: ${error.message}`);
      (data ?? []).forEach((row, i) => familyIdByKey.set(batch[i].key, row.id));
    }
    await updateOneByOne(supabase, "catalog_product_families", familyToUpdate);
  }

  // Products
  const productCounts = { insert: 0, update: 0, unchanged: 0 };
  const productToInsert = [];
  const productToUpdate = [];
  let productIdBySlug = new Map(existingProducts.map((p) => [p.slug, p.id]));
  for (const desired of desiredProducts) {
    const existing = existingProductByKey.get(desired.key);
    const brandId = apply ? brandIdBySlug.get(desired.brandSlug) ?? null : null;
    const familyId = desired.familyKey && apply ? familyIdByKey.get(desired.familyKey) ?? null : null;
    const subcategoryId = desired.subcategoryKey && apply ? subIdByPathKey.get(desired.subcategoryKey) ?? null : null;
    const row = { ...desired.row, brand_id: brandId, family_id: familyId, subcategory_id: subcategoryId };
    if (!existing) {
      productCounts.insert += 1;
      productToInsert.push({ key: desired.key, row });
      continue;
    }
    if (fieldsDiffer(existing, row, ["name", "model_number", "release_year", "description", "upc", "gtin", "mpn", "status", "attributes"])) {
      productCounts.update += 1;
      productToUpdate.push({
        id: existing.id,
        row: {
          name: row.name,
          model_number: row.model_number,
          release_year: row.release_year,
          description: row.description,
          upc: row.upc,
          gtin: row.gtin,
          mpn: row.mpn,
          status: row.status,
          attributes: row.attributes,
        },
      });
    } else {
      productCounts.unchanged += 1;
    }
  }
  printSummary("Products", productCounts);
  if (apply) {
    for (const batch of chunk(productToInsert, INSERT_BATCH_SIZE)) {
      if (!batch.length) continue;
      const { data, error } = await supabase.from("catalog_products").insert(batch.map((b) => b.row)).select("id, slug");
      if (error) throw new Error(`Insert into catalog_products failed: ${error.message}`);
      for (const row of data ?? []) productIdBySlug.set(row.slug, row.id);
    }
    await updateOneByOne(supabase, "catalog_products", productToUpdate);
  }

  // Variants
  const variantCounts = { insert: 0, update: 0, unchanged: 0 };
  const variantToInsert = [];
  const variantToUpdate = [];
  let variantIdByKey = new Map(existingVariants.map((v) => [`${productIdToSlug.get(v.product_id)}::${v.slug}`, v.id]));
  for (const desired of desiredVariants) {
    const existing = existingVariantByKey.get(desired.key);
    const productId = apply ? productIdBySlug.get(desired.productSlug) ?? null : null;
    const row = { ...desired.row, product_id: productId };
    if (!existing) {
      variantCounts.insert += 1;
      variantToInsert.push({ key: desired.key, row });
      continue;
    }
    if (fieldsDiffer(existing, row, ["name", "sku", "upc", "gtin", "color", "size", "attributes"])) {
      variantCounts.update += 1;
      variantToUpdate.push({
        id: existing.id,
        row: { name: row.name, sku: row.sku, upc: row.upc, gtin: row.gtin, color: row.color, size: row.size, attributes: row.attributes },
      });
    } else {
      variantCounts.unchanged += 1;
    }
  }
  printSummary("Variants", variantCounts);
  if (apply) {
    for (const batch of chunk(variantToInsert, INSERT_BATCH_SIZE)) {
      if (!batch.length) continue;
      const { data, error } = await supabase.from("catalog_product_variants").insert(batch.map((b) => b.row)).select("id");
      if (error) throw new Error(`Insert into catalog_product_variants failed: ${error.message}`);
      (data ?? []).forEach((row, i) => variantIdByKey.set(batch[i].key, row.id));
    }
    await updateOneByOne(supabase, "catalog_product_variants", variantToUpdate);
  }

  // Aliases: never reassign an alias already claimed by a DIFFERENT entity.
  const aliasCounts = { insert: 0, unchanged: 0, conflict: 0 };
  const aliasToInsert = [];
  function resolveAliasEntityId(entityType, key) {
    if (!apply) return null;
    switch (entityType) {
      case "brand":
        return brandIdBySlug.get(key) ?? null;
      case "family":
        return familyIdByKey.get(key) ?? null;
      case "product":
        return productIdBySlug.get(key) ?? null;
      case "variant":
        return variantIdByKey.get(key) ?? null;
      default:
        return null;
    }
  }
  for (const desired of desiredAliases) {
    const existing = existingAliasByKey.get(desired.key);
    const resolvedEntityId = resolveAliasEntityId(desired.entityType, desired.resolveEntityKey);
    if (!existing) {
      aliasCounts.insert += 1;
      aliasToInsert.push({
        row: {
          entity_type: desired.entityType,
          entity_id: resolvedEntityId,
          alias: desired.alias,
          normalized_alias: desired.normalized,
        },
        label: desired.label,
      });
      continue;
    }
    if (apply && existing.entity_id !== resolvedEntityId) {
      aliasCounts.conflict += 1;
      console.warn(`  [conflict] ${desired.label} normalizes to "${desired.normalized}", already claimed by a different ${desired.entityType}`);
      continue;
    }
    if (!apply) {
      // Existing row's parent entity is, by construction, already-existing
      // (see header comment) — so any pre-existing alias key is only ever
      // "unchanged" or a genuine conflict, never confusable with a new insert.
      aliasCounts.unchanged += 1;
      continue;
    }
    aliasCounts.unchanged += 1;
  }
  printSummary("Aliases", aliasCounts);
  if (apply) {
    for (const batch of chunk(aliasToInsert, INSERT_BATCH_SIZE)) {
      if (!batch.length) continue;
      const rows = batch.map((b) => b.row);
      if (rows.some((r) => !r.entity_id)) {
        throw new Error("Internal error: alias insert attempted with unresolved entity_id — aborting to avoid a bad row.");
      }
      const { error } = await supabase.from("catalog_aliases").insert(rows);
      if (error) throw new Error(`Insert into catalog_aliases failed: ${error.message}`);
    }
  }

  const newProductCount = productCounts.insert;
  console.log(`\nCatalog import complete.\n\nNew canonical products: ${newProductCount}`);
  if (dryRun) {
    console.log("\nThis was a DRY RUN — no rows were written. Re-run with --apply to write these changes.");
  } else if (newProductCount > 0) {
    console.log("\nRecommended next step (does not run automatically):\n\n  npm run catalog:backfill -- --dry-run\n");
  }
}

main().catch((error) => {
  console.error("Catalog import failed:", error);
  process.exit(1);
});
