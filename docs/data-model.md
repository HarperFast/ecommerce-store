# Variant data model

Status: **P0 design; two choices gated on P1 measurement.** Implements SPEC.md §4 on Harper.

SPEC.md defines the model neutrally. This document is the Harper-side design, and it exists
because one requirement — `CAT-003`, *aggregates are consistent with current variants at
response time* — is the hardest thing in the specification and the place where a collapsed
stack and a separated stack diverge most sharply.

## The shape of the problem

A listing response returns `ProductSummary`, which carries four values that do not exist on
any single stored record:

| Aggregate | Over |
|---|---|
| `priceMin` / `priceMax` | every variant of the product |
| `inStock` | true iff **any** variant has `stock > 0` |
| `swatches` | distinct `color` values across variants, in declared order |
| `variantCount` | every variant |

At the `lg` tier that is 50,000 products over 100,000+ variants, and **facet counts must be
computed over the entire filtered set, not the returned page** (`PLP-003`). A 24-item page
can require touching every matching SKU.

Meanwhile `stock` changes constantly and must never be served stale (`PDP-002`, `ADM-002`),
so the aggregates cannot simply be frozen at seed time.

That is the whole difficulty in one sentence: **a value derived from many rows, consulted on
every listing request, invalidated by a high-frequency write.**

## Entities

Four tables. Products and variants are separate records rather than one embedded document.

```graphql
type Category @table @export {
  id: ID @primaryKey
  slug: String @indexed
  name: String
  parentId: String @indexed
  path: [String]
  depth: Int
}

type Product @table @export {
  id: ID @primaryKey
  slug: String @indexed
  title: String
  description: String
  brand: String @indexed
  categoryIds: [String] @indexed
  optionAxes: Any
  attributes: Any
  createdAt: Int @indexed
  # --- maintained aggregates, see below ---
  priceMin: Int @indexed
  priceMax: Int @indexed
  inStock: Boolean @indexed
  swatches: [String]
  variantCount: Int
}

type Variant @table @export {
  sku: ID @primaryKey
  productId: String @indexed
  options: Any
  price: Int
  currency: String
  stock: Int
  imageSeed: String
}
```

### Why not one embedded document

Embedding variants inside the product record makes aggregates free — they are computed once
when the document is written — and makes the detail page a single primary-key read.

It is still the wrong choice here, for three reasons:

1. **Write amplification on the measured path.** A single SKU stock change would rewrite a
   document containing every sibling variant. `ADM-001`–`ADM-005` are the measured write
   path; making each write proportional to a product's variant count optimises the thing we
   are trying to measure into something unrepresentative.
2. **Write contention.** Two SKUs of the same product going out of stock concurrently would
   contend on one record.
3. **It would flatter Harper dishonestly.** A Postgres implementation would not embed, so
   embedding would compare a denormalised document store against a normalised relational
   schema and attribute the difference to the platform. `SPEC.md`'s whole premise is that
   the delta must be attributable.

The detail page therefore costs one product read plus a `productId`-indexed variant scan,
which is the same shape of work every implementation does.

## Decision 1 — aggregates are maintained on write

The two candidates:

| | Computed on read | **Maintained on write** |
|---|---|---|
| Listing cost | scan every matching variant per request | indexed read of `Product` |
| Write cost | none | recompute one product's aggregates per SKU write |
| Staleness risk | none by construction | requires the write path to be correct |
| `PLP-007` (`sort=price_asc`) | sort key does not exist until computed | `priceMin` is an indexed field |

**Decision: maintained on write.** `PLP-007` is close to decisive on its own — sorting
50,000 products by a value that has to be computed from 100,000+ variants first is not a
query any implementation would ship. The same argument applies to filtering on `inStock`
(`PLP-006`) and to facet counts (`PLP-003`).

The cost lands on the admin write, which is the *measured* write path — and that is
correct, not unfortunate. It is precisely the invalidation-fan-out cost the comparison
exists to expose: one SKU write must update the product's aggregates, then the listing
pages, facet counts, and the detail page derived from them. A separated stack pays this
across three services.

**Invariant to enforce and test:** aggregates are recomputed inside the same transaction as
the variant write, so no reader observes a variant and its product disagreeing. `CAT-003` is
a conformance requirement, so violating it is a failure rather than a slow path.

## Decision 2 — facet counting, gated

`PLP-003` and `PLP-005` together are the expensive requirement: counts over the whole
filtered set, with each facet's counts computed *excluding its own selections*. That means
a request with three active facets needs four differently-filtered count passes.

Three candidate mechanisms, in increasing order of cleverness:

1. **Count from the index on each request.** Simplest and always correct. Cost scales with
   matched-set size, which at the `lg` tier is the concern.
2. **Maintained counter records**, keyed by (category, facet, value), updated on write.
   Fast reads, but `PLP-005`'s exclusion rule means counts depend on the *other* active
   selections — so a static counter per value cannot answer the query directly. Workable
   only for the unfiltered case, i.e. as an optimisation of the common first page.
3. **Bitmap/roaring intersection per facet value**, counted by popcount. The standard answer
   from search engines; the most work to build.

**Not decided in P0.** The right choice depends on measured cost at the `lg` tier, and
choosing before measuring would be guessing with extra steps. What is decided:

- **(1) is the P1 baseline**, because it is obviously correct and makes the e2e suite
  meaningful. Correctness first, then optimisation against a real corpus.
- Whatever replaces it must keep `PLP-005`'s exclusion semantics exactly. This is the rule
  most likely to be quietly broken by an optimisation, so the verification suite covers it
  independently of the happy path.
- Harper's native full-text index is the natural home for (3) if we get there; `SRCH-002`
  already requires faceting over the search-matched set, so search and listing should share
  one faceting path rather than growing two.

## Variant matrix and unavailable combinations

`PDP-003` requires unavailable option combinations to be **marked, not omitted** — a size
that does not exist in a chosen color must render as disabled rather than vanish, which is
what makes the matrix legible.

The product's `optionAxes` is the full declared cross-product; the variant set is the subset
that actually exists. The detail response carries both, and the renderer derives
availability by lookup. Deriving the axes from the variants instead would silently drop an
axis value that happens to be sold out everywhere, changing the rendered UI as stock
changes — a correctness bug that would look like a caching bug.

## Open, carried to P1

- Facet counting mechanism (above), decided by measurement at the `lg` tier.
- Whether `categoryIds` descendant expansion (`PLP-001`) is best served by storing the
  ancestor path on the product or by expanding the category subtree per request.
- Whether `swatches` ordering should follow the declared axis order (current spec) or
  observed variant order — currently declared, because it is stable under stock changes.
