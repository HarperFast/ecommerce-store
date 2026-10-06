# Ecommerce Store — Application Specification

**Spec version:** `0.2.0-draft` · **Status:** P0 draft · **Last updated:** 2026-10-06

Scope, methodology, and the rules governing how results may be described are defined by [Harper Application Architecture Benchmarks](https://github.com/HarperFast/application-architecture-benchmarks). That document is binding. This one defines only the application.

---

## 1. What this document is

The reference specification for the application under benchmark. It exists to be implemented more than once — on Harper, and on assembled stacks — so the implementations can be compared.

> ### The rule
>
> **This specification is functional and stack-neutral. Implementations are maximally native to their stack.**

Requirements are stated as endpoints, behaviors, and data contracts. None prescribe a mechanism. "The quote resolves eligible promotions by tier, SKU, and category" is a requirement; "uses a secondary index on `promotion.tier`" is one stack's answer to it.

Where implementations diverge in *how* they satisfy a requirement, that divergence is the finding, and it is recorded rather than smoothed away.

**This is not a description of the Harper implementation.** If a requirement here could not be satisfied by Fastify + Postgres + Redis, it is mis-specified; file it as a defect.

### Scope

P0 is two endpoints, one background writer, eight tables, and one dataset. Deliberately small. An architectural difference only appears where the architecture does work, and a specification large enough to cover a storefront is a specification nobody finishes implementing on four stacks.

Storefront UI, auth, product listing, search, checkout commit, images, and realtime are **future work**. The reasoning behind each, and the decisions already taken on them, are preserved in [`docs/future-work.md`](docs/future-work.md) so they are not rediscovered from scratch.

## 2. How to read this document

Every requirement has a permanent id, `AREA-NNN`. Withdrawn requirements are struck through and their ids retired, never reused — conformance reports reference them forever.

- **MUST** — required for conformance. A failing MUST disqualifies the implementation from comparison.
- **SHOULD** — expected; a deviation is recorded with a reason.
- **MAY** — permitted, never required, never measured.

Areas: `DATA` dataset and schema · `QUOTE` cart quote · `PDP` product aggregate · `WRITE` background writes · `OBS` observability.

---

## 3. Data model

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

Reaching eight tables required three judgment calls. Each is recorded because each one removes a read from the fan-out, and fan-out depth is the thing being measured.

1. **Review rollup is a field on `product`**, not its own table. Costs one read from the PDP aggregate. A real system maintains this asynchronously, so a separate table would be more faithful — but the PDP already fans out to variants, inventory and related products, and the rollup adds breadth rather than depth.
2. **Related items are product ids on `product`**, which still fan out to further `product` reads. Depth preserved.
3. **Shipping and tax share one `rate` table**, discriminated by kind. They are looked up identically — a keyed read returning a rate — and splitting them would buy a table, not a behaviour.

`DATA-001` **MUST** — An implementation uses exactly these eight logical entities **as its source of truth**. A stack MAY represent them differently where its idiom demands (a normalized schema may split embedded line items into their own relation), and MUST then document the mapping. What it MUST NOT do is pre-join or denormalize its *source of truth* into a shape that removes a read the specification requires — that is the measurement, not an optimization.

**Derived caches are permitted and expected**, and are not a violation of the above: a cache holds a copy, not the truth. The distinction is testable — deleting every cache must change no response, only its latency. A separated stack caching the product aggregate in Redis and a collapsed stack caching it in-process are doing the same thing; what differs is the cost of keeping it coherent, which is what §6 exists to measure.

### Caching

- `CACHE-001` **MUST** — Caches are **derived**. Dropping every cache changes no response body, only latency. No cached value is authoritative, and nothing is served from a cache that could not be recomputed from the eight entities.
- `CACHE-002` **MUST** — Every cached value is bounded by `FRESH_MS` (§6) — by explicit invalidation on write, by expiry, or both. An implementation states which mechanism it relies on.
- `CACHE-003` **MUST** — A cache key includes every dimension the cached value varies by. Serving a value keyed on fewer dimensions than it varies by is a correctness failure, not a cache tuning choice.

### Invariants

- `DATA-002` **MUST** — Money is integer minor units (cents) end to end. No implementation may introduce a binary floating-point representation of money.
- `DATA-003` **MUST** — Every implementation loads **the same versioned dataset**, verified by checksum before a run.
- `DATA-004` **MUST** — There is one dataset size, sized so the working set does not fit in memory on the benchmark hardware. A dataset that fits entirely in cache measures something other than the architecture.
- `DATA-005` **MUST** — The dataset is generated deterministically and kept under version control. A comparison run against differing data is void.

---

## 4. `POST /cart/:id/quote`

The write-shaped read path, and the primary endpoint under test. Prices a cart.

**Resolution waves.** Roughly four to five dependent waves and 60–150 record reads, depending on cart size:

1. Read the cart.
2. Per line: product and variant.
3. Per line: inventory across fulfillment locations; and the customer's tier and loyalty balance.
4. Eligible promotions by tier, SKU, and category — evaluation of which triggers further reads.
5. Shipping rate by region and total weight; tax by jurisdiction.

- `QUOTE-001` **MUST** — Every response is unique to its cart. No implementation may serve a stored response for the endpoint. Entity caches are expected and do their normal job; **response-level caching is a conformance failure**, not an optimisation.
- `QUOTE-002` **MUST** — Each line resolves its product and variant. A line naming an unknown sku fails the quote with `400`; it is not silently dropped.
- `QUOTE-003` **MUST** — Availability per line is resolved against inventory across fulfillment locations, honouring location priority.
- `QUOTE-004` **MUST** — The customer's tier is **applied** to pricing, and their loyalty balance is **read and carried** in the response.

  Carried, not applied, deliberately. Redeeming a balance is arithmetic on a field the quote already fetches in wave 2: no extra read, no extra wave, no cache pressure. It would impose a normative redemption rule — conversion, cap, position in the promotion order, treatment of the tax base — that every implementation must reproduce exactly, in exchange for distinguishing no architecture. Redemption becomes interesting at **checkout**, where it decrements a balance under concurrency: a contended per-customer write. It is recorded as future work there rather than as busywork here.
- `QUOTE-005` **MUST** — Promotions are resolved by tier, SKU, and category — **including promotions unrestricted on any of those dimensions** — and evaluated in application code: **stacking, exclusivity, threshold, and BOGO** rules. Evaluation order is specified (below) so every implementation produces identical totals.
- `QUOTE-006` **MUST** — Shipping is resolved by region and total cart weight.
- `QUOTE-007` **MUST** — Tax is resolved by the customer's jurisdiction and applied to the post-discount subtotal.
- `QUOTE-008` **MUST** — The quote is **deterministic**: the same cart against the same dataset state produces a byte-identical response. This is what makes the endpoint verifiable at all, and it is the ground-truth correctness guard the measurement rules require.
- `QUOTE-009` **MUST** — An unknown cart id returns `404`.
- `QUOTE-010` **MUST** — The response itemizes per line: resolved unit price, quantity, applied promotions, and line total; and at cart level: subtotal, discount total, shipping, tax, and grand total.

### Promotion evaluation order

Normative, because promotion stacking is order-dependent and an unspecified order makes two correct implementations disagree on the total — which the measurement rules classify as non-equivalent semantics, an invalid cell rather than a close one.

> **Each cart-wide promotion (`exclusive`, `threshold`) and each `bogo` promotion applies at most once per cart. Each `stackable` promotion applies at most once per eligible line.** This is the rule that decides most of the rest; an earlier draft left it implicit and a cart-wide 34%-off promotion eligible for three lines priced the cart to zero, as a well-formed deterministic 200.

> **All discounts draw on one budget: the line's remaining amount.** Cart-wide discounts are allocated across the lines they are eligible for, in proportion to what each still has left, by largest remainder with ties on ascending SKU. Separate cart-wide and per-line accumulators let both discount the same money, which the 60% cap then concealed.

> **Cart lines are merged by SKU before evaluation.** Nothing requires a cart's lines to be distinct, and per-SKU state with repeated SKUs produced a negative discount — a quote charging above its own subtotal — for a cart with no promotions.

Promotions are either **cart-wide** (`exclusive`, `threshold`) or **per-line** (`bogo`, `stackable`). The two draw on separate budgets: cart-wide discounts accumulate against the subtotal, per-line discounts draw down that line's remaining amount. Neither may take a line or the cart below zero.

1. Candidate promotions are collected by tier, SKU, and category. **A promotion unrestricted on a dimension (an empty array) is eligible on that dimension**, so a promotion unrestricted on every dimension is eligible for every line — collection must return it.
2. **Exclusive** — cart-wide, evaluated against the subtotal. The highest-value one wins; if one applies, **no other promotion applies at all**. Attributed to every line it was eligible for.
3. Otherwise **threshold** — cart-wide, each eligible promotion applied **once**, against the **pre-discount** subtotal, if the subtotal meets its threshold. Attributed to every line it was eligible for.
4. Then **BOGO** — each eligible promotion applied **once**, to the single lowest-priced qualifying unit among the lines it is eligible for, where a qualifying line has quantity ≥ 2 and a non-zero remaining amount. Ties break on ascending SKU, so the result does not depend on cart line order.
5. Then **stackable** — each eligible promotion applied **once per eligible line**, against that line's **remaining** amount, so successive percentage discounts compound rather than all computing against the gross line total.
6. Ties at any step break on ascending promotion id.
7. **At most three stackable promotions apply to any one line**, in ascending promotion id.
8. **`discountTotal` never exceeds 60% of the subtotal.** The cap is applied last, so it bounds every path including a single large exclusive.

Steps 7 and 8 are normative bounds, not tuning: real stores limit stacking, and without a bound a promotion corpus with enough unrestricted stackables compounds a cart to zero.

Rounding: each discount rounds half-up to the minor unit at the point it is applied, not at the end.

- `QUOTE-011` **MUST** — Each cart-wide and BOGO promotion applies at most once per cart; each stackable applies at most once per eligible line, at most three per line. `discountTotal` is never negative and never exceeds 60% of the subtotal, **floored** — a bound that rounds up can exceed itself.
- `QUOTE-012` **MUST** — `appliedPromotionIds` lists exactly the promotions that produced a discount for that line. A cart-wide promotion appears on every line it was eligible for.

---

## 5. `GET /product/:id?tier=&region=`

The read-heavy leg. Mostly cacheable, but varies by `tier` and `region`.

- `PDP-001` **MUST** — The response aggregates: the product, its variants, inventory for those variants, resolved price, review rollup, and related items.
- `PDP-002` **MUST** — Resolved price varies by `tier`; availability varies by `region`. Two requests differing only in `tier` or only in `region` MUST be able to produce different responses, and an implementation that caches MUST include both in its cache key. Serving one tier's price to another is a conformance failure.
- `PDP-003` **MUST** — Inventory and price reflect background writes (§6) within `FRESH_MS`.
- `PDP-004` **MUST** — An unknown product id returns `404`.
- `PDP-005` **SHOULD** — Related items are returned with enough detail to render without a further request.

---

## 6. Background writes

A steady, low-rate stream of inventory and price updates against the same records the read path touches.

**Not an endpoint under test.** Its own latency is not a headline metric. It exists so that caches have to stay coherent with their source of truth — a read-only workload lets a separated stack's cache fill once and never invalidate, which is not a cache any real store operates.

- `WRITE-001` **MUST** — The writer updates `inventory` quantities and `variant` prices against records within the read path's working set, at a configured steady rate, **through the application's write surface**. A write made directly to the datastore updates the source of truth while invalidating nothing, so the cache converges only on expiry and the coherence cost this section exists to measure is never paid. A separated stack's write path has to evict its cache key for the same reason; this is the same work on the other architecture.
- `WRITE-002` **MUST** — A committed write is observable on the product aggregate (§5) within `FRESH_MS`, and in quote pricing (§4) within `FRESH_MS`.
- `WRITE-003` **MUST** — No implementation may satisfy `WRITE-002` by disabling caching. Measured cache-hit rates are recorded with every run precisely so that this is visible.
- `WRITE-004` **MUST** — The write stream is identical in rate and key distribution for every target. It is not a per-target tuning budget.

### `FRESH_MS`

The coherence budget: how stale a read may be after a write commits. It is a property of the benchmark rather than of any stack, so it is set once, applied to every target, and recorded with the results.

**Provisionally 1000 ms**, pending the first comparison. The figure is now meaningful rather than arbitrary because there is a mechanism behind it: a write invalidates synchronously before it returns, so a read issued after a completed write is already fresh on a single node. The budget exists for the window that concurrency and replication open, not for the happy path. An implementation that meets it only by expiry rather than invalidation must say so (`CACHE-002`).

Setting it too tight makes the benchmark a cache-invalidation test; too loose and a stack can serve arbitrarily stale data for free.

---

## 7. Observability

- `OBS-001` **MUST** — Both endpoints emit `Server-Timing` decomposing server-side time into at least data access, application compute, and total.
- `OBS-002` **MUST** — Responses indicate cache status, and each implementation documents its caching mechanism. The measurement rules require measured cache-hit rates to be recorded with every run; this is how.
- `OBS-003` **MUST** — Instrumentation exists from the first commit of a surface. Numbers that cannot be decomposed cannot be audited.

---

## 8. Conformance

An implementation publishes a conformance report: every requirement id, and pass / fail / deviation-with-reason.

The shared verification suite is the executable form of this document. Each test names the requirement ids it covers, and every MUST is covered by at least one test — enforced by `npm run check`, not asserted.

Passing conformance is **necessary but not sufficient**. An implementation must also use its stack well; that is a review judgment, and the benchmarks repo defines how it is made.

This document is versioned and snapshotted with each comparison. A published comparison names the exact spec version it ran against.

### Review gate

P0 does not complete until this document passes: self-review → cross-model review → at least one human reviewer.

| Gate | Status |
|---|---|
| Self-review | ☐ |
| Cross-model review | ☑ 2026-10-01 — two rounds, Claude + codex (agy timed out both rounds) |
| Human review | ☐ |

**Known open:** `FRESH_MS` (§6), the eight-table foldings (§3), and the promotion evaluation order (§4) — the last because it is invented here rather than derived from a real system, and it determines whether two correct implementations agree on a total.
