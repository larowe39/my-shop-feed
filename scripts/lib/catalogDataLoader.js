// scripts/lib/catalogDataLoader.js
//
// Shared, dependency-free (besides Node's `fs`) loader/validator for the
// data-driven catalog expansion format under catalog-data/. Used by BOTH
// scripts/validate-catalog-data.js and scripts/import-catalog-data.js so the
// two can never drift out of sync on what "valid" means.
//
// File "kind"s:
//   - "taxonomy": defines public.catalog_categories + nested
//     public.catalog_subcategories. There should normally be exactly one of
//     these (catalog-data/taxonomy.json), but the loader does not hard-code
//     that — it merges every taxonomy file it finds.
//   - "catalog": defines exactly one brand plus its product families,
//     canonical products and variants, all scoped to a single top-level
//     category. This is the file type you add when onboarding a new brand.
//
// This module never touches Supabase or the network — it only reads JSON
// off disk. That's what lets `catalog:validate` run in CI/offline.

const fs = require("fs");
const path = require("path");

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function findJsonFiles(rootDir) {
  const results = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        results.push(full);
      }
    }
  }
  if (fs.existsSync(rootDir)) walk(rootDir);
  return results.sort();
}

// Loads and JSON.parses every catalog-data file. Parse errors are returned
// as entries with `parseError` set instead of throwing, so the caller can
// report ALL malformed files in one pass rather than stopping at the first.
function loadCatalogDataFiles(rootDir) {
  return findJsonFiles(rootDir).map((filePath) => {
    const relativePath = path.relative(process.cwd(), filePath);
    const raw = fs.readFileSync(filePath, "utf8");
    try {
      return { filePath, relativePath, data: JSON.parse(raw), parseError: null };
    } catch (error) {
      return { filePath, relativePath, data: null, parseError: error.message };
    }
  });
}

