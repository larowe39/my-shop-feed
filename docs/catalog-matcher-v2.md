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
- When several catalog candidates are supplied, any high-scoring shorter
	contained identity is reduced to 0.89 if a longer, independently contained
	identity is present. Callers skip cases with multiple remaining high scores.

The matcher is bounded by brand and optional category before scoring in both
the mobile lookup and the backfill snapshot. Product confidence and variant
confidence remain separate: variants still need an exact variant-level name,
alias, or product-plus-color/size match at 0.90 or above.