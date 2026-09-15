# Catalog Data: Format, Validation, and Import

This document describes PENCHANT's data-driven canonical catalog expansion
system: `catalog-data/*.json` + `scripts/validate-catalog-data.js` +
`scripts/import-catalog-data.js`.

Goal: let contributors add real-world brands/products/variants (JBL Boombox
3, DeWalt 20V MAX DCD999, Rolex Submariner 126610LN, ...) to the canonical
catalog **without writing SQL or touching application code**.

## A. Catalog hierarchy

The canonical catalog is 7 Postgres tables (see
[supabase/migrations/20260913_add_canonical_product_catalog.sql](../supabase/migrations/20260913_add_canonical_product_catalog.sql)):

```
catalog_categories
  → catalog_subcategories (self-referencing tree, e.g. Audio → Portable Speakers)
    → catalog_brands            (NOT nested under category — a brand is global)
      → catalog_product_families (brand_id + optional subcategory_id)
        → catalog_products        (canonical model, e.g. "Boombox 3")
          → catalog_product_variants (e.g. "Black", "Squad")
              (+ catalog_aliases attach to brand/family/product/variant/subcategory)
```

A brand is not owned by one category — e.g. Apple sells phones (Electronics)
and watches (Watches). Each `catalog-data` **file** picks one category and
declares the brand/families/products that belong to it; the same brand slug
can appear in more than one file (see [C](#c-how-to-add-a-new-brand)).

## B. catalog-data file format

Two JSON "kinds" live under `catalog-data/`, discovered recursively — nest
files however you like (`catalog-data/electronics/audio/jbl.json` etc.), the
importer doesn't care about directory structure, only file content.

### `kind: "taxonomy"` — `catalog-data/taxonomy.json`

Defines `catalog_categories` and their nested `catalog_subcategories`. There
is normally exactly one taxonomy file for the whole repo.

```jsonc
{
  "kind": "taxonomy",
  "version": 1,
  "categories": [
    {
      "slug": "electronics",
      "name": "Electronics",
      "description": "Audio, phones, computers, cameras and gaming.",
      "sortOrder": 10,
      "subcategories": [
        {
          "slug": "audio",
          "name": "Audio",
          "sortOrder": 10,
          "subcategories": [
            { "slug": "portable-speakers", "name": "Portable Speakers", "sortOrder": 11 }
          ]
        }
      ]
    }
  ]
}
```

### `kind: "catalog"` — e.g. `catalog-data/electronics/jbl.json`

Defines one brand, plus that brand's product families/products/variants
scoped to one category.

```jsonc
{
  "kind": "catalog",
  "version": 1,
  "category": "electronics",
  "brand": {
    "slug": "jbl",
    "name": "JBL",
    "websiteUrl": "https://www.jbl.com",
    "logoUrl": null,
    "description": null,
    "aliases": ["J.B.L."]
  },
  "families": [
    {
      "slug": "boombox",
      "name": "Boombox",
      "subcategoryPath": ["audio", "portable-speakers"],
      "description": null,
      "aliases": []
    }
  ],
  "products": [
    {
      "slug": "jbl-boombox-3",
      "name": "Boombox 3",
      "family": "boombox",
      "subcategoryPath": ["audio", "portable-speakers"],
      "modelNumber": "Boombox 3",
      "releaseYear": 2022,
      "status": "active",
      "description": null,
      "upc": null,
      "gtin": null,
      "mpn": null,
      "aliases": ["Boom Box 3", "Boombox III", "JBL BoomBox3"],
      "source": {
        "type": "manufacturer",
        "url": "https://www.jbl.com/speakers/BOOMBOX+3.html",
        "lastVerifiedAt": "2026-09-15"
      },
      "variants": [
        { "slug": "black", "name": "Black", "color": "Black", "aliases": ["Boombox 3 Black"] },
        { "slug": "squad", "name": "Squad", "color": "Squad" }
      ]
    }
  ]
}
```

Field notes:

- `slug` fields must be lowercase kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`) and
  are the **stable natural key** the importer uses instead of hardcoded
  UUIDs — never rename an existing slug, add a new alias instead.
- `subcategoryPath` is an array of subcategory slugs from the category's
  root down to the leaf (e.g. `["audio", "portable-speakers"]`), and must
  resolve against `taxonomy.json`.
- `family` on a product is optional and references a `families[].slug` in
  the *same brand* (declared in any file for that brand).
- `source` is optional per-product provenance (`type`/`url`/`lastVerifiedAt`
  or similar keys) — stored in `catalog_products.attributes.source` (no
  migration needed; `attributes` is already a free-form `jsonb` column). Omit
  it when you don't have a source to cite; it is never required.
- Do not invent `modelNumber`, `upc`, `gtin`, `mpn`, or variant details you
  aren't sure about — omit the field (`null`) instead.

## C. How to add a new brand

1. Pick (or create) a file under `catalog-data/<category>/<brand-slug>.json`.
2. Add a `"kind": "catalog"` file with `category` + a `brand` object (see
   format above).
3. If the same brand also sells products in a *different* category (e.g.
   Apple: Electronics + Watches), add a **second** file in that category's
   directory with the identical `brand` object (same `slug`/`name`/
   `websiteUrl`/`logoUrl`/`description` — the validator errors if two
   declarations of the same brand slug disagree on those fields). Each file's
   `families`/`products` only need to be declared once, in whichever file
   makes sense.

## D. How to add a new product

Add an entry to `products[]` in the brand's file. Required: `slug`, `name`.
Everything else (see field notes above) is optional — set what you actually
know and leave the rest `null`/omitted.

## E. How to add variants

Add entries to a product's `variants[]` array. Required: `slug`, `name`.
`sku`/`upc`/`gtin`/`color`/`size` are optional identification fields.

## F. How to add aliases

Any of `brand`, `family`, `product`, or `variant` accepts an `aliases: []`
array of alternate spellings/names real listings might use (e.g. "Boom Box
3", "JBL BB3"). Aliases feed the exact same matcher used at upload time and
in the backfill script (`lib/catalogMatching.ts`) — every alias must be
globally unique after normalization (case/punctuation/whitespace collapsed);
the validator will catch collisions.

## G. Validation

```
npm run catalog:validate
```

Fully offline — reads `catalog-data/*.json`, no network/Supabase access.
Checks (non-exhaustive): malformed JSON, missing required fields, duplicate
slugs, duplicate normalized aliases (across the whole catalog, any entity
type), aliases/families/products referencing entities that don't exist,
invalid subcategory paths, duplicate canonical products (same brand +
normalized name), invalid `status` values. Errors print as:

```
catalog-data/electronics/jbl.json
Product: JBL Boombox 3
ERROR: duplicate normalized alias "jbl boombox3"
```

Exits non-zero if anything is invalid. `import-catalog-data.js` always runs
this same validation first and refuses to import invalid data.

## H. Dry-run import

```
npm run catalog:import
npm run catalog:import -- --dry-run
```

**Default and explicit `--dry-run` are identical** — no flag ever means "no
writes". Prints an Insert/Update/Unchanged/Conflict summary per entity type
without touching Supabase. Safe to run anytime, including against the real
project database (it only performs `select`s).

## I. Apply import

```
npm run catalog:import -- --apply
```

Requires `SUPABASE_SERVICE_ROLE_KEY` in a local, gitignored `.env.local`
(same requirement as `catalog:backfill` — never commit this key or expose it
to Expo/client code). Writes proceed in FK dependency order: categories →
subcategories → brands → families → products → variants → aliases, matching
every row against the database by its natural key (slug or composite of
slugs), so re-running `--apply` on unchanged data is a no-op (idempotent).
Inserts are batched (500 rows/request) to stay reasonable at large catalog
sizes; per-row updates are expected to be rare (metadata corrections only).

After a successful apply that added new canonical products, the importer
prints a suggestion to run the backfill — it never runs `--apply` for you:

```
Recommended next step (does not run automatically):

  npm run catalog:backfill -- --dry-run
```

## J. Backfill

Unchanged by this PR. `npm run catalog:backfill -- --dry-run` /
`-- --apply` still finds pre-existing `products` rows with
`catalog_product_id IS NULL` and links them to canonical catalog entries at
≥0.90 confidence, using the same `lib/catalogMatching.ts` scorer.

## K. Safety rules

- Catalog import **never** touches `public.products` (user listings),
  moderation state, likes/saves/follows, or user accounts.
- Nothing is ever deleted. Matching, non-conflicting rows are left alone;
  only real field differences produce an `UPDATE`.
- An alias whose normalized form already belongs to a *different* existing
  entity is reported as a `CONFLICT` and skipped — never silently
  reassigned.
- Two products are only ever treated as "the same" if they share the exact
  same `slug`. Similar names never get auto-merged.
- Only `--apply` writes anything; every other invocation (no flag,
  `--dry-run`) is read-only.

## L. How catalog IDs connect to `public.products`

`public.products.catalog_product_id` / `catalog_variant_id` (added in PR
#16) are nullable foreign keys set either at upload time
(`lib/catalog.ts#findCatalogMatch`, ≥0.90 confidence auto-assigns, 0.70–0.89
prompts the seller) or later by `scripts/backfill-catalog-matches.js` for
pre-existing listings. Catalog import only ever writes to the seven
`catalog_*` tables above — it never sets `catalog_product_id` on a listing
directly. A listing becomes "Verified" purely because its
`catalog_product_id` is non-null; that link is made exclusively by the
upload matcher or the backfill script, both of which reuse the exact same
`lib/catalogMatching.ts` scoring used here.
