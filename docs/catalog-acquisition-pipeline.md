# Catalog Acquisition & Staging Pipeline

## Open Icecat external taxonomy

Open Icecat category provenance comes from the official authenticated reference export:

`https://data.icecat.biz/export/freexml/refs/CategoriesList.xml.gz`

The export is streamed through a gzip decoder and SAX parser. Only normalized English category identities (`ID`, `Name`, parent ID, and constructed authoritative path) are retained in the gitignored cache at `.catalog-staging/open-icecat-categories.en.json`; the raw export is never committed. Refreshing is explicit and never occurs from ordinary acquisition or report commands:

```bash
npm run catalog:taxonomy:external -- --source open-icecat --external-id 971 --refresh-cache
```

Subsequent inspector calls and acquisitions read the local cache without network access. The cache enriches `externalTaxonomy` provider provenance only. It does not create or verify a PENCHANT taxonomy mapping, alter canonical taxonomy, approve candidates, or promote products. Historical staged rows that contain only an external ID remain unnamed in deterministic gap reports.

The 100-product gate produced the following non-binding operator review. `A` means an existing canonical classification is clear, `B` means the provider category exposes a legitimate missing canonical branch, and `C` means placement remains ambiguous. These are evidence for review, not mappings.

| Icecat ID | Official category | Official parent | Review | Evidence |
| --- | --- | --- | --- | --- |
| 971 | Large Format Media | Printing Media | B | No printing-media branch exists in the canonical taxonomy. |
| 846 | Print Heads | Printing Supplies | B | No printer-supplies branch exists in the canonical taxonomy. |
| 847 | Photo Paper | Photographic Filmmaking Supplies | C | The official hierarchy is photographic supplies, while the current canonical camera branch contains camera types only. |
| 853 | Printing Films | Printing Media | B | No printing-media branch exists in the canonical taxonomy. |
| 377 | Ink Cartridges | Printing Supplies | B | No printer-supplies branch exists in the canonical taxonomy. |
| 151 | Laptops | Computers | A | `Electronics > Computers > Laptops` already exists exactly. |
| 714 | Printing Paper | Printing Media | B | No printing-media branch exists in the canonical taxonomy. |
| 845 | Printable Textiles | Printing Media | B | No printing-media branch exists in the canonical taxonomy. |
| 702 | Plotter Paper | Printing Media | B | No printing-media branch exists in the canonical taxonomy. |
| 905 | Printer Ribbons | Printing Supplies | B | No printer-supplies branch exists in the canonical taxonomy. |

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
pages containing records, errors, completion state, and an optional checkpoint.
For Open Icecat, `nextCursor` is null until that exact page is acknowledged;
only then does it contain a safe recovery continuation. The emitted-only
position is retained as `checkpoint.emittedCursor` for diagnostics and must not
be used for recovery. A future caller can process each page immediately through
`acquireFromRecords` and persist its acknowledged cursor, so a provider need not hold
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
usable, enriched record, so a limit smaller than the page size produces a
partial final page.

The verified index shape is `ICECAT-interface > files.index > file`. Each
`file` contributes Product_ID, Prod_ID, Model_Name, Supplier_id, Catid,
Updated, On_Market, path, HighPic, Date_Added, nested EAN_UPC values, country
markets, and alternate M_Prod_ID values to raw provenance. Supplier_id is not a
brand name, and nested M_Prod_ID Supplier_name values are alternate supplier
context rather than canonical brand identity. Discovery therefore performs a
bounded product-XML fetch using each candidate's path and accepts the record
only when that detail document supplies the brand/manufacturer required by the
acquisition model. Failed enrichments are reported and discovery continues up
to a conservative bounded attempt limit while seeking the requested number of
usable records.

Verified product sheets use Product ID, Prod_id, GeneratedIntTitle, Title,
IntName, and Name attributes. Product ID becomes the Icecat external identity;
Prod_id becomes the detail MPN/model identifier. Product naming uses the first
non-empty value in this order: GeneratedIntTitle, Title, IntName, Name. Empty
localized fields never override these values. Brand identity comes only from
explicit descendant Supplier Name attributes, never title text or numeric
Supplier IDs. Repeated identical supplier names are deduplicated; conflicting
distinct names reject the enrichment. BrandProductCode Identifier values and
the supplier ID/name remain raw provenance and never become aliases.

The detail Product ID must equal the index Product_ID, and a present detail
Prod_id must equal a present index Prod_ID. Conflicts produce non-retriable
structured provider errors rather than silently replacing index identity.

Category, country market, on-market, and Updated-since filters run against the
index before enrichment. Brand filtering runs after bounded detail enrichment;
it is not inferred from Supplier_id or M_Prod_ID Supplier_name.

Transport decoding follows the response bytes rather than provider-wide
assumptions. The `.gz` index remains a streaming resource and is passed through
streaming gunzip only when its first bytes contain the gzip signature. Bounded
individual product paths normally return plain `application/xml`; those bytes
are decoded directly. A bounded response is gunzipped only when its payload
actually starts with gzip magic bytes, preventing double decompression when a
fetch implementation has already decoded an HTTP gzip response but retains its
Content-Encoding header.

