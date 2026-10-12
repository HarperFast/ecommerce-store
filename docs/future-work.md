# Future work

P0 covers two endpoints, background writes, eight entities, and one benchmark dataset. This document records deferred scope and decisions to revisit when it expands. [The plan](plan.md) tracks current work.

## Product listing, facets, and search

Planned scope: category listing with descendant expansion, facet counts over the full filtered set, multi-select facets, sorting, pagination, and full-text search through the same path.

**Facet counting rule:** exclude a facet's own selections when computing its counts, so shoppers can see alternative values. Counts for every other facet include all active selections.

Three mechanisms remain undecided:

| Mechanism | Tradeoff |
|---|---|
| Count from indexes per request | Correct; cost grows with the matched set. |
| Maintain counters per category × facet × value | Handles the unfiltered first page but cannot satisfy the exclusion rule alone. |
| Bitmap intersection and popcount | Supports combined filters; most work to implement. |

Facet counting over 100k+ SKUs may introduce another search service in a separated stack. Measure that architectural cost when listings return.

## Pages and server rendering

Planned scope: server-rendered home, listing, detail, and search pages; facets and pagination represented in URLs; usable without client JavaScript.

The methodology excludes measurements dominated by static delivery, browser rendering, or client-side evaluation. A future UI must respect that boundary.

Next.js, React, and the shared UI package were removed from P0 to avoid deploying an unused framework. Reintroducing one does not change the [repo-root deployment constraint](structure.md#deployment-layout).

## Conformance profiles

A future `DATA` profile could cover the JSON API and an `APP` profile could add pages, sessions, and checkout. Comparisons would require a shared profile.

P0 needs only one profile because every target is a backend stack. Revisit when a storefront or platform comparison introduces targets that cannot implement the full specification; the registry would need a profile field.

## Identity and accounts

Keep operators and shoppers distinct:

| | Operator | Shopper |
|---|---|---|
| Population | Tens | 100,000+ |
| Purpose | Admin writes | Sessions, carts, orders |
| Enforcement | Platform-native users and roles | Application records and sessions |

Native access control provides database-enforced admin access with little handler code. Shopper sessions introduce validation on every request, making their cost a separate comparison axis.

Open questions: customer-service access scoped to a shopper; database versus application enforcement for shoppers; and the cost of native sessions, application sessions, and stateless JWTs with weaker revocation.

### Password hashing

[scripts/measure-kdf.mjs](../scripts/measure-kdf.mjs) preserves an exploratory workstation measurement. Concurrent scrypt calls each reserve memory, so memory per hash can limit a small node before serial latency does.

| Parameters | Memory/hash | Node default `maxmem` | Serial time | Hash buffers fitting in 512 MiB |
|---|---|---|---|---|
| N=2¹⁷ r=8 p=1 | 128 MiB | Throws | 234 ms | 4 |
| N=2¹⁶ r=8 p=2 | 64 MiB | Throws | 213 ms | 8 |
| N=2¹⁵ r=8 p=3 | 32 MiB | Throws | 160 ms | 16 |
| N=2¹⁴ r=8 p=5 | 16 MiB | Works | 126 ms | 32 |
| N=2¹³ r=8 p=10 | 8 MiB | Works | 131 ms | 64 |

The last column is buffer arithmetic, not measured concurrency capacity: it excludes application memory and runtime overhead. The workstation had ample RAM, so these timings do not show node memory pressure. Eight 128 MiB hashes alone require 1 GiB. An explicit `maxmem` is needed for the larger configurations.

The provisional choice is N=2¹⁵ r=8 p=3 with explicit `maxmem`, pending target-hardware measurements. These are **not verified security recommendations**; check the current OWASP Password Storage Cheat Sheet before adopting parameters. Any auth comparison must pin identical parameters across implementations.

### Federated identity

The [unsent maintainer question](questions/oauth-authorization-server-scope.md) asks whether `@harperfast/oauth` can authenticate first-party users against Harper's credential store without an upstream provider. That determines whether automated load generators can exercise the real login path and whether native session handling can be compared with a separate identity service.

This question does not block P0.

## Loyalty redemption

`QUOTE-004` carries the loyalty balance in the quote without redeeming it. Quote-time redemption adds pricing policy but no reads or cache pressure. At checkout, decrementing a balance under concurrency introduces a contended customer write worth measuring.

The recorded seed observation was that 39% of customers carried a balance, with a median of 26,038 minor units against cart subtotals around 20,000–120,000. Recheck this when designing conversion, caps, promotion ordering, and tax treatment.

## Checkout, personalization, and realtime

| Deferred area | Scope and constraints |
|---|---|
| Checkout (`CART-001`–`CART-004`) | Cart mutation, stock decrement, and failure on insufficient stock without a partial order. Stub payment authorization with identical fixed latency across implementations; a real provider adds unrelated third-party latency. |
| Personalization (`PERS-001`–`PERS-004`) | Segment-specific copy and recommendations, with generation stubbed at fixed latency. Segment belongs in cache keys; P0 already exercises variation by tier and region. |
| Realtime (`RT-001`–`RT-002`) | Per-SKU stock updates pushed to an open detail page; each platform chooses its transport. |

These ids record deferred scope, not current conformance requirements. The cart quote is already in P0; checkout commit is deferred.

## Dataset tiers

Keep one benchmark size whose working set exceeds memory. Store-size sweeps remain out of scope. `dev` exists only for development and CI; see [dataset design](seed-design.md#scale).

## Media

Use deterministic placeholder images derived from a per-variant `imageSeed`, served from each implementation's origin with identical bytes. Real catalog media remains an expansion point, subject to the methodology's exclusion of delivery-dominated measurements.
