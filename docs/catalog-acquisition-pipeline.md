# Catalog Acquisition & Staging Pipeline

## Overview

This pipeline intentionally separates three trust levels:

- RAW: the exact source payload as received from an adapter or import file.
- STAGED: normalized, validated and deduplicated candidate records that are still not trusted canonical catalog data.
- CANONICAL: explicitly approved records in the public catalog tables.

The system is designed to let future adapters ingest structured candidate records without silently turning them into canonical catalog rows.

## Source registry

`catalog_sources` stores metadata about where records came from:

- name
- type
- base_url
- trust_classification
- active
- notes

The table is intentionally not public-read; it stays in the admin layer and only supports service-role or trusted operations.

## Staging tables

The safe first staging schema is:

- `catalog_sources`
- `catalog_import_runs`
- `catalog_staged_products`
- `catalog_staged_aliases`

These tables are separate from the public canonical catalog tables and are not publicly readable. A raw payload is preserved in `raw_payload` for provenance and auditability.

## Adapter interface

The reusable adapter contract is conceptually:

```ts
export type CatalogCandidateInput = {
  sourceExternalId?: string | null;
  sourceId?: string | null;
  brand: string;
  productName: string;
  modelNumber?: string | null;
  family?: string | null;
  category?: string | null;
  subcategory?: string | null;
  aliases?: string[];
  sourceUrl?: string | null;
  sourceType?: string | null;
  raw: Record<string, unknown>;
};
```

Adapters should convert source-specific rows into this common schema and return candidate records for validation and staging.

## JSON and CSV adapters

### JSON adapter

The JSON adapter accepts either a JSON array or an object with `products`/`records` keys.

### CSV adapter

The CSV adapter reads a UTF-8 CSV with the headers `sourceExternalId,brand,productName,modelNumber,family,category,subcategory,aliases,sourceUrl` and normalizes the alias field from semicolon/comma-delimited values.

## Normalization

The acquisition layer reuses the same normalization principles as the canonical matcher:

- case-fold to lowercase
- punctuation collapsed to spaces
- whitespace normalized
- hyphen/underscore separators treated as spaces
- model numbers remain distinguishable and are not aggressively collapsed

Examples such as WH-1000XM4 vs WH-1000XM5, 990v5 vs 990v6, and HERO12 vs HERO13 remain distinct for safety.

## Duplicate classification

Classification is intentionally conservative:

- `EXACT_EXISTING` for explicit canonical matches
- `LIKELY_EXISTING` for close brand + identity matches that still require review
- `POSSIBLE_EXISTING` for ambiguous but similar records
- `NEW` for unrecognized candidate records
- `CONFLICT` when the record conflicts with canonical identity rules
- `INVALID` when required inputs are missing or malformed

The pipeline avoids the unsafe move of auto-promoting possibly duplicated data.

## Dry-run and apply behavior

- `npm run catalog:acquire -- --adapter json --source path/to/file.json --dry-run`
- `npm run catalog:acquire -- --adapter json --source path/to/file.json --apply`

The default is dry-run; any write requires an explicit `--apply` flag.

Promotion is also dry-run by default:

- `npm run catalog:promote -- --dry-run`
- `npm run catalog:promote -- --apply`

## Review and approval

The staging status model is:

- `pending`
- `approved`
- `rejected`
- `needs_review`
- `duplicate`
- `invalid`
- `promoted`

Review decisions must be explicit; there is no bulk approval path in this PR.

## Promotion

Promotion remains a separate step from staging. All promotion runs are explicit and dry-run by default. Only approved candidates are eligible for canonical promotion.

## Idempotency and fingerprints

Each staged record keeps a stable fingerprint derived from source identity and product identity so reprocessing the same record does not create duplicate stage entries.

## Security and RLS

- No service-role credentials are exposed to Expo.
- New staging tables are not public and do not widen client read access.
- Canonical catalog public-read behavior remains unchanged.

## Future extension

This is a safe foundation for a future Catalog Admin UI and future structured source adapters: manufacturer API, licensed dataset, merchant feed, or manual import workflows.
