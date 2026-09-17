# Catalog 1K Scale Readiness

## Scope

This PR repairs and measures the offline readiness path for one future human-controlled Open Icecat 1,000-product dry-run. It does not run live Icecat, does not write production data, and does not apply migrations.

Primary commands:

```sh
npm run catalog:provider-test
npm run catalog:scale-readiness
```

The scale harness uses fake provider/store adapters around the real `acquireDiscoveredProducts` -> `acquireFromRecords` pipeline. Provider boundedness is now covered separately by real `OpenIcecatProvider` offline SAX/streaming tests using dense `<file>` records.

Evidence labels:

- **MEASURED**: directly counted by the real pipeline/test subject.
- **MODELED**: counted by a fake/counting adapter or static batch contract.
- **NOT TESTED**: explicitly not exercised by this PR.

Wall-clock values are sample observations only and are not CI thresholds.

## Real Provider Queue Repair

Root cause: `OpenIcecatProvider.discoverProducts` bounded active detail requests and completed outcomes, but not parsed pending `candidateRecords`. Dense SAX input could append parsed candidates faster than `admitCandidates` drained them, and after the detail-attempt budget was exhausted the parser could continue appending records that would never be attempted. High-water telemetry was updated during admission, so it could under-report actual retained work.

Old bound model:

- active detail requests: bounded by concurrency;
- completed reorder outcomes: partially bounded by admission window;
- parsed candidate queue: not bounded;
- attempt budget exhaustion: could continue parsing source records;
- high-water telemetry: did not update on every queue mutation.

New bound model:

- retained work = parsed candidates + active detail requests + completed outcomes;
- retained work is bounded by `admissionWindow + parserPendingBound`;
- parsed candidate queue high-water is tracked on every queue mutation;
- attempt-budget exhaustion terminates discovery as `attempt-budget-exhausted`, drains/categorizes already-attempted work, clears unattempted parsed candidates, and closes the source promptly;
- final metrics are emitted after cleanup/settlement.

## Provider Outcome Categories

Detail attempts now reconcile into explicit categories:

- usable successful detail;
- failed detail request;
- filtered/nonusable successful detail;
- successful speculative completion beyond the usable frontier;
- cancelled detail request.

The sum of these categories is asserted to equal total enrichment attempts in real-provider offline tests.

## Real Provider Offline Test Evidence

Dense streaming tests use the actual `OpenIcecatProvider`, SAX parser, provider continuation/acknowledgment path, and offline `Response` fixtures.

Results:

| Scenario | Result | Evidence |
| --- | --- | --- |
| Dense one-chunk source with many short valid `<file>` records | PASS | Retained work high-water stays within documented bound. |
| Concurrency 1 / 2 / 3 / 5 | PASS | Active detail requests never exceed configured concurrency. |
| Parser feed 128 and 8192 | PASS | Parsed queue and retained-work high-water remain bounded. |
| Slow first detail completion | PASS | Queue backpressure holds while detail ordering waits. |
| All details succeed | PASS | Limit reached with reconciled usable/speculative/cancelled outcomes. |
| All detail requests fail | PASS | Attempt cap is not exceeded; termination is `attempt-budget-exhausted`. |
| Mixed/filtered outcomes | PASS | Filtered successful details are counted separately from failures. |
| Active cancellation | PASS | Active detail requests receive cancellation and settle. |
| Resume from acknowledged continuation | PASS | Existing v2 continuation contract remains deterministic. |
| Error-only page behavior | PASS | Pages with provider errors remain replayable and do not advance acknowledgment. |

The all-failure attempt-cap test uses `limit=10`, so the documented cap is `limit * 10 = 100`; it observes exactly 100 attempts, 100 failed detail requests, source cancellation, and `attempt-budget-exhausted`.

## Synthetic Scale Harness

The synthetic scale workload is accurately named **disjoint-brand full-scan workload**. It is not the overall worst case. It deliberately produces all-new incoming records whose brands do not match canonical brands, exposing the remaining canonical scan cost while legitimately producing zero scorer invocations through the conflicting-brand shortcut.

### Offline results against 1K canonical products

| Incoming products | Pages | Canonical entries examined | Specificity witnesses | Taxonomy misses/hits | Downstream runtime |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 4 | 300,000 | 200,000 | 10 / 90 | about 410 ms |
| 500 | 20 | 1,500,000 | 1,000,000 | 10 / 490 | about 1,598 ms |
| 1,000 | 40 | 3,000,000 | 2,000,000 | 10 / 990 | about 3,003 ms |

Evidence classification for this harness:

