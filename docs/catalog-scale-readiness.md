# Catalog 1K Scale Readiness

## Scope

This report is based on the deterministic offline command:

```sh
npm run catalog:scale-readiness
```

The harness uses a fake discovery provider and counting staging store, but calls the real `acquireDiscoveredProducts` -> `acquireFromRecords` pipeline, run-scoped taxonomy resolver, Matcher V2 index, report builder, and apply-mode staging contract. It makes zero Icecat requests and zero production writes.

Configuration: page size 25, concurrency 3, 10 repeated taxonomy IDs, and deterministic canonical fixtures. Wall-clock values below are sample observations and are not CI thresholds.

## Complexity Map

| Component | Time | Retained memory | Current behavior |
| --- | --- | --- | --- |
| Provider discovery/parser | O(provider records) | O(parser bound + admission window) | Real Icecat streaming path is bounded by parser pending budget plus `2 * concurrency`; the fixture provider reports admission high-water 6 and active-request high-water 3. |
| Candidate admission/enrichment | O(index records + detail attempts) | O(admission/reorder window) | Ordered coordinator preserves encounter order and only acknowledges after downstream processing. |
| Canonical catalog load | O(canonical rows + aliases) | O(canonical rows + aliases) | Canonical lookup reads five table families with pagination. |
| Matcher index build | O(canonical rows + aliases) | O(canonical rows + aliases) | One index is built and reused for the run. |
| Acquisition classification | O(products * canonical candidates examined) in the exercised worst case | O(products retained for the run) | Exact and same-brand checks still inspect the canonical array; Matcher V2 retrieval/scoring is indexed but classification telemetry shows the remaining scans. |
| Taxonomy resolution | O(products) resolver calls, O(unique IDs) underlying reads | O(unique taxonomy IDs) | Run-scoped cache reduces 1,000 logical resolutions to 10 misses and 990 hits. |
| Staged candidate construction/reporting | O(usable products) | O(staged candidates + metric records) | The current run retains both `metricRecords` and the accumulated staged result. |
| Apply persistence | O(pages + staged batches + alias batches) | O(one page/batch at a time in Supabase store) | Supabase writes are batched at 200 products and 500 aliases. |

## Offline Results

| Incoming products | Canonical products | Pages | Matcher canonical entries examined | Specificity witnesses | Taxonomy misses/hits | Sample downstream total |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 1,000 | 4 | 300,000 | 200,000 | 10 / 90 | 410 ms |
| 500 | 1,000 | 20 | 1,500,000 | 1,000,000 | 10 / 490 | 1,598 ms |
| 1,000 | 1,000 | 40 | 3,000,000 | 2,000,000 | 10 / 990 | 3,003 ms |

All three dry-run workloads had zero persistence calls, one matcher index build, 3 active detail requests maximum, admission high-water 6, reorder high-water 0, and zero unbounded telemetry entries. The advisory gates were PASS for each dry-run workload.

### Canonical size impact at 1,000 products

| Canonical products | Index build | Matcher execution | Downstream total | Canonical entries examined |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | about 16 ms | about 3,083 ms | about 3,137 ms | 3,000,000 |
| 10,000 | about 115 ms | about 30,165 ms | about 30,297 ms | 30,000,000 |

This fixture intentionally uses a new brand so the classification path exercises the worst-case canonical scans. It identifies the next profiling target; it is not a production latency promise.

## Apply Database Model

The 1,000-product apply simulation used 40 acquisition pages and produced these counted operations:

| Operation | Count |
| --- | ---: |
| Taxonomy mapping misses | 10 logical misses |
| Taxonomy mapping reads | 10 |
| Canonical validation reads in the counter | 10 logical validations |
| Canonical catalog table-family reads | 5 |
| Source upserts | 1 |
| Import-run writes | 2 (insert plus final update) |
| Staged-product write batches | 40 |
| Staged-alias write batches | 40 |
| Staged-product count reads | 1 |
| Hidden per-product reads/writes | 0 |

For a verified mapping with both category and subcategory IDs, one Supabase taxonomy cache miss can require three requests: one mapping lookup, one category validation, and one subcategory validation. A category-only mapping requires two. The current resolver performs these sequentially per unique miss; the offline harness intentionally reports the request model without changing it.

