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
| Promotions | Vary eligibility and exercise stacking, exclusivity, thresholds, and BOGO. |
| Access | A hot subset makes cache hits measurable. Reads and writes target the same working set (`WRITE-001`). |

The generator and harness share the access distribution in [packages/spec/src/workload.ts](../packages/spec/src/workload.ts). Current promotion-phase balance is an [open design issue](plan.md#open).