Bulk discovery uses separate streaming timeout semantics: a 30-second request
timeout covers only establishment through response headers, then is cleared.
A 120-second inactivity timeout resets for every decompressed chunk and detects
a genuinely stalled body without imposing a wall-clock deadline on the full
index. Timeouts are reported as retriable provider request errors. Individual
product lookup retains its independent per-request timeout.

Discovery checkpoints use an opaque `ic2.` token containing a version, provider,
source URL, mode, ETag or Last-Modified snapshot evidence, optional content
length corroboration, a hash of
the relevant filters, parser version, and explicit parsed/scheduled/completed/
emitted/acknowledged positions. The position is the encounter number in the
source snapshot plus an identity check (`Product_ID`, Updated, and product URL);
product IDs are never used as ordering keys. Resume is a **STREAMING RE-SCAN
FROM BEGINNING**, not random-access seeking: records are consumed until the
exact acknowledged encounter position is found. Missing positions, legacy v1
tokens, changed snapshots, or changed filters fail with an explicit restart
requirement.

Provider pages expose an explicit `acknowledge()` hook. Each page captures its
own immutable frontier; acknowledgment is ordered and cannot advance beyond
an earlier unacknowledged page. Pages containing provider errors, and pages
following an error-only page, remain replayable rather than silently skipping
failed source positions. Acquisition calls acknowledgment only after
downstream page processing succeeds, and returns the last acknowledged
continuation metadata for reporting and tests. Emission alone does not advance
the recovery frontier. The in-memory dry-run boundary is not a durable
crash-recovery guarantee.

Discovery detail enrichment accepts `--concurrency`, bounded to 1 through 5;
the default is 2 and concurrency 1 is the deterministic serial reference.
Runtime diagnostics report active-request and admission/reorder high-water marks
plus bounded latency totals. Discovery CLI resumes with `--cursor <ic2-token>` and reports the termination
reason and whether an acknowledged continuation was produced. Concurrency is
bounded: the provider admits at most the configured worker count and a small
reorder window, while committing outcomes in encounter order.

The synthetic streaming tests verify bounded read-ahead, early cancellation,
first-page delivery before source completion, malformed-record reporting, and
truncated-XML failure. The Open Icecat full index endpoint has been verified to
accept `Api-Token` authentication, return gzip content with ETag and
Last-Modified headers, and use the files.index/file XML shape described above.
Its full-run ordering, sustained streaming behavior, and server-side
cancellation remain live-unverified pending a bounded authenticated dry run.

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

### Staging batch review commands

Staging detail output is redacted by default; raw provider payloads require an
explicit `--raw` flag.

```sh
npm run catalog:staging:list -- --limit 25
npm run catalog:staging:list -- --status needs_review --run-id RUN_ID --limit 10
npm run catalog:staging:list -- --classification NEW --limit 10
npm run catalog:staging:status -- --run-id RUN_ID
npm run catalog:staging:show -- --id CANDIDATE_ID
npm run catalog:staging:show -- --id CANDIDATE_ID --raw
npm run catalog:staging:approve -- --id CANDIDATE_ID
npm run catalog:staging:approve -- --id CANDIDATE_ID --raw
npm run catalog:staging:reject -- --id CANDIDATE_ID
npm run catalog:staging:reject -- --id CANDIDATE_ID --raw
```

The sequential review command presents identity, identifiers, taxonomy, image,
confidence, classification, provenance, run ID, and timestamps. `a` approves,
`r` rejects, and `s` leaves the candidate pending. It is dry-run unless
`--apply` is explicit:

```sh
npm run catalog:staging:review -- --run-id RUN_ID --limit 10
npm run catalog:staging:review -- --run-id RUN_ID --limit 10 --apply
```

Approval never promotes a product. Promotion remains separate. Approval is the
human-review decision: an externally valid candidate may be approved even when
canonical hierarchy is unresolved, so the review decision and promotion
preparation remain separate. The approval preview labels `Human reviewed`,
`Canonical hierarchy`, and `Promotion ready` independently. Promotion still
requires resolved canonical hierarchy and remains blocked with
`HIERARCHY UNRESOLVED / MANUAL REVIEW REQUIRED` until that issue is resolved.

All five operator-facing commands are concise and redacted by default:
`show`, `review`, `approve`, and `reject` never print `rawPayload` unless
`--raw` is explicitly supplied. Approval dry-runs also print
`DRY RUN -- ZERO WRITES` and do not change the candidate status.

## Promotion

Promotion remains a separate step from staging. All promotion runs are explicit and dry-run by default. Only approved candidates are eligible for canonical promotion.

The promotion dry-run performs the approved-only eligibility and duplicate
checks, then previews brand, canonical name, model, slug, aliases, subcategory,
family, and source provenance. Missing canonical brand, subcategory, or family
identity is reported as a human-review failure; taxonomy rows are never
fabricated. Apply uses the existing atomic Postgres RPC, including its final
duplicate and alias-conflict rechecks.

