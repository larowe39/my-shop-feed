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

	`ultra` scores 0.30 for the shorter candidate. This prevents automatic
	matching of a shorter sibling such as iPhone 15 Pro for iPhone 15 Pro Max.
	contained identity is reduced to 0.89 if a longer, independently contained
	identity is present. Callers skip cases with multiple remaining high scores.

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
may use a narrower pool only when an explicit incoming brand is present: a
candidate with a different non-empty brand returns 0.20 before any other
evidence, below the 0.70 possible-match threshold. Same-brand and empty-brand
candidates remain in the pool, so this optimization cannot remove a candidate
that could change acquisition classification, confidence, or ambiguity.

Index metrics are bounded aggregates: build time/count, products and aliases
indexed, records classified, candidates considered, scoring operations, and
matcher timings. No per-record telemetry is retained.