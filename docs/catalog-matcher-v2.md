# Catalog Matcher V2

## V1 scoring behavior

V1 normalizes punctuation and case, then scores exact product/model/alias
matches at 0.90 or above. A seller title that contains a complete canonical
identity plus descriptive words is not exact. It falls through to token
overlap (0.78 with brand agreement) or prefix/substring matching (0.74), so
otherwise clear listings cannot be automatically assigned.

V1 does not explicitly model conflicting brand evidence or model/reference
disagreement. It relies on bounded brand candidate retrieval and the high
confidence threshold for safety.

## V2 intent

V2 retains the 0.90 automatic assignment threshold. It adds explicit evidence
for complete, distinctive canonical identity containment and exact normalized
model identifiers, while treating conflicting supplied brands and model-like
identifier disagreements as contradictions. It retains ambiguity handling in
the callers and only resolves variants with exact variant-level evidence.

## V2 scoring rules

- Exact brand plus a complete canonical identity contained as whole tokens: 0.95.
- Exact brand plus a complete normalized alias contained as whole tokens: 0.96.
- Exact brand plus a distinctive model/reference identifier: 0.97.
- Exact complete title/model/variant behavior remains at its existing 0.90-0.98 scores.
- A conflicting explicit input brand scores 0.20, regardless of a contained model.
- A listing that extends a contained identity with `max`, `plus`, `pro`, or
	`ultra` scores 0.30 for the shorter candidate. This prevents automatic
	matching of a shorter sibling such as iPhone 15 Pro for iPhone 15 Pro Max.
- Any high-scoring shorter contained identity is reduced to 0.89 if a longer,
	independently contained identity is present. Every prepared candidate,
	including a conflicting-brand candidate that skips full scoring, remains
	available as specificity evidence. Callers skip multiple remaining highs.

The matcher is bounded by brand and optional category before scoring in both
the mobile lookup and the backfill snapshot. Product confidence and variant
confidence remain separate: variants still need an exact variant-level name,
alias, or product-plus-color/size match at 0.90 or above.

## Acquisition index

Acquisition builds one `CatalogMatcherIndex` from the exact canonical snapshot
at the start of an acquisition run. It precomputes normalized and compact
candidate text, token sets, aliases, and variant evidence, then reuses those
representations for every record and discovery page. The index is passed
explicitly through the run; it is never global and is not reused after the
run's catalog snapshot changes. The current provider orchestration does not
mutate the canonical snapshot during discovery, so a new invocation is the
invalidation boundary.

The reference matcher still scores every candidate. Acquisition classification
avoids full scoring only when an explicit incoming brand conflicts with a
candidate's non-empty brand; that result is known to be 0.20. Those candidates
remain in the complete ordered result and in specificity witness processing.
Same-brand and normalized-empty-brand candidates receive full scoring. A title
form with its leading brand removed is used only for a candidate whose own
non-empty normalized brand matches the incoming brand.

Index metrics are bounded aggregates: build time/count, products and aliases
indexed, records classified, canonical entries examined, full scorer
invocations, specificity witness checks, and separate retrieval, scoring,
finalization, execution, and build-inclusive timings. No per-record telemetry
is retained. Historical persisted runs without these fields report the matcher
metrics as unavailable rather than measured zero.

The index owns an immutable canonical snapshot for one acquisition invocation
and is reused across discovery pages. Staging does not mutate that snapshot;
a new invocation rebuilds it. There is no global cache.

The benchmark command is a matcher microbenchmark, not an end-to-end
acquisition throughput measurement. The current index still examines the
prepared catalog in $O(N)$ time per fuzzy lookup, and specificity is worst-case
$O(K^2)$ when many contained identities require pair checks. Brand buckets,
large-scale memory work, and a stronger specificity index remain future scale
work; current measurements are not evidence of 100k- or million-product
readiness.