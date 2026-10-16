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
| Indexes only where queried | `Variant.productId` and the promotion eligibility keys. Every other read is by primary key or a scan of a small lookup table; an unqueried index costs every load, write, and byte of storage. |
| `@export` on the eight entities | Provides the admin and seeding surface. This is a qualitative implementation advantage, not a measured P0 endpoint. |
| `ProductView` derived cache | Stores the resolved aggregate under product × tier × region. Deleting it changes latency, not response content (`CACHE-001`). |

`ProductView` uses a `sourcedFrom` resolver, explicit invalidation on writes, and an expiration backstop. It is internal and not exported; requests use the product endpoint so cache status can be reported. See the [schema](../schemas/store.graphql) and [product handler](../resources/product.js) for fields and cache configuration.

Two rules keep it coherent under concurrency:

- **Invalidate after the write commits.** Harper orders writes to a key by transaction start time. An invalidation staged in the write's own transaction carries that start time, so a fill that read the old row before the commit could outrank it and cache the old value until expiry. The admin surface commits, then invalidates in the next transaction; [verify-coherence.mjs](../scripts/verify-coherence.mjs) checks it with readers racing writers.
- **Read through the fill's own context.** Harper 5.3.2 runs queued fills from a chain that carries the first fill's async context, so a resolver's ambient table reads joined another fill's transaction and older snapshot: 16,226 of 16,310 fills in one test ran under a context not their own. The resolver passes its `sourceContext` to every read.
- **Evict in a transaction of its own, with retries.** The write has committed by then; a client disconnect or a commit conflict with a concurrent fill must not cancel the eviction.
- **Key only on values the write surface invalidates.** A tier outside the normative table resolves as `standard` before the key is built, and an unknown region is a 400; otherwise any query string could mint a view no write would ever evict.
- **Cache status is Harper's `loadedFromSource`.** `miss` means this request ran the fill. A request that waited on another request's in-flight fill of the same key reports `hit`.

Freshness within `FRESH_MS` holds for writes through the application's write surface. A view also depends on the product row, related products, locations, and which variants exist; P0 writes none of them, and a direct write to one over REST or the operations API converges only on the 120 s expiry, as [Background writes](../SPEC.md#background-writes) describes for direct datastore writes.

Per-worker memos of the location and rate tables expire after 500 ms, half of `FRESH_MS` ([lookup.js](../resources/lib/lookup.js)). Since spec `0.3.0-draft`, `CACHE-002` does not require that: neither table has a write surface ([Caching](../SPEC.md#caching)). The bound stays so that a write over REST still reaches quotes within the budget.

## Open

- **Pricing review:** the normative [promotion order](../SPEC.md#promotion-evaluation-order) still needs review by someone with pricing-engine experience.
- **SKU-aware lookup:** since dataset `0.6.0`, most `bench` promotions are restricted to one product's SKUs. Each carries its product's category, so the tier × category probe still returns every eligible promotion. It returns about 909 rows per `bench` quote against a [candidate set](../SPEC.md#promotions-are-read-per-quote) of about 10, and skips the candidates a tier excludes. The lookup should probe the cart's SKUs instead of their categories for these rows.
- **Index selectivity:** the recorded `dev` check narrowed candidates to 7.2% of the table. A tier-only probe is limited by four tiers plus storewide offers. A composite `(tierKey, categoryKey)` index or combined key might narrow further; measure at `bench` scale before choosing one.
