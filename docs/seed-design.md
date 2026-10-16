# Dataset generation

**Status:** P0 design. Implements the [data contract](../SPEC.md#data-model).

## Generate once, load the artifact

The dataset is generated deterministically, committed, and checksummed (`DATA-003`, `DATA-005`). Every implementation loads that artifact. Re-running a generator in each stack would make identity depend on matching PRNG consumption, rounding, and iteration order across runtimes.

The generator remains in source as the reproducibility audit trail. **Regeneration changes the contract; it is not a setup step.**

## Format and identity

Each scale has one NDJSON file per table and a `MANIFEST.json`:

```text
dataset/dev/
  cart.ndjson       customer.ndjson   product.ndjson    variant.ndjson
  inventory.ndjson  location.ndjson   promotion.ndjson  rate.ndjson
  MANIFEST.json
```

NDJSON has canonical key order and supports streaming imports without holding the dataset in memory. The manifest records generator version, seed, per-file SHA-256, row counts, and distributions. Verify it before each load and record it with each run.

`bench` files are compressed and stored in Git LFS. Expand and verify them with:

```bash
node scripts/prepare-dataset.mjs --scale bench
```

Checksums cover **uncompressed bytes**, so compression does not change dataset identity.

## Scale

There is one benchmark size: `bench`, designed to exceed the target's memory (`DATA-004`). Store size is not a benchmark variable. The smaller `dev` fixture is for local development and CI only and never appears in a result.

## Determinism rules

1. Consume one seeded PRNG in a fixed order. No `Math.random`, `Date.now`, `randomUUID`, or unordered iteration.
2. Derive ids from row positions so generator changes produce meaningful diffs.
3. Derive timestamps from row indices and a fixed epoch.
4. Generate money as integer minor units throughout (`DATA-002`).
5. Keep category, tier, region, jurisdiction, and option vocabularies fixed in source.
6. Declare distributions in the manifest.

## Distributions

| Dimension | Required shape |
|---|---|
| Cart size | Mostly small carts, with a meaningful large-cart tail to exercise fan-out. |
| Variants per product | A long tail rather than a constant. |
| Inventory | Stock varies across locations so priority resolution does real work. |
| Promotions | Reach every pricing phase at both scales: exclusive, threshold, BOGO, stackable, the stacking limit and the 60% cap. A fixed set of 120 campaign promotions (tier and category offers, exclusives bounded to one per category in four categories) is the same at every scale; the rest are product promotions, each restricted to one popular product's SKUs. |
| Access | A hot subset makes cache hits measurable, and a cold tail larger than memory makes `DATA-004` hold. Reads and writes target the same working set (`WRITE-001`). |

The generator and harness share the access distribution in [packages/spec/src/workload.ts](../packages/spec/src/workload.ts), stated in [SPEC.md](../SPEC.md#access-distribution): a discrete Zipf with `s = 0.8845`, scrambled from rank to key. `MANIFEST.json` records both the expected head and top-key mass and the mass the generated carts actually hold.

[verify-pricing-phases.mjs](../scripts/verify-pricing-phases.mjs) prices every cart offline and fails `npm run check` if the share of carts reaching any pricing phase leaves its band, at either scale. `bench` is checked when its LFS objects are present, and always by the dataset workflow.

## Regenerations

Each regeneration changes the contract, so each is recorded here.

| Generator | Date | Change | Tables changed |
|---|---|---|---|
| `0.6.0` | 2026-10-16 | Promotions: 120 campaign promotions at both scales with exclusives bounded per category, and product promotions for the rest (40 on `dev`, 4,880 on `bench`). Under `0.5.0` every `bench` quote stopped at an exclusive promotion, so threshold, BOGO, stackable and the cap applied in none; now they reach 59%, 47%, 77% and 12% of `bench` carts. | `promotion` only; every other table is byte-identical |
| `0.5.0` | 2026-10-12 | Cart lines draw products from a scrambled discrete Zipf (`s = 0.8845`). The continuous power law it replaces put 22.5% of a 20,000-key draw on one key and clustered the hot set at the lowest ids. | `cart` only; every other table is byte-identical |
| `0.4.0` | before 2026-10-12 | The dataset every earlier run and observation used. | — |

**Every number produced before generator `0.5.0` used the `0.4.0` dataset** and is not comparable with later runs. **No quote-path number from `0.5.0` is comparable with `0.6.0`:** the promotions every quote reads and evaluates changed.