| Field | Classification |
| --- | --- |
| Synthetic provider high-water values | MODELED |
| Synthetic provider outcome counts | MODELED |
| Taxonomy cache reads | MEASURED by resolver calls |
| Canonical catalog reads | MODELED as table-family count |
| Staging write counts in apply simulation | MEASURED by counting store |
| Hidden per-product DB operations | MODELED by counting-store contract |
| Heap before/after | MEASURED retained-heap sample, not peak memory |
| Telemetry entry count | MODELED |

## Matcher Scale Evidence

Corrected complexity for disjoint-brand incoming records:

- exact identity scan: `N`;
- same-brand similarity scan: `N`;
- candidate construction/finalization path: `N`;
- specificity witness collection/finalization: `N`.

That yields approximately `3MN` canonical entries examined and `2MN` witness checks. Zero scorer invocations in this fixture is legitimate but is a fixture artifact.

Canonical-size comparison at 1,000 incoming products:

| Canonical products | Index build | Matcher execution | Downstream total | Entries examined |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | about 16 ms | about 3,083 ms | about 3,137 ms | 3,000,000 |
| 10,000 | about 115 ms | about 30,165 ms | about 30,297 ms | 30,000,000 |

Representative nonzero-scorer coverage was added for:

- half compatible brands;
- empty canonical brands with valid incoming brands;
- mixed brands plus alias-heavy records.

These are directional evidence only; variants are not represented by the acquisition `CanonicalCatalogEntry` shape and remain **NOT TESTED** in this PR's acquisition harness.

## Database Operation Model at 1K

The 1,000-product apply simulation uses 40 acquisition pages.

| Operation | Count | Evidence |
| --- | ---: | --- |
| Canonical catalog table-family reads | 5 | MODELED from canonical loader table families |
| Taxonomy mapping reads | 10 | MEASURED by unique resolver misses |
| Canonical taxonomy validation reads | 10 logical validations | MODELED in the fake taxonomy resolver |
| Source upserts | 1 | MEASURED by counting store |
| Import-run creates | 1 | MEASURED by counting store |
| Import-run updates | 1 | MEASURED by counting store |
| Staged-product write calls | 40 | MEASURED by counting store, one per page |
| Staged-product write batches | 40 | MEASURED by counting store with page size 25 |
| Staged-alias write batches | 40 | MEASURED by counting store |
| Staged-product count reads | 1 | MEASURED by counting store |
| Hidden per-product DB operations | 0 in the counting contract | MODELED |

No exercised acquisition/staging N+1 path remains for the future dry-run path. Apply-path caveats are deferred below.

## Taxonomy Request Model

For one cache miss:

- verified category + subcategory mapping: mapping lookup + category validation + subcategory validation = 3 sequential Supabase reads;
- category-only mapping: 2 reads;
- absent mapping: 1 read;
- subcategory-only mapping can require 3 reads if the parent category must be resolved.

At 1,000 products with 10 repeated taxonomy IDs, the run-scoped cache performs 1,000 logical resolver calls but only 10 misses. Reads scale with unique taxonomy IDs, not product count.

Future safe optimization strategy, not implemented here: paginate verified mappings for the selected provider, batch referenced canonical categories/subcategories/parents, validate relationships, build an immutable run-scoped lookup, and fail closed. Do not use an unpaginated `listMappings` preload.

## Taxonomy and Readiness Repairs

Repaired issues:

- discovery aggregate quality metrics now use post-resolution classified records instead of pre-resolution provider records;
- review-required products are counted once;
- verified taxonomy mapping now produces promotion-ready aggregate quality for a resolved NEW candidate;
- taxonomy gaps suppress only trusted mappings, using the same verified/provider-isolated semantics as resolution;
- suggested/rejected mappings with canonical target IDs no longer hide unresolved gaps;
- mappings for another provider do not suppress gaps for Open Icecat.

Regression coverage includes verified, suggested, rejected, absent/provider-isolated mappings, exact/non-exact products through existing acquisition coverage, multiple pages, and report/summary reconciliation.

## Memory and Boundedness

Provider-side retained work is now asserted against the documented bound. Heap before/after samples in the scale harness are retained-heap observations only, not peak-memory proof.

Run-retained structures:

- `raw.record` and `enrichedProduct` payload trees: can dominate memory if provider payloads grow;
- provider `pageStates` retained for emitted pages: grows with emitted pages in the current run;
- parsed pending candidates: bounded after this repair;
- matcher prepared data: `O(canonical products + aliases)`;
- canonical transient arrays during load/indexing: `O(canonical products + aliases)`;
- taxonomy gap Sets: `O(unresolved taxonomy IDs + samples)`;
- provider failures/errors: `O(failures)`;
- staged candidates and metric records: `O(usable/non-exact products)`.

