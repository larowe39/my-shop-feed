# Catalog Expansion Batch 2 Notes

## Brembo ambiguity

The production listing `Brembo GT Gran Turismo 6-Piston Big Brake Kit` remains ambiguous under Matcher V2 after the Batch 2 data expansion.

Current high-confidence candidates are:

- `Brembo High Performance 6-Piston Kit`
- `Brembo GT Gran Turismo`

The ambiguity appears to be a catalog data modeling overlap, not a matcher scoring issue: one canonical product models the GT Gran Turismo line while another models the 6-piston kit attribute as a separate product identity. A safe correction likely requires deciding whether piston count is a variant/specification of a GT kit or a separate canonical kit family, then migrating or preserving existing `catalog_product_id` relationships accordingly.

No canonical Brembo rows were merged, deleted, or renamed in Batch 2.
