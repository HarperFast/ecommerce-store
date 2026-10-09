# Data model

**Status:** P0 design. [SPEC.md](../SPEC.md#data-model) defines the logical entities; [schemas/store.graphql](../schemas/store.graphql) defines the Harper schema. This document explains the implementation choices.

## Resolve aggregates on read

The benchmark measures dependent reads. `DATA-001` forbids pre-joining the source of truth to remove that work; derived caches remain allowed.

P0 needs only bounded calculations: tier pricing over `variant.basePrice` and availability across a SKU's regional inventory. Resolving them on read also avoids maintaining a rollup on every inventory write. `reviewRollup` is seeded on `product`; P0 has no review writes.

Revisit this decision when listing pages need catalog-wide sorting or filtering on aggregates. [Future work](future-work.md#product-listing-facets-and-search) records the facet-counting options.

## Promotion eligibility index

An empty eligibility array means unrestricted. Probing the authoritative arrays directly would miss unrestricted promotions; scanning every promotion would be correct but costly at scale.

Harper stores `tierKeys` and `categoryKeys` alongside the authoritative arrays. Each contains the same values, or `['*']` when unrestricted. One `in` probe per dimension, combined with AND, returns a **superset** of eligible promotions. `isEligible` then checks the authoritative tier, SKU, and category arrays.

[scripts/verify-promotion-index.mjs](../scripts/verify-promotion-index.mjs) checks that no eligible promotion is excluded for every tier × category combination. It runs in CI. SKU restrictions need no third probe for reachability: those promotions are reachable through the other two dimensions.

Selectivity depends on the corpus. Most promotions target a tier, category, or SKU; a few are storewide. If most were unrestricted, the sentinel would match most rows and provide little benefit. Performance at benchmark scale remains unmeasured; see [open work](plan.md#open).

## Schema choices

| Choice | Reason |
|---|---|
| Embedded cart lines | One read yields the cart; per-line reads form the next wave. A normalized implementation may split them but must document the mapping (`DATA-001`). |
| Inventory key `sku:locationId` | Allows bounded direct reads for availability. |
| `@export` on the eight entities | Provides the admin and seeding surface. This is a qualitative implementation advantage, not a measured P0 endpoint. |
| `ProductView` derived cache | Stores the resolved aggregate under product × tier × region. Deleting it changes latency, not response content (`CACHE-001`). |

`ProductView` uses a `sourcedFrom` resolver, explicit invalidation on writes, and an expiration backstop. It is internal and not exported; requests use the product endpoint so cache status can be reported. See the [schema](../schemas/store.graphql) and [product handler](../resources/product.js) for fields and cache configuration.

## Open

- **Pricing review:** the normative [promotion order](../SPEC.md#promotion-evaluation-order) still needs review by someone with pricing-engine experience.
- **Index selectivity:** the recorded `dev` check narrowed candidates to 7.2% of the table. A tier-only probe is limited by four tiers plus storewide offers. A composite `(tierKey, categoryKey)` index or combined key might narrow further; measure at `bench` scale before choosing one.