The staged write path is page-driven here because the real acquisition orchestrator submits each page to the store. The Supabase store additionally chunks any page larger than 200 products and aliases larger than 500 rows. At a recommended page size of 25, the apply model is bounded and recovery granularity is one page.

## Failure and Recovery

The harness passed all of these checks:

- provider/detail failure path remains reportable without converting the record into a usable enrichment;
- early, middle, and final persistence failure paths stop before page acknowledgment;
- cancellation does not acknowledge unsafe work;
- acknowledged continuation resumes deterministically from the next page;
- ordered results remain deterministic;
- dry-run performs zero store calls and zero writes.

The durable crash-recovery contract remains the existing acknowledged-continuation contract. This PR does not redesign it.

## Memory Audit

The current run-retained structures are:

- canonical catalog and matcher index: O(canonical products + aliases);
- run-scoped taxonomy cache: O(unique provider taxonomy IDs);
- accumulated normalized metric records: O(usable products);
- accumulated staged candidates: O(non-exact candidates);
- invalid records and provider errors: O(failures);
- continuation metadata: O(1) per current frontier, not a history;
- page-local provider and staging batches: bounded by page/batch size.

Assessment:

| Scale | Assessment |
| --- | --- |
| 1K | Safe for controlled dry-run/apply simulation. |
| 10K | Safe for bounded fixtures, but canonical matcher work is already the dominant risk in the worst-case fixture. |
| 100K | Redesign required before rollout: accumulated candidates/metric records and repeated classification scans become material. |
| 1M | Redesign required: streaming result/report aggregation, externalized staging/report state, and a more strongly bounded matcher path are necessary. |

No 100K/1M redesign is included.

## Page and Batch Recommendation

Use page size 25 for the first human-controlled 1K dry-run with concurrency 3. It keeps recovery granularity clear, limits page-local writes, and remains far below the provider's bounded admission window. Larger pages reduce page/update frequency but increase replay and persistence failure scope. Smaller pages increase acknowledgment and database overhead without changing taxonomy cache cardinality. No live run was performed.

## Advisory Scale Gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Discovery correctness | PASS | 100/500/1000 deterministic counts and page accounting. |
| Bounded concurrency | PASS | max active 3, admission high-water 6. |
| Recovery correctness | PASS | acknowledged frontier and deterministic resume tests. |
| Matcher equivalence | PASS | Existing PR #31 equivalence and differential suites remain required validation. |
| Matcher/index boundedness | REVIEW | One index is reused, but worst-case classification grows with canonical size. |
| Taxonomy query behavior | PASS | 10 unique IDs produced 10 cache misses, not 1,000. |
| Database batch behavior | PASS | 40 page product batches and 40 alias batches at 1K; no per-product calls. |
| Memory boundedness | REVIEW | Safe at 1K; accumulated run arrays need redesign before 100K. |
| Telemetry reconciliation | PASS | Phase counters reconcile and telemetry entries remain bounded. |
| Dry-run safety | PASS | Zero store calls and zero production writes. |

Overall recommendation: **A. Ready for Astra review before a controlled live 1K dry-run**, with the matcher worst-case and taxonomy request model explicitly reviewed first. The gates are advisory and do not authorize a live run or writes.

## Reporting Cleanup

The report now says `Speculative enrichment attempts (not provider failures)`. Actual provider failures remain separately reported under `Provider errors`, preserving the distinction between speculative attempts and failed provider responses.

## Final Conclusions

- Biggest remaining 1K bottleneck: matcher classification in the adversarial all-new-brand fixture; the live PR #31 sample did not show Matcher V2 as the dominant path, so this needs profiling evidence rather than speculative optimization.
- Biggest remaining 10K bottleneck: canonical-scale classification work, which reached about 30 seconds for 1,000 candidates in the worst-case fixture.
- Blockers before live 1K dry-run: human review of the advisory gates, taxonomy mapping coverage, and the selected page/concurrency configuration; no correctness blocker was found offline.
- Safe to defer: streaming aggregation and matcher redesign for 100K/1M, provided rollout remains controlled and bounded.
- Migration required: no.
- Live requests/writes: zero.