Measured/estimated retained canonical + matcher state from Astra:

| Fixture | Retained state |
| --- | ---: |
| 1K canonical | about 2.06 MB |
| 10K canonical | about 20.26 MB |
| 100K canonical | about 202.75 MB |
| 10K with five longer aliases/product | about 68.28 MB |

Classification:

| Scale | Assessment |
| --- | --- |
| 1K | SAFE after provider queue repair for one controlled dry-run. |
| 10K | SAFE for bounded dry-run evidence, but matcher cost deserves review as canonical size grows. |
| 100K | NEEDS REDESIGN before rollout: retained run arrays, raw payloads, pageStates, and matcher state become material. |
| 1M | NEEDS REDESIGN: streaming aggregation, externalized durable state, payload trimming, and stronger matcher pruning required. |

First likely memory problem: provider raw/enriched payload retention plus accumulated staged candidates/metric records. First likely performance problem: canonical classification scans.

## Page and Batch Findings

Recommended future live dry-run settings remain:

- provider page size: 25;
- concurrency: 3;
- staged-product batch size: 200;
- staged-alias batch size: 500;
- recovery granularity: one acknowledged page.

Page size 25 keeps replay/failure scope small and stays well within the repaired provider bound. Larger pages reduce page/update overhead but increase replay and persistence failure scope. Smaller pages improve granularity but increase acknowledgment and database overhead. Concurrency is not a request-rate limiter and should not exceed 3 for the first live 1K dry-run.

## Apply Blockers Deferred

The following are real but safe to defer until apply/unattended ingestion work. They do not block a no-write 1K dry-run after the provider repair:

- alias conflict-key deduplication for case variants such as `X100` and `x100`;
- partial persistence recovery across separate product and alias writes;
- explicit disposition for normalization failures before durable acknowledgment;
- durable unattended checkpoint/recovery semantics.

## 100K and 1M Work Deferred

This PR deliberately does not implement global matcher redesign, ANN/fuzzy pruning, externalized run state, durable ingestion architecture, or 100K/1M catalog architecture. Those are documented future scale items, not blockers for one controlled dry-run.

## Reporting Cleanup

Old terminology:

`Enrichment failures (attempted but not usable)`

Intermediate terminology:

`Speculative enrichment attempts (not provider failures)`

Final terminology:

- `Usable successful details`
- `Failed detail requests`
- `Filtered/nonusable successful details`
- `Successful speculative completions beyond usable frontier`
- `Cancelled detail requests`

Actual provider failures remain distinguishable from filtered/speculative/cancelled outcomes and from aggregate `Provider errors`.

## Advisory Gates

| Gate | Status | Evidence |
| --- | --- | --- |
| Discovery correctness | PASS | Dense real-provider offline streaming counts, limit/source/attempt-cap termination, and page accounting pass. |
| Bounded concurrency | PASS | Concurrency 1/2/3/5 tests keep active requests within configured bounds. |
| Recovery correctness | PASS | Existing v2 continuation, page acknowledgment, error-only page, cancellation, and consumer-failure tests pass. |
| Matcher equivalence | PASS | Existing matcher equivalence and 6,000-case differential suites pass. |
| Matcher/index boundedness | REVIEW | One index is reused, but canonical-size cost grows as documented. |
| Taxonomy query behavior | PASS | Reads scale with unique IDs via the run-scoped cache. |
| Database batch behavior | PASS for dry-run readiness | Counting-store apply model is batched; apply blockers remain deferred. |
| Memory boundedness | REVIEW | Provider queue is bounded; raw payloads, pageStates, staged candidates, and metric records need redesign before 100K. |
| Telemetry reconciliation | PASS | Detail outcome categories reconcile to attempts. |
| Dry-run safety | PASS | Dry-run remains zero store calls/writes. |

## Recommendation

Recommendation: **A. ready for ONE human-controlled 1K Open Icecat dry-run**, after human review of this PR.

This means dry-run only:

- no `--apply`;
- no approval;
- no promotion;
- no production writes;
- page size 25;
- concurrency 3;
- operator watches termination reason, provider errors, outcome reconciliation, taxonomy misses, and matcher metrics.

It does not mean apply or unattended ingestion is ready.

Remaining blockers before live 1K dry-run: human review of the repaired provider tests/metrics and final confirmation of dry-run settings. No code-level blocker remains in this PR's offline evidence.

Live requests/writes/migrations performed by this PR: zero.