## Import-run summary and quality metrics

An apply acquisition prints the source, run ID, elapsed time, discovered and
enriched counts, valid/invalid and classification counts, staged count,
provider errors, and lightweight rates for enrichment success, valid records,
existing/duplicate records, NEW records, GTIN, image, model/MPN, trustworthy
brand, provider errors, and manual-review share. Raw payloads remain available
for audit but are not shown by default.

The quality model distinguishes four states: externally valid means required
source identity and payload fields are present; duplicate-safe means the
candidate classified as `NEW` under the existing matcher protections; review
required includes duplicate ambiguity and any unmapped external Icecat
hierarchy; promotion-ready requires external validity, duplicate safety, and a
resolved canonical hierarchy. A valid external record is not automatically
promotion-ready.

Icecat `Catid` and detail category name/path remain external provenance. Numeric
Catid values are never treated as PENCHANT taxonomy IDs. Configured unambiguous
name mappings may populate canonical category/subcategory fields; otherwise
the candidate is marked `HIERARCHY UNRESOLVED / MANUAL REVIEW REQUIRED` and
promotion is blocked without creating taxonomy rows.

## First production batch

The first bounded Open Icecat production batch is intentionally staging-only:

```sh
npm run catalog:acquire:icecat -- --discover --mode initial --limit 10 --page-size 10 --apply
```

This authenticates the provider, loads the canonical catalog only for
classification, and resolves the staging backend only because `--apply` is
present. It calls `acquireFromRecords`, which writes only
`catalog_sources`, `catalog_import_runs`, `catalog_staged_products`, and
`catalog_staged_aliases`. The Icecat CLI does not import approval, rejection,
or promotion functions and never calls the canonical promotion store. It does
not approve candidates, promote products, write canonical products or aliases,
or weaken duplicate checks. Approval and promotion must be separate explicit
commands.

Before running it, confirm Icecat and Supabase service-role credentials exist
only in the local gitignored `.env.local`. Record the printed run ID and inspect
it with `catalog:staging:status` and `catalog:staging:list` before reviewing.

## Schema extension

The deployed PR #21 migration is unchanged. The deployed
`20260916_extend_catalog_staging_observability.sql` migration adds the
import-run link, image URL, UPC, GTIN, and MPN fields, plus an import-run index.
It reuses the existing four staging tables and creates no redundant tables.

## External taxonomy mappings

Provider adapters emit a generic external taxonomy identity containing provider,
external ID, name, path, and optional parent identity. Open Icecat keeps
`Catid` as the external ID; it is never treated as a PENCHANT UUID or taxonomy
ID. Detail category names and paths are retained only when the provider actually
supplies them.

The new additive migration
`20260917_add_catalog_taxonomy_mappings.sql` creates the operator-only
`catalog_taxonomy_mappings` registry. It supports `unmapped`,
`suggested`, `verified`, and `rejected` states. Only `verified` mappings with
an existing canonical category/subcategory are trusted for automatic reuse.
Mapping method and evidence are retained. Suggested or rejected mappings never
resolve a candidate's canonical hierarchy.

```sh
npm run catalog:taxonomy:list -- --source open-icecat --status verified
npm run catalog:taxonomy:list -- --unmapped --limit 25
npm run catalog:taxonomy:show -- --source open-icecat --external-id 846
npm run catalog:taxonomy:map -- --source open-icecat --external-id 846 \
  --subcategory-id CANONICAL_SUBCATEGORY_ID --status verified
npm run catalog:taxonomy:map -- --source open-icecat --external-id 846 \
  --subcategory-id CANONICAL_SUBCATEGORY_ID --status verified --apply
```

Mapping commands are dry-run by default, validate the existing canonical
subcategory/category relationship, and never create taxonomy rows. A verified
mapping is reused dynamically during future acquisition and resolves staged
category/subcategory fields without approving or promoting candidates. Existing
staged rows are not backfilled or mutated by mapping creation; they are handled
by a later acquisition or explicit operator workflow.

Canonical classification is separate from discovery/navigation. The existing
`catalog_subcategories.parent_subcategory_id` tree and reviewed
`catalog-data/taxonomy.json` importer support deeper internal classes without
changing the app's ten curated Categories tiles. Inspect the canonical tree
with `catalog:taxonomy:canonical`; it labels top-level allowlisted departments
as `discovery-visible` and deeper/internal nodes as `internal-only`.

Open Icecat category `846` is intentionally unresolved in this repository. The
available fixtures preserve external IDs and some category names, but do not
provide trustworthy evidence identifying real production `846`; no mapping or
canonical printer classification is fabricated.

## Idempotency and fingerprints

Each staged record keeps a stable fingerprint derived from source identity and product identity so reprocessing the same record does not create duplicate stage entries.

## Security and RLS

- No service-role credentials are exposed to Expo.
- New staging tables are not public and do not widen client read access.
- Canonical catalog public-read behavior remains unchanged.

## Future extension

This is a safe foundation for a future Catalog Admin UI and future structured source adapters: manufacturer API, licensed dataset, merchant feed, or manual import workflows.
