# Catalog Taxonomy Expansion

This branch formalizes the next phase of the catalog taxonomy work without mutating production data, writing new canonical catalog records, or applying taxonomy mappings.

## Scope

The goal is to keep Open Icecat taxonomy as provenance while building a durable internal PENCHANT taxonomy that is deliberate, reviewable, and safe to apply later.

## Verified authoritative mapping candidate

The first verified mapping candidate is:

- open-icecat:151 -> Electronics > Computers > Laptops

This is already consistent with the existing canonical taxonomy and should be treated as a dry-run verification target only until the operator explicitly applies the mapping.

## Proposed internal printing taxonomy

Recommended internal-only hierarchy:

- Electronics
  - Printers & Scanners
    - Printing Supplies
      - Ink Cartridges
      - Print Heads
      - Printer Ribbons
    - Printing Media
      - Large Format Media
      - Printing Paper
      - Printing Films
      - Printable Textiles
      - Plotter Paper

The current canonical taxonomy already contains the Electronics > Computers > Laptops node; the missing work is the internal-only printing branch. This branch should not become discovery-visible and should not be added to the global category tiles.

## Photo Paper review

Photo Paper remains review-dependent.

Evidence:

- Official Open Icecat parent is Photographic Filmmaking Supplies.
- The codebase’s canonical taxonomy is not a photography-media taxonomy; it includes cameras and camera subtypes rather than paper classes.
- The first 100-product run showed a legitimate gap around printing materials, but Photo Paper does not cleanly map to the printing-media wrapper without human review.

Recommendation: leave unresolved for now unless a human operator decides to create a dedicated photography-oriented internal classification.

## Mapping plan

Verified mapping targets remain conservative and internal-only:

- 151 -> Electronics > Computers > Laptops
- 971 -> Electronics > Printers & Scanners > Printing Media > Large Format Media
- 846 -> Electronics > Printers & Scanners > Printing Supplies > Print Heads
- 853 -> Electronics > Printers & Scanners > Printing Media > Printing Films
- 377 -> Electronics > Printers & Scanners > Printing Supplies > Ink Cartridges
- 714 -> Electronics > Printers & Scanners > Printing Media > Printing Paper
- 845 -> Electronics > Printers & Scanners > Printing Media > Printable Textiles
- 702 -> Electronics > Printers & Scanners > Printing Media > Plotter Paper
- 905 -> Electronics > Printers & Scanners > Printing Supplies > Printer Ribbons

Photo Paper should remain as a separate review item and not be applied automatically.

## Coverage simulation

The read-only coverage simulation should answer the following:

- Current resolved: 0/100 for the historical 100-product gate.
- Proposed mapping set resolves the affected external categories for the current run.
- Still unresolved: remaining categories outside the reviewed mapping set.

This should be computed from the run data rather than hardcoded.

## Safety rules

This PR keeps the following boundaries intact:

- no Icecat acquisition writes
- no staging mutation
- no canonical taxonomy writes
- no taxonomy mapping writes
- no approval or promotion
- no migrations
- no deletion of historical diagnostic runs

## Operator apply sequence

1. review canonical taxonomy needs
2. validate catalog-data taxonomy
3. dry-run canonical import
4. human apply canonical nodes
5. verify the canonical tree
6. dry-run taxonomy mapping validation
7. human apply verified mappings
8. generate coverage report
9. confirm future acquisitions reuse the verified mapping deterministically

## Validation status

The repository already contains the read-only validation paths and taxonomy tests for the current implementation. This branch intentionally does not perform production writes or production mapping application.
