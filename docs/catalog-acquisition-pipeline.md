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

The provider boundary lives in `lib/catalogProviders.ts`. A provider owns only
source access and mapping; it must return `CatalogCandidateInput` records and
must never write canonical tables. `OpenIcecatProvider` is the first adapter.
This keeps future GS1, manufacturer, retailer, or supplier adapters independent
of classification and staging.

Providers advertise capabilities explicitly:

- **Lookup/enrichment:** known GTIN, EAN, UPC, MPN, or product code -> provider
  lookup -> normalization -> the existing PENCHANT acquisition pipeline.
- **Discovery/enumeration:** external catalog, feed, or API -> bounded pages or
  cursors -> normalization -> the same acquisition pipeline.

Discovery is optional. Its generic contract is an async iterable of bounded
pages containing records, errors, `nextCursor`, completion state, and an
optional checkpoint. A future caller can process each page immediately through
`acquireFromRecords` and persist its cursor, so a provider need not hold
100,000-plus records in memory. Providers supporting both operations advertise
both capabilities.

### Open Icecat

Open Icecat uses the documented product lookup API at
`https://live.icecat.biz/api` with `shopname`, `lang`, and `productcode` query
parameters. Set `ICECAT_API_TOKEN` in `.env.local` to authenticate with the
`Api-Token` request header. API-token authentication takes precedence when both
token and Basic credentials are configured. `ICECAT_USERNAME` and
`ICECAT_PASSWORD` remain supported as a Basic-auth fallback. Optional settings
include `ICECAT_SHOPNAME`, `ICECAT_API_URL`, and `ICECAT_PRODUCT_CODES`. Product
codes or GTINs must be supplied explicitly; the adapter refuses an unbounded
crawl. `--limit` is capped at 100 and `--pages` bounds the requested code
batches. Requests have a timeout and individual failures are reported without
discarding successful records. Credentials are never included in source
metadata, checkpoints, or CLI output.

Open Icecat advertises `lookup: true, discovery: true`. Discovery reads the
documented `files.index.xml.gz` or `daily.index.xml.gz` index through a
backpressure-aware HTTP/gzip stream and a SAX parser. Each bounded page enters
the existing acquisition pipeline before the next page is requested; the CLI
does not retain the complete discovery result. `--limit` is enforced per
qualifying record, so a limit smaller than the page size produces a partial
final page.

Discovery checkpoints retain the source URL, mode, ETag, Last-Modified value,
content metadata, last source identity and Updated value, processed count, and
checkpoint version. Resume is a **STREAMING RE-SCAN FROM BEGINNING**, not
random-access seeking: records are streamed again and skipped until they sort
after the saved cursor. A changed ETag or Last-Modified value fails the run
rather than silently continuing against a different snapshot.

The synthetic streaming tests verify bounded read-ahead, early cancellation,
first-page delivery before source completion, malformed-record reporting, and
truncated-XML failure. The Open Icecat full index endpoint has been verified to
accept `Api-Token` authentication and return gzip content with ETag and
Last-Modified headers. Its complete XML shape, ordering, sustained streaming
behavior, and server-side cancellation remain live-unverified pending a bounded
authenticated dry run.

Run a fixture-only dry run with an intentionally empty local canonical catalog:

```sh
npm run catalog:acquire:icecat -- --source scripts/__fixtures__/catalog-acquisition/open-icecat-products.xml --backend=local --limit 10
```

For a live, read-only run against the real canonical catalog:

```sh
npm run catalog:acquire:icecat -- --product-code YOUR-MPN --limit 10
```

`--apply` is required to write only staged rows. Approval and promotion remain
separate existing commands. Icecat identifiers are retained as provenance and
mapped to `gtin`/`mpn` when explicitly present; Icecat's internal product ID is
never treated as a universal identifier. Category mapping is explicit and
conservative. Unmapped Icecat categories remain in `raw_payload` for review,
without creating canonical taxonomy rows. Marketing text is not converted into
aliases, and the existing bare-brand alias protection remains in force.

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
