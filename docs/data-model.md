# Data model

Status: **P0 design.** Implements SPEC.md §3.

SPEC.md defines the eight tables neutrally. This document records the Harper-side design and the one decision that reversed when P0 narrowed.

## Aggregates are computed on read, not maintained on write

An earlier draft of this specification decided the opposite. That decision rested on two requirements that are now future work: facet counts over 100k+ SKUs on every listing request, and `sort=price_asc` over 50,000 products. Sorting by a value derived from many variants is not a query anyone ships without materializing it first, so aggregates were maintained on write.

Neither requirement exists in P0, and with them gone the argument inverts.

**The fan-out is the measurement.** P0 exists because an architectural difference only appears where the architecture does work — four to five dependent waves and 60–150 reads per quote. Pre-aggregating `availability` into a per-region rollup would remove reads the specification deliberately requires, which `DATA-001` forbids outright:

> What it MUST NOT do is pre-join or denormalize them into a shape that removes a read the specification requires — that is the measurement, not an optimization.

**The write path must stay cheap.** The background writer is not under test and its latency is not a headline metric, but it is not free either. Maintaining a per-region availability rollup would make every inventory write also a rollup write — amplification on a path whose only job is to keep caches honest.

**Nothing sorts or filters on an aggregate any more.** The two remaining derived values are cheap: `resolvedPrice` is per-tier computation over `variant.basePrice`, not aggregation at all; `availability` is a sum over the inventory rows for one sku in one region, which is a bounded fan-out, not a scan.

So: resolve on read. The one genuinely maintained aggregate, `reviewRollup`, is a field on `product` seeded with the dataset — real systems maintain it asynchronously, and nothing in P0 writes reviews.

**This reverses cleanly if listing pages return.** The earlier reasoning is preserved in [`future-work.md`](future-work.md), including the three candidate facet-counting mechanisms. Reintroducing faceting reintroduces the pressure to materialize, and the decision should be re-made then rather than inherited from either draft.

## Promotion eligibility, and why it is indexed with a sentinel

An empty eligibility array means "no restriction on this dimension" — and an empty array is exactly what an index cannot match. That single fact broke this twice:

1. **Indexed, incomplete.** Probing `tiers = <tier>` and `categoryIds = <category>` could never return a promotion unrestricted on *both*. 14% of the corpus was unreachable, and it was precisely the globally-applicable 14%.
2. **Correct, unscalable.** Replacing it with a full sorted scan was right, and ran over all 5,000 `bench` promotions on every quote.

The rows now carry `tierKeys` and `categoryKeys`: the same values, or `['*']` when unrestricted. "Applies to everything" becomes an indexable value like any other, so one `in` probe per dimension covers both cases and the two conditions AND to a **superset** of the eligible set. `isEligible` then applies the authoritative arrays.

Superset, never subset, is the property that matters — a narrowing that can exclude an eligible promotion makes quotes silently cheaper and silently wrong. `scripts/verify-promotion-index.mjs` checks it against every tier × category combination offline, and runs in CI.

`skus` is deliberately not an index dimension: a SKU-restricted promotion is still reachable through its other two, so indexing it would add a third probe for no additional reach.

**Corpus note.** Selectivity is a property of the data as much as the index. Nearly half the promotions used to be unrestricted on tier and on category, which no real store looks like — a handful of offers run storewide, the rest target a category, a tier or a SKU. With that corrected, a probe returns 7.2% of the table instead of 31%.

## Entities

```graphql
type Cart @table @export {
  id: ID @primaryKey
  customerId: String @indexed
  lines: Any            # [{ sku, quantity }] — embedded; one read yields the cart
}

type Customer @table @export {
  id: ID @primaryKey
  tier: String @indexed
  loyaltyBalance: Int
  region: String @indexed
  taxJurisdiction: String @indexed
}

type Product @table @export {
  id: ID @primaryKey
  title: String
  categoryIds: [String] @indexed
  weight: Int
  relatedProductIds: [String]
  reviewRollup: Any
}

type Variant @table @export {
  sku: ID @primaryKey
  productId: String @indexed
  options: Any
  basePrice: Int
  weight: Int
}

type Inventory @table @export {
  id: ID @primaryKey      # `${sku}:${locationId}`
  sku: String @indexed
  locationId: String @indexed
  onHand: Int
}

type Location @table @export {
  id: ID @primaryKey
  region: String @indexed
  priority: Int
}

type Promotion @table @export {
  id: ID @primaryKey
  kind: String @indexed
  tiers: [String] @indexed
  skus: [String] @indexed
  categoryIds: [String] @indexed
  thresholdMinor: Int
  amountMinor: Int
  amountBasisPoints: Int
}

type Rate @table @export {
  id: ID @primaryKey
  kind: String @indexed
  region: String @indexed
  weightMin: Int
  weightMax: Int
  jurisdiction: String @indexed
  amountMinor: Int
  basisPoints: Int
}
```

### Notes

- **Cart lines are embedded.** The specification describes the first wave as "read cart" — one read — and the per-line fan-out as the *second* wave. Splitting lines into their own relation would add a wave that the specification does not describe, changing the measured shape. A normalized stack that must split them documents the mapping (`DATA-001`).
- **`Inventory` carries a synthetic primary key** of `sku:locationId` so a line's availability is a bounded set of direct reads rather than a scan, on every implementation.
- **`@export` on every table** gives the admin and seeding surface for free. That asymmetry against stacks which hand-write it is a qualitative finding, not test scaffolding — but it is **not** a measured endpoint in P0.

## Open

- **The promotion evaluation order in SPEC.md §4 is invented**, not derived from a real pricing engine. It is normative because the alternative is two correct implementations disagreeing on a total — but it should be sanity-checked against someone who has built one.
- **How selective the promotion index can get.** It narrows to 7.2% of the table on `dev`. Tier is the floor: four values means a tier probe can never return less than roughly a quarter plus the storewide share. A composite `(tierKey, categoryKey)` index, or folding tier into the category key, would go further — worth measuring at `bench` scale before building.
