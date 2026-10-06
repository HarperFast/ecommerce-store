# Dataset generation

Status: **P0 design.** Implements SPEC.md, "Data model".

## Generate once, commit the artifact

`DATA-003` requires every implementation to load the same data, and `DATA-005` requires it generated deterministically and kept under version control.

The tempting approach is to ship a generator each implementation runs. It is the wrong one: it makes dataset identity depend on every implementation reproducing the same PRNG stream, the same rounding, and the same iteration order, across languages and runtimes. That is a guarantee re-proved on every comparison, and its failure mode is silent — a few hundred differing inventory rows read as a platform difference.

> **The generator runs once. The output is committed and checksummed. Every implementation loads the artifact. Identity is established by checksum, not by re-derivation.**

### Format

Newline-delimited JSON, one file per table, with canonicalized key order:

```
dataset/
  cart.ndjson  customer.ndjson  product.ndjson  variant.ndjson
  inventory.ndjson  location.ndjson  promotion.ndjson  rate.ndjson
  MANIFEST.json
```

NDJSON because it streams. The dataset is deliberately larger than memory (`DATA-004`), so an importer that must parse one large array before writing anything forces every implementation to solve a problem the benchmark is not about.

`MANIFEST.json` carries the generator version, the seed, per-file SHA-256 and row counts, and the declared distributions. Verified before every run; recorded with every published result.

## One size

There is one dataset, sized so the working set does not fit in memory on the benchmark hardware. No small in-memory variant, and store size is not swept as a variable — a comparison measures the architecture, not the dataset.

A small fixture for local development and CI is a convenience and may exist, but it is never a benchmark target and never appears in a result.

## Determinism rules

Each exists because it is a way a dataset silently stops being reproducible.

1. **One seeded PRNG, consumed in a fixed order.** No `Math.random`, no `Date.now`, no `randomUUID`, no iteration over an unordered structure.
2. **Ids are derived, not drawn** — `product-00042`, `sku-00042-03`. A generator change becomes a diff rather than a reshuffle.
3. **No wall clock anywhere.** Timestamps derive from the row index against a fixed epoch constant.
4. **Money is integer minor units at every step** (`DATA-002`). Prices are drawn as integers; no float is constructed and rounded.
5. **Vocabularies are fixed tables in source** — categories, tiers, regions, jurisdictions, option axes. Never sampled externally, never model-generated.
6. **Distributions are explicit and recorded in the manifest.**

### Distribution shape

Uniform data is the easiest way to accidentally produce a flattering benchmark, because it makes caching and lookup artificially even.

- **Cart size** — the load generator needs a realistic distribution, and the dataset must contain carts matching it. Most carts are small; a meaningful tail is large, and the tail is where the fan-out cost shows.
- **Variants per product** — a long tail, not a constant.
- **Inventory across locations** — a sku is stocked at some locations and not others, so location-priority resolution (`QUOTE-003`) does real work rather than always hitting the first.
- **Promotion eligibility** — most carts qualify for few promotions, some for many with stacking and exclusivity in play. A dataset where promotions rarely apply would skip the pricing logic the endpoint exists to exercise.
- **Access skew** — the read workload is not uniform over the catalog. A hot subset is what makes cache-hit rate a meaningful measurement at all, and `WRITE-001` requires the writer to target the same working set.

## Why the generator still ships

The artifact is what implementations consume, but the generator is committed alongside it. `DATA-005` requires the dataset be reproducible, and a committed artifact nobody can regenerate is a magic file. The generator is the audit trail; the artifact is the contract.
