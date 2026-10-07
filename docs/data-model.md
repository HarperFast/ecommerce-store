# Data model

Status: **P0 design.** Implements [Data model](../SPEC.md#data-model).

SPEC.md defines the eight tables neutrally. This document records the Harper-side design and the reasoning behind the choices that are not forced.

## Aggregates are computed on read, not maintained on write

**The fan-out is the measurement.** P0 exists because an architectural difference only appears where the architecture does work — four to five dependent waves and 60–150 reads per quote. Pre-aggregating `availability` into a per-region rollup would remove reads the specification deliberately requires, which `DATA-001` forbids outright:

> What it MUST NOT do is pre-join or denormalize them into a shape that removes a read the specification requires — that is the measurement, not an optimization.

**The write path must stay cheap.** The background writer is not under test and its latency is not a headline metric, but it is not free either. Maintaining a per-region availability rollup would make every inventory write also a rollup write — amplification on a path whose only job is to keep caches honest.

**Nothing sorts or filters on an aggregate any more.** The two remaining derived values are cheap: `resolvedPrice` is per-tier computation over `variant.basePrice`, not aggregation at all; `availability` is a sum over the inventory rows for one sku in one region, which is a bounded fan-out, not a scan.

So: resolve on read. The one genuinely maintained aggregate, `reviewRollup`, is a field on `product` seeded with the dataset — real systems maintain it asynchronously, and nothing in P0 writes reviews.

**This holds only while nothing sorts or filters on an aggregate.** Facet counts over the catalog, or `sort=price_asc` across products, are queries nobody ships without materializing first — so listing pages reintroduce the pressure to maintain aggregates on write, and the decision has to be made again on the requirements that exist then. The candidate facet-counting mechanisms are in [`future-work.md`](future-work.md).

## Promotion eligibility, and why it is indexed with a sentinel

An empty eligibility array means "no restriction on this dimension", and an empty array is exactly what an index cannot match. That one fact rules out both obvious implementations:

- **Probe the authoritative arrays directly** — `tiers = <tier>` and `categoryIds = <category>` — and a promotion unrestricted on *both* dimensions can never be returned. The promotions lost are precisely the globally-applicable ones, so the quote is wrong in the direction nobody notices.
- **Scan the table and filter in application code** — correct, and it reads every promotion in the corpus on every quote.

So the rows carry `tierKeys` and `categoryKeys`: the same values, or `['*']` when unrestricted. "Applies to everything" becomes an indexable value like any other, so one `in` probe per dimension covers both cases and the two conditions AND to a **superset** of the eligible set. `isEligible` then applies the authoritative arrays.

Superset, never subset, is the property that matters — a narrowing that can exclude an eligible promotion makes quotes silently cheaper and silently wrong. `scripts/verify-promotion-index.mjs` checks it against every tier × category combination offline, and runs in CI.

`skus` is deliberately not an index dimension: a SKU-restricted promotion is still reachable through its other two, so indexing it would add a third probe for no additional reach.

**Selectivity is a property of the data as much as the index.** The promotion corpus is generated so that a handful of offers run storewide and the rest target a category, a tier or a SKU — which is what a real store looks like, and what makes the sentinel probe selective. A corpus where most promotions are unrestricted on both dimensions defeats the index no matter how it is built, because `['*']` is then the common case rather than the exception.

## Entities

```graphql
type Cart @table @export @sealed {
  id: ID @primaryKey
  customerId: String @indexed
  lines: Any            # [{ sku, quantity }] — embedded; one read yields the cart
}

type Customer @table @export @sealed {
  id: ID @primaryKey
  tier: String @indexed
  loyaltyBalance: Int
  region: String @indexed
  taxJurisdiction: String @indexed
}

type Product @table @export @sealed {
  id: ID @primaryKey
  title: String
  categoryIds: [String] @indexed
  weight: Int
  relatedProductIds: [String]
  reviewRollup: Any
}

type Variant @table @export @sealed {
  sku: ID @primaryKey
  productId: String @indexed
  options: Any
  basePrice: Int
  weight: Int
}

type Inventory @table @export @sealed {
  id: ID @primaryKey      # `${sku}:${locationId}`
  sku: String @indexed
  locationId: String @indexed
  onHand: Int
}

type Location @table @export @sealed {
  id: ID @primaryKey
  region: String @indexed
  priority: Int
}

type Promotion @table @export @sealed {
  id: ID @primaryKey
  kind: String @indexed
  # Authoritative eligibility. NOT indexed — an empty array means "no restriction on this
  # dimension", and an index cannot match an empty array. `isEligible` reads these.
  tiers: [String]
  skus: [String]
  categoryIds: [String]
  # The indexable form of the same values, or ['*'] when unrestricted. See above.
  tierKeys: [String] @indexed
  categoryKeys: [String] @indexed
  thresholdMinor: Int
  amountMinor: Int
  amountBasisPoints: Int
}

type Rate @table @export @sealed {
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

And the one table the specification does not describe, because it is derived rather than a source of truth:

```graphql
# A cache, not an entity. CACHE-001: dropping it changes no response body, only latency.
# Keyed by product x tier x region because PDP-002 says the value varies by both. The
# expiration is the backstop behind write-through invalidation, not the primary mechanism —
# CACHE-002 requires every cached value to be bounded and to say which bound applied.
type ProductView @table(expiration: 120) {
  id: ID @primaryKey
  productId: String @indexed
  tier: String
  region: String
  payload: Any
  assembledAt: Long
}
```

### Notes

- **Cart lines are embedded.** The specification describes the first wave as "read cart" — one read — and the per-line fan-out as the *second* wave. Splitting lines into their own relation would add a wave that the specification does not describe, changing the measured shape. A normalized stack that must split them documents the mapping (`DATA-001`).
- **`Inventory` carries a synthetic primary key** of `sku:locationId` so a line's availability is a bounded set of direct reads rather than a scan, on every implementation.
- **`@export` on every table** gives the admin and seeding surface for free. That asymmetry against stacks which hand-write it is a qualitative finding, not test scaffolding — but it is **not** a measured endpoint in P0.

## Open

- **The promotion evaluation order in [POST /cart/:id/quote](../SPEC.md#post-cartidquote) is invented**, not derived from a real pricing engine. It is normative because the alternative is two correct implementations disagreeing on a total — but it should be sanity-checked against someone who has built one.
- **How selective the promotion index can get.** It narrows to 7.2% of the table on `dev`. Tier is the floor: four values means a tier probe can never return less than roughly a quarter plus the storewide share. A composite `(tierKey, categoryKey)` index, or folding tier into the category key, would go further — worth measuring at `bench` scale before building.
