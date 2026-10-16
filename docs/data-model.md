# Data model

**Status:** P0 design. [SPEC.md](../SPEC.md#data-model) defines the logical entities; [schemas/store.graphql](../schemas/store.graphql) defines the Harper schema. This document explains the implementation choices.

## Resolve aggregates on read

The benchmark measures dependent reads. `DATA-001` forbids pre-joining the source of truth to remove that work; derived caches remain allowed.

P0 needs only bounded calculations: tier pricing over `variant.basePrice` and availability across a SKU's regional inventory. Resolving them on read also avoids maintaining a rollup on every inventory write. `reviewRollup` is seeded on `product`; P0 has no review writes.

Revisit this decision when listing pages need catalog-wide sorting or filtering on aggregates. [Future work](future-work.md#product-listing-facets-and-search) records the facet-counting options.

## Promotion eligibility index

An empty eligibility array means unrestricted. Probing the authoritative arrays directly would miss unrestricted promotions; scanning every promotion would be correct but costly at scale.

For campaigns, the promotions open to every SKU, the schema derives `eligibilityKeys` from the authoritative arrays: one key per (tier, category) pair, indexed, with `*` standing for an empty array, which no index can match. The dataset's `tierKeys` and `categoryKeys` carry the same values in indexable form; they are loaded but no longer queried, so the index cannot drift from what `isEligible` reads. A promotion that names SKUs gets none, because the specification makes it a candidate by its SKUs alone; `skus` itself is indexed instead. A quote probes every pair its cart can match (its tier or `*`, crossed with each of its categories or `*`) and each of its SKUs. The union of those equality probes is exactly the candidate set ecommerce-store PR #7 adds to SPEC.md (0.3.0), a **superset** of eligible promotions. `isEligible` then checks the authoritative tier, SKU, and category arrays.

The combined key replaces one indexed `in` probe per dimension, combined with AND. That form returned the same set, but Harper 5.3.2 has no index intersection and answers `in` by walking the attribute's whole index ([harper#3240](https://github.com/HarperFast/harper/issues/3240)), so a gold-tier cart in three categories walked all 5,000 `bench` index entries and read the 1,478 rows of one dimension to keep the 619 both admit. The combined key reads only the rows it returns. It costs one index entry per pair: 5,000 on `bench`, where every promotion has one of each, growing as the product if promotions carry several. The keys are computed rather than loaded, so the pinned dataset is unchanged; changing the expression reindexes the table. A missing or empty array indexes as unrestricted on that dimension, as the specification reads it, and never fails the write. Measurements are in the [plan](plan.md#promotion-candidates-on-bench-2026-10-16).

[scripts/verify-promotion-index.mjs](../scripts/verify-promotion-index.mjs) evaluates the schema's expression on every row and runs the quote's own conditions against the rows as Harper would index them. For every tier × category set × SKU set it checks that the search returns exactly the candidate set and misses nothing eligible, including synthetic rows with missing arrays, key fields that disagree with the arrays, and SKU-scoped rows whose tiers and categories alone would match. It runs in CI, and also fails if the schema and the quote stop agreeing on the key format or a condition names an attribute the schema does not index.

Selectivity depends on the corpus. Most promotions target a tier, category, or SKU; a few are storewide. If most were unrestricted, the sentinel would match most rows and provide little benefit.

## Schema choices

| Choice | Reason |
|---|---|
| Embedded cart lines | One read yields the cart; per-line reads form the next wave. A normalized implementation may split them but must document the mapping (`DATA-001`). |
| Inventory key `sku:locationId` | Allows bounded direct reads for availability. |
| Indexes only where queried | `Variant.productId` and the promotion candidate keys, `eligibilityKeys` and `skus`. Every other read is by primary key or a scan of a small lookup table; an unqueried index costs every load, write, and byte of storage. |
| `@export` on the eight entities | Provides the admin and seeding surface. This is a qualitative implementation advantage, not a measured P0 endpoint. |
| `ProductView` derived cache | Stores the resolved aggregate under product × tier × region. Deleting it changes latency, not response content (`CACHE-001`). |

`ProductView` uses a `sourcedFrom` resolver, explicit invalidation on writes, and an expiration backstop. It is internal and not exported; requests use the product endpoint so cache status can be reported. See the [schema](../schemas/store.graphql) and [product handler](../resources/product.js) for fields and cache configuration.

Two rules keep it coherent under concurrency:

- **Invalidate after the write commits.** Harper orders writes to a key by transaction start time. An invalidation staged in the write's own transaction carries that start time, so a fill that read the old row before the commit could outrank it and cache the old value until expiry. The admin surface commits, then invalidates in the next transaction; [verify-coherence.mjs](../scripts/verify-coherence.mjs) checks it with readers racing writers.
- **Read through the fill's own context.** Harper 5.3.2 runs queued fills from a chain that carries the first fill's async context, so a resolver's ambient table reads joined another fill's transaction and older snapshot: 16,226 of 16,310 fills in one test ran under a context not their own. The resolver passes its `sourceContext` to every read.
- **Evict in a transaction of its own, with retries.** The write is durable once committed; a client disconnect or a commit conflict with a concurrent fill must not cancel the eviction.
- **Key only on values the write surface invalidates.** A tier outside the normative table resolves as `standard` before the key is built, and an unknown region is a 400; otherwise any query string could mint a view no write would ever evict.
- **Cache status is Harper's `loadedFromSource`.** `miss` means this request ran the fill. A request that waited on another request's in-flight fill of the same key reports `hit`.

Freshness within `FRESH_MS` holds for writes through the application's write surface. A view also depends on the product row, related products, locations, and which variants exist; P0 writes none of them, and a direct write to one over REST or the operations API converges only on the 120 s expiry, as [Background writes](../SPEC.md#background-writes) describes for direct datastore writes.

Per-worker memos of the location and rate tables expire after 500 ms, half of `FRESH_MS` ([lookup.js](../resources/lib/lookup.js)), so a write to either reaches quotes within the budget.

## Open

- **Pricing review:** the normative [promotion order](../SPEC.md#promotion-evaluation-order) still needs review by someone with pricing-engine experience.
- **Promotion lookup at tier 2:** the combined key is measured on tier 1 with the `bench` promotions; its effect on the `bench` quote at tier 2 is not yet measured.
