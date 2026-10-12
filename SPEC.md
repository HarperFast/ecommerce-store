# Ecommerce Store — Application Specification

**Spec version:** `0.2.0-draft` · **Status:** P0 draft · **Last updated:** 2026-10-09 (editorial; requirements unchanged)

Scope, methodology, and the rules governing how results may be described are defined by [Harper Application Architecture Benchmarks](https://github.com/HarperFast/application-architecture-benchmarks). That document is binding. This one defines only the application.

---

## What this document is

This specification defines the application implemented on Harper and assembled stacks for comparison.

**Requirements are functional and stack-neutral; implementations use their stack's native mechanisms.** For example, promotion eligibility is a requirement; a particular secondary index is an implementation choice. Record differences in implementation rather than forcing a shared design.

If a requirement cannot be satisfied by Fastify + Postgres + Redis, report it as a specification defect.

### Scope

P0 covers two endpoints, one background writer, eight tables, and one benchmark dataset. The workload exercises dependent reads and pricing without requiring a complete storefront.

Storefront UI, auth, listing, search, checkout commit, images, and realtime are deferred. [Future work](docs/future-work.md) records their scope and decisions.

## How to read this document

Every requirement has a permanent id, `AREA-NNN`. Withdrawn requirements are struck through and their ids retired, never reused — conformance reports reference them forever.

- **MUST** — required for conformance. A failing MUST disqualifies the implementation from comparison.
- **SHOULD** — expected; a deviation is recorded with a reason.
- **MAY** — permitted, never required, never measured.

Areas: `DATA` dataset and schema · `CACHE` caching · `QUOTE` cart quote · `PDP` product aggregate · `WRITE` background writes · `OBS` observability.

---

## Data model

Eight tables. Field names are normative for the API; storage representation is not specified.

| Table | Key | Carries |
|---|---|---|
| `cart` | `id` | customer id, line items (sku, quantity) embedded |
| `customer` | `id` | tier, loyalty balance, region, tax jurisdiction |
| `product` | `id` | title, category ids, weight, related product ids, review rollup |
| `variant` | `sku` | product id, options, base price, weight |
| `inventory` | (`sku`, `locationId`) | on-hand quantity |
| `location` | `id` | fulfillment location: region, priority |
| `promotion` | `id` | eligibility by tier / sku / category, stacking and exclusivity rules, thresholds, BOGO terms |
| `rate` | `id` | shipping rates by region and weight band; tax rates by jurisdiction, discriminated by kind |

### Foldings, and what they cost

Three choices keep the model to eight tables:

1. **Review rollup on `product`:** removes a separate PDP read. Real systems maintain it asynchronously, but that read would add breadth rather than dependency depth.
2. **Related product ids on `product`:** still require further product reads, preserving depth.
3. **Shipping and tax in `rate`:** distinguished by kind; separate tables would add no new behavior.

`DATA-001` **MUST** — An implementation uses exactly these eight logical entities **as its source of truth**. A stack MAY represent them differently where its idiom demands (a normalized schema may split embedded line items into their own relation), and MUST then document the mapping. What it MUST NOT do is pre-join or denormalize its *source of truth* into a shape that removes a read the specification requires — that is the measurement, not an optimization.

**Derived caches are permitted and expected.** Deleting them changes latency, not responses. Their coherence cost is measured through [background writes](#background-writes).

### Caching

- `CACHE-001` **MUST** — Caches are **derived**. Dropping every cache changes no response body, only latency. No cached value is authoritative, and nothing is served from a cache that could not be recomputed from the eight entities.
- `CACHE-002` **MUST** — Every cached value is bounded by `FRESH_MS` (Background writes) — by explicit invalidation on write, by expiry, or both. An implementation states which mechanism it relies on.
- `CACHE-003` **MUST** — A cache key includes every dimension the cached value varies by. Serving a value keyed on fewer dimensions than it varies by is a correctness failure, not a cache tuning choice.

### Rate table invariants

Implementations may rely on these dataset invariants:

- **Shipping bands within a region are contiguous and non-overlapping.** `weightMin` and `weightMax` are inclusive. Bands cover every non-negative weight, with an effectively open-ended top band, so exactly one matches any cart. No fallback is specified; zero or multiple matches indicate invalid data and should fail loudly.
- **Exactly one tax rate per jurisdiction.**

### Invariants

- `DATA-002` **MUST** — Money is integer minor units (cents) end to end. No implementation may introduce a binary floating-point representation of money.
- `DATA-003` **MUST** — Every implementation loads **the same versioned dataset**, verified by checksum before a run.
- `DATA-004` **MUST** — There is one dataset size, sized so the working set does not fit in memory on the benchmark hardware. A dataset that fits entirely in cache measures something other than the architecture.
- `DATA-005` **MUST** — The dataset is generated deterministically and kept under version control. A comparison run against differing data is void.

---

## `POST /cart/:id/quote`

The write-shaped read path, and the primary endpoint under test. Prices a cart.

**Resolution waves.** Roughly four to five dependent waves and 60–150 record reads, depending on cart size:

1. Read the cart.
2. Per line: product and variant.
3. Per line: inventory across fulfillment locations; and the customer's tier and loyalty balance.
4. Eligible promotions by tier, SKU, and category — evaluation of which triggers further reads.
5. Shipping rate by region and total weight; tax by jurisdiction.

- `QUOTE-001` **MUST** — Every response is unique to its cart. No implementation may serve a stored response for the endpoint. Entity caches are expected and do their normal job; **response-level caching is a conformance failure**, not an optimisation.
- `QUOTE-002` **MUST** — Each line resolves its product and variant. A line naming an unknown sku fails the quote with `400`; it is not silently dropped.
- `QUOTE-003` **MUST** — Availability per line is resolved against inventory across fulfillment locations in ascending `location.priority`, drawing from each in turn until the line's quantity is satisfied or the region's locations are exhausted.

  **Price the full requested quantity** and report the unmet amount as `shortfall`. Inventory changes affect fulfillment, not the quantity being priced.

- `QUOTE-004` **MUST** — The customer's tier is **applied** to pricing, by the normative table in *Resolved unit price* below, and their loyalty balance is **read and carried** in the response.

  Quote-time redemption adds arithmetic but no reads or cache pressure. Redemption is deferred to [checkout](docs/future-work.md#loyalty-redemption), where it introduces a concurrent balance update.

- `QUOTE-005` **MUST** — Promotions are resolved by tier, SKU, and category — **including promotions unrestricted on any of those dimensions** — and evaluated in application code: **stacking, exclusivity, threshold, and BOGO** rules. Evaluation order is specified (below) so every implementation produces identical totals.
- `QUOTE-006` **MUST** — Shipping is resolved by the customer's region and the cart's total weight, where total weight is `Σ (variant.weight × quantity)` over the merged lines, against the band contract in Data model. Shipping is **not** discounted and **not** taxed.
- `QUOTE-007` **MUST** — Tax is resolved by the customer's jurisdiction and applied to the post-discount subtotal.
- `QUOTE-008` **MUST** — The quote is **deterministic**: the same cart against the same dataset state produces a byte-identical response. Determinism enables verification but does not prove correctness; the harness also needs independently computed expected values.
- `QUOTE-009` **MUST** — An unknown cart id returns `404`.
- `QUOTE-010` **MUST** — The response itemizes per line: resolved unit price, quantity, applied promotions, line total, and `shortfall` (zero when the line is fully available); and at cart level: subtotal, discount total, shipping, tax, and grand total. `grandTotal` equals `subtotal - discountTotal + shipping + tax`.

### Resolved unit price

Before promotions, adjust `variant.basePrice` by the customer's tier using this normative table:

| Tier | Basis points | Effect |
|---|---|---|
| `standard` | 10000 | base price unchanged |
| `silver` | 9500 | 5% off |
| `gold` | 9000 | 10% off |
| `platinum` | 8500 | 15% off |

`resolvedUnitPrice = round_half_up(basePrice × tierBasisPoints / 10000)`, in integer minor units. A tier absent from this table resolves as `standard`.

The product aggregate resolves its price the same way, so a given variant at a given tier prices identically on both endpoints.

### Promotion evaluation order

This order is normative because stacking is order-dependent.

- **Merge cart lines by SKU before evaluation.** Duplicate entries become one line with their combined quantity.
- **Apply each cart-wide (`exclusive`, `threshold`) and BOGO promotion at most once per cart.** Each stackable applies at most once per eligible line.
- **All discounts consume the same per-line remaining amounts.** Allocate cart-wide discounts across eligible lines in proportion to their remaining amounts, using largest remainder with ties on ascending SKU. No discount may take a line or the cart below zero.

`exclusive` and `threshold` are cart-wide; `bogo` and `stackable` act on lines. Evaluate as follows:

1. Candidate promotions are collected by tier, SKU, and category. **A promotion unrestricted on a dimension (an empty array) is eligible on that dimension**, so a promotion unrestricted on every dimension is eligible for every line — collection must return it.
2. **Exclusive** — cart-wide, evaluated against the subtotal. The highest-value one wins; if one applies, **no other promotion applies at all**. Attributed to every line it was eligible for.
3. Otherwise **threshold** — cart-wide, each eligible promotion applied **once**, against the **pre-discount** subtotal, if the subtotal meets its threshold. Attributed to every line it was eligible for.
4. Then **BOGO** — each eligible promotion applied **once**, to the single lowest-priced qualifying unit among the lines it is eligible for, where a qualifying line has quantity ≥ 2 and a non-zero remaining amount. Ties break on ascending SKU, so the result does not depend on cart line order.

   Apply the promotion's `amountBasisPoints` to that unit price, or its `amountMinor` to that one unit, using the same amount rule as other kinds. Read the amount from the promotion; the dataset's BOGO rows use 10000 basis points for a free unit.

5. Then **stackable** — each eligible promotion applied **once per eligible line**, against that line's **remaining** amount, so successive percentage discounts compound rather than all computing against the gross line total.
6. **A promotion carrying a non-zero `thresholdMinor` requires that minimum pre-discount subtotal, whatever its kind.**
7. Ties at any step break on ascending promotion id.
8. **At most three stackable promotions apply to any one line**, in ascending promotion id.
9. **`discountTotal` never exceeds 60% of the subtotal**, floored. The cap is a **running** bound, not a final truncation: each discount is applied against the headroom remaining at the moment it is applied, and one that would cross the cap is applied **partially**, up to that headroom. A promotion reduced to nothing by an exhausted cap is not attributed to any line.

   Final truncation could leave promotion attribution and per-line totals inconsistent with the cart total (`QUOTE-012`).

The stacking limit and discount cap are normative bounds.

Rounding: each discount rounds half-up to the minor unit at the point it is applied, not at the end.

- `QUOTE-011` **MUST** — Each cart-wide and BOGO promotion applies at most once per cart; each stackable applies at most once per eligible line, at most three per line. `discountTotal` is never negative and never exceeds 60% of the subtotal, **floored** — a bound that rounds up can exceed itself.
- `QUOTE-012` **MUST** — `appliedPromotionIds` lists exactly the promotions that produced a discount for that line. A cart-wide promotion appears on every line it was eligible for.

---

## `GET /product/:id?tier=&region=`

The read-heavy leg. Mostly cacheable, but varies by `tier` and `region`.

- `PDP-001` **MUST** — The response aggregates: the product, its variants, inventory for those variants, resolved price, review rollup, and related items.
- `PDP-002` **MUST** — Resolved price varies by `tier`; availability varies by `region`. Two requests differing only in `tier` or only in `region` MUST be able to produce different responses, and an implementation that caches MUST include both in its cache key. Serving one tier's price to another is a conformance failure.
- `PDP-003` **MUST** — Inventory and price reflect background writes (Background writes) within `FRESH_MS`.
- `PDP-004` **MUST** — An unknown product id returns `404`.
- `PDP-005` **SHOULD** — Related items are returned with enough detail to render without a further request.

---

## Background writes

A steady, low-rate stream of inventory and price updates against the same records the read path touches.

The stream exercises cache coherence; its latency is not a headline metric. A read-only workload would let caches fill without paying invalidation costs.

- `WRITE-001` **MUST** — The writer updates `inventory` quantities and `variant` prices against records within the read path's working set, at a configured steady rate, **through the application's write surface**. A write made directly to the datastore updates the source of truth while invalidating nothing, so the cache converges only on expiry and the coherence cost this section exists to measure is never paid. A separated stack's write path has to evict its cache key for the same reason; this is the same work on the other architecture.
- `WRITE-002` **MUST** — A committed write is observable on the product aggregate (GET /product/:id) within `FRESH_MS`, and in quote pricing (POST /cart/:id/quote) within `FRESH_MS`.
- `WRITE-003` **MUST** — No implementation may satisfy `WRITE-002` by disabling caching. Measured cache-hit rates are recorded with every run precisely so that this is visible.
- `WRITE-004` **MUST** — The write stream is identical in rate and key distribution for every target. It is not a per-target tuning budget.

### `FRESH_MS`

The maximum staleness after a write commits, set once for all targets and recorded with results.

**Provisionally 1000 ms**, pending the first comparison. Synchronous invalidation can make reads after a completed write fresh on one node; the budget allows for concurrency and replication. Implementations relying on expiry must declare it (`CACHE-002`).

Too tight a budget makes the workload primarily an invalidation test; too loose a budget permits unrepresentative staleness.

---

## Observability

- `OBS-001` **MUST** — Both endpoints emit `Server-Timing` decomposing server-side time into at least data access, application compute, and total.
- `OBS-002` **MUST** — Responses indicate cache status, and each implementation documents its caching mechanism. The measurement rules require measured cache-hit rates to be recorded with every run; this is how.
- `OBS-003` **MUST** — Instrumentation exists from the first commit of a surface. Numbers that cannot be decomposed cannot be audited.

---

## Conformance

An implementation publishes a conformance report: every requirement id, and pass / fail / deviation-with-reason.

The shared verification suite implements this document. Each test names the requirement ids it covers. `npm run check` enforces declared coverage for every MUST; it does not guarantee execution of every check. Known execution and assertion gaps are tracked in [the plan](docs/plan.md#open).

Passing conformance is **necessary but not sufficient**. An implementation must also use its stack well; that is a review judgment, and the benchmarks repo defines how it is made.

This document is versioned and snapshotted with each comparison. A published comparison names the exact spec version it ran against.

### Review gate

P0 does not complete until this document passes: self-review → cross-model review → at least one human reviewer.

| Gate | Status |
|---|---|
| Self-review | ☐ |
| Cross-model review | ☑ 2026-10-01 — two rounds, Claude + codex (agy timed out both rounds) |
| Human review | ☐ |

**Known open:** the provisional `FRESH_MS` budget, the eight-table foldings, and review of the invented promotion order by someone with pricing-engine experience.