function err(errors, file, entity, problem) {
  errors.push({ file, entity, problem });
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Walks a taxonomy category's nested subcategories, registering every node
// so catalog files can validate `subcategoryPath` against a flat lookup of
// `${categorySlug}::${slugPath.join("/")}`.
function walkSubcategories(file, categorySlug, subcategories, parentPath, seen, errors) {
  if (!Array.isArray(subcategories)) return;
  const siblingSlugs = new Set();
  for (const sub of subcategories) {
    const entityLabel = `Subcategory: ${categorySlug}/${[...parentPath, sub && sub.slug].filter(Boolean).join("/")}`;
    if (!sub || typeof sub !== "object") {
      err(errors, file, "Subcategory", "malformed subcategory entry");
      continue;
    }
    if (!isNonEmptyString(sub.slug) || !SLUG_RE.test(sub.slug)) {
      err(errors, file, entityLabel, `invalid or missing slug "${sub.slug}"`);
      continue;
    }
    if (!isNonEmptyString(sub.name)) {
      err(errors, file, entityLabel, "missing required field: name");
    }
    if (siblingSlugs.has(sub.slug)) {
      err(errors, file, entityLabel, `duplicate sibling subcategory slug "${sub.slug}"`);
    }
    siblingSlugs.add(sub.slug);

    const fullPath = [...parentPath, sub.slug];
    const key = `${categorySlug}::${fullPath.join("/")}`;
    if (seen.has(key)) {
      err(errors, file, entityLabel, `duplicate subcategory path "${fullPath.join(" > ")}"`);
    }
    seen.set(key, {
      categorySlug,
      path: fullPath,
      name: sub.name,
      description: sub.description ?? null,
      sortOrder: sub.sortOrder ?? 0,
    });

    if (sub.subcategories) walkSubcategories(file, categorySlug, sub.subcategories, fullPath, seen, errors);
  }
}

// Merges every taxonomy file into one lookup structure:
//   categories: Map<slug, {slug, name, ...}>
//   subcategoryByPath: Map<"categorySlug::a/b/c", {categorySlug, path, name}>
function buildTaxonomy(taxonomyFiles, errors) {
  const categories = new Map();
  const subcategoryByPath = new Map();

  for (const { file, data } of taxonomyFiles) {
    if (!Array.isArray(data.categories)) {
      err(errors, file, "Taxonomy", "missing required field: categories (array)");
      continue;
    }
    for (const category of data.categories) {
      const entityLabel = `Category: ${category && category.slug}`;
      if (!category || typeof category !== "object") {
        err(errors, file, "Category", "malformed category entry");
        continue;
      }
      if (!isNonEmptyString(category.slug) || !SLUG_RE.test(category.slug)) {
        err(errors, file, entityLabel, `invalid or missing slug "${category.slug}"`);
        continue;
      }
      if (!isNonEmptyString(category.name)) {
        err(errors, file, entityLabel, "missing required field: name");
      }
      if (categories.has(category.slug)) {
        err(errors, file, entityLabel, `duplicate category slug "${category.slug}" (already defined in ${categories.get(category.slug).file})`);
      } else {
        categories.set(category.slug, { ...category, file });
      }
      if (category.subcategories) {
        walkSubcategories(file, category.slug, category.subcategories, [], subcategoryByPath, errors);
      }
    }
  }

  return { categories, subcategoryByPath };
}

function normalizedAliasKey(alias, normalizeFn) {
  return normalizeFn(alias);
}

// Registers an alias in the global dedupe map, reporting a validation error
// (not a silent skip) if the SAME normalized alias is claimed by two
// different entities across the whole catalog-data tree.
function registerAlias(errors, file, entityLabel, entityKey, alias, normalizeFn, aliasRegistry) {
  const normalized = normalizedAliasKey(alias, normalizeFn);
  if (!normalized) {
    err(errors, file, entityLabel, `alias "${alias}" normalizes to an empty string`);
    return;
  }
  const existing = aliasRegistry.get(normalized);
  if (existing) {
    err(
      errors,
      file,
      entityLabel,
      `duplicate normalized alias "${normalized}" (also claimed by ${existing.entityLabel} in ${existing.file})`
    );
    return;
  }
  aliasRegistry.set(normalized, { entityKey, entityLabel, file });
}

// Validates every "catalog" (brand) file and returns a flat, importer-ready
// view of families/products/variants/aliases plus any validation errors.
function buildCatalogEntities(catalogFiles, taxonomy, normalizeFn, errors) {
  const brandDefinitions = new Map(); // slug -> {file, name, ...}
  const familySlugsByBrand = new Map(); // brandSlug -> Set<familySlug> (global across files)
  const productSlugs = new Map(); // slug -> file
  const productByNormalizedIdentity = new Map(); // "brand::normalizedName" -> slug (dup-product detection)
  const aliasRegistry = new Map();

  const brands = [];
  const families = [];
  const products = [];

  for (const { file, data } of catalogFiles) {
    if (!isNonEmptyString(data.category)) {
      err(errors, file, "Catalog file", "missing required field: category");
      continue;
    }
    if (!taxonomy.categories.has(data.category)) {
      err(errors, file, "Catalog file", `references nonexistent category "${data.category}"`);
    }

    const brand = data.brand;
    if (!brand || typeof brand !== "object") {
      err(errors, file, "Brand", "missing required field: brand");
      continue;
    }
    const brandLabel = `Brand: ${brand.name || brand.slug}`;
    if (!isNonEmptyString(brand.slug) || !SLUG_RE.test(brand.slug)) {
      err(errors, file, brandLabel, `invalid or missing brand slug "${brand.slug}"`);
      continue;
    }
    if (!isNonEmptyString(brand.name)) {
      err(errors, file, brandLabel, "missing required field: name");
    }
    // A brand (e.g. Apple) can legitimately span multiple top-level
    // categories (electronics + watches), so the SAME brand slug may appear
    // in more than one catalog file. That's fine as long as every
    // declaration agrees on the brand's own fields — only push it into the
    // import list once, from its first declaration.
    const previousBrand = brandDefinitions.get(brand.slug);
    if (previousBrand) {
      const conflictingField = ["name", "websiteUrl", "logoUrl", "description"].find(
        (field) => (previousBrand[field] ?? null) !== (brand[field] ?? null)
      );
      if (conflictingField) {
        err(
          errors,
          file,
          brandLabel,
          `brand "${brand.slug}" redeclared with a different "${conflictingField}" than in ${previousBrand.file} — brand fields must match everywhere the brand is used`
        );
      }
    } else {
      brandDefinitions.set(brand.slug, { file, ...brand });
      brands.push({ file, category: data.category, ...brand });
    }

    for (const alias of brand.aliases ?? []) {
      registerAlias(errors, file, brandLabel, `brand:${brand.slug}`, alias, normalizeFn, aliasRegistry);
    }

    if (!familySlugsByBrand.has(brand.slug)) familySlugsByBrand.set(brand.slug, new Set());
    const familySlugs = familySlugsByBrand.get(brand.slug);
    for (const family of data.families ?? []) {
      const familyLabel = `Family: ${brand.slug}/${family && family.slug}`;
      if (!family || typeof family !== "object") {
        err(errors, file, "Family", "malformed family entry");
        continue;
      }
      if (!isNonEmptyString(family.slug) || !SLUG_RE.test(family.slug)) {
        err(errors, file, familyLabel, `invalid or missing slug "${family.slug}"`);
        continue;
      }
      if (!isNonEmptyString(family.name)) {
        err(errors, file, familyLabel, "missing required field: name");
      }
      if (familySlugs.has(family.slug)) {
        err(errors, file, familyLabel, `duplicate family slug "${family.slug}" for brand "${brand.slug}"`);
      }
      familySlugs.add(family.slug);

      let subcategoryKey = null;
      if (family.subcategoryPath) {
        subcategoryKey = `${data.category}::${(family.subcategoryPath || []).join("/")}`;
        if (!taxonomy.subcategoryByPath.has(subcategoryKey)) {
          err(errors, file, familyLabel, `references nonexistent subcategory path "${family.subcategoryPath.join(" > ")}" in category "${data.category}"`);
          subcategoryKey = null;
        }
      }

      families.push({ file, brandSlug: brand.slug, category: data.category, subcategoryKey, ...family });
      for (const alias of family.aliases ?? []) {
        registerAlias(errors, file, familyLabel, `family:${brand.slug}/${family.slug}`, alias, normalizeFn, aliasRegistry);
      }
    }

    for (const product of data.products ?? []) {
      const productLabel = `Product: ${brand.name || brand.slug} ${product && product.name}`;
      if (!product || typeof product !== "object") {
        err(errors, file, "Product", "malformed product entry");
        continue;
      }
      if (!isNonEmptyString(product.slug) || !SLUG_RE.test(product.slug)) {
        err(errors, file, productLabel, `invalid or missing slug "${product.slug}"`);
        continue;
      }
      if (!isNonEmptyString(product.name)) {
        err(errors, file, productLabel, "missing required field: name");
      }
      if (productSlugs.has(product.slug)) {
        err(errors, file, productLabel, `duplicate product slug "${product.slug}" (already defined in ${productSlugs.get(product.slug)})`);
        continue;
      }
      productSlugs.set(product.slug, file);

      const normalizedIdentity = `${brand.slug}::${normalizeFn(product.name)}`;
      if (productByNormalizedIdentity.has(normalizedIdentity)) {
        err(
          errors,
          file,
          productLabel,
          `duplicate canonical product: brand "${brand.slug}" + normalized name "${normalizeFn(product.name)}" already used by slug "${productByNormalizedIdentity.get(normalizedIdentity)}"`
        );
      } else {
        productByNormalizedIdentity.set(normalizedIdentity, product.slug);
      }

      if (product.family && !familySlugs.has(product.family)) {
        err(errors, file, productLabel, `references nonexistent family "${product.family}" for brand "${brand.slug}"`);
      }

      let subcategoryKey = null;
      if (product.subcategoryPath) {
        subcategoryKey = `${data.category}::${(product.subcategoryPath || []).join("/")}`;
        if (!taxonomy.subcategoryByPath.has(subcategoryKey)) {
          err(errors, file, productLabel, `references nonexistent subcategory path "${product.subcategoryPath.join(" > ")}" in category "${data.category}"`);
          subcategoryKey = null;
        }
      }

      if (product.status && !["active", "discontinued", "upcoming", "unknown"].includes(product.status)) {
        err(errors, file, productLabel, `invalid status "${product.status}"`);
      }

      for (const alias of product.aliases ?? []) {
        registerAlias(errors, file, productLabel, `product:${product.slug}`, alias, normalizeFn, aliasRegistry);
      }

      const variantSlugs = new Set();
      const variants = [];
      for (const variant of product.variants ?? []) {
        const variantLabel = `Variant: ${product.name} / ${variant && variant.name}`;
        if (!variant || typeof variant !== "object") {
          err(errors, file, "Variant", "malformed variant entry");
          continue;
        }
        if (!isNonEmptyString(variant.slug) || !SLUG_RE.test(variant.slug)) {
          err(errors, file, variantLabel, `invalid or missing slug "${variant.slug}"`);
          continue;
        }
        if (!isNonEmptyString(variant.name)) {
          err(errors, file, variantLabel, "missing required field: name");
        }
        if (variantSlugs.has(variant.slug)) {
          err(errors, file, variantLabel, `duplicate variant slug "${variant.slug}" for product "${product.slug}"`);
        }
        variantSlugs.add(variant.slug);
        variants.push(variant);

        for (const alias of variant.aliases ?? []) {
          registerAlias(
            errors,
            file,
            variantLabel,
            `variant:${product.slug}/${variant.slug}`,
            alias,
            normalizeFn,
            aliasRegistry
          );
        }
      }

      products.push({
        file,
        brandSlug: brand.slug,
        category: data.category,
        subcategoryKey,
        variants,
        ...product,
      });
    }
  }

  return { brands, families, products };
}

// Full validation entry point. `normalizeFn` MUST be
// lib/catalogMatching.ts's normalizeCatalogText so alias dedupe uses the
// exact same normalization the runtime matcher relies on.
function loadAndValidateCatalogData(rootDir, normalizeFn) {
  const files = loadCatalogDataFiles(rootDir);
  const errors = [];

  for (const file of files) {
    if (file.parseError) {
      err(errors, file.relativePath, "File", `malformed JSON: ${file.parseError}`);
    } else if (!file.data || typeof file.data !== "object") {
      err(errors, file.relativePath, "File", "file does not contain a JSON object");
    } else if (!["taxonomy", "catalog"].includes(file.data.kind)) {
      err(errors, file.relativePath, "File", `missing or invalid "kind" (expected "taxonomy" or "catalog", got ${JSON.stringify(file.data.kind)})`);
    }
  }

  const validFiles = files.filter((f) => !f.parseError && f.data && typeof f.data === "object" && ["taxonomy", "catalog"].includes(f.data.kind));
  const taxonomyFiles = validFiles.filter((f) => f.data.kind === "taxonomy").map((f) => ({ file: f.relativePath, data: f.data }));
  const catalogFiles = validFiles.filter((f) => f.data.kind === "catalog").map((f) => ({ file: f.relativePath, data: f.data }));

  const taxonomy = buildTaxonomy(taxonomyFiles, errors);
  const entities = buildCatalogEntities(catalogFiles, taxonomy, normalizeFn, errors);

  return {
    errors,
    taxonomy,
    ...entities,
    fileCount: files.length,
  };
}

module.exports = {
  SLUG_RE,
  loadCatalogDataFiles,
  loadAndValidateCatalogData,
};
