# Ecommerce Store — Functional Specification

**Spec version:** `0.1.0-draft` · **Status:** P0 review · **Last updated:** 2026-09-15

---

## 1. What this document is

This is the **reference specification** for a catalog-delivery ecommerce application. It
exists to be implemented more than once — on Harper, and on competitor platforms — so the
implementations can be compared.

> ### The rule
>
> **This specification is functional and platform-neutral. Implementations are maximally
> native to their platform.**

Every requirement below is stated in terms of **routes, behaviors, and data contracts**.
None of them prescribe a mechanism. "The PDP response includes live per-SKU stock, and a
stock write is observable within *N* ms" is a requirement. "Uses `sourcedFrom` with
`@table(expiration)`" is not — that is one platform's answer to it.

Where implementations diverge in *how* they satisfy a requirement, **that divergence is the
finding.** It is the qualitative output of the comparison and must be recorded, not
smoothed away.

### What this document is not

- **Not a description of the Harper implementation.** If a requirement here could not be
  satisfied on Postgres + a cache + a CDN, it is mis-specified. File it as a defect.
- **Not a benchmark plan.** What gets measured, on what hardware, from where, is decided
  per comparison in the `platform-comparison` repo. This document only marks which
  requirements are *eligible* to be measured (§9).
- **Not stable yet.** Until §11 records a passed review gate, requirement ids may move.

---

## 2. How to read this document

### Requirement ids

Every requirement has a stable id: `AREA-NNN`, e.g. `PLP-004`. Ids are **permanent**. A
withdrawn requirement is struck through and its id retired, never reused — conformance
reports and test names reference them forever.

Areas: `CAT` catalog data · `PLP` listing · `PDP` detail · `SRCH` search ·
`PERS` personalization · `AUTH` accounts · `CART` cart & checkout · `ADM` admin writes ·
`RT` realtime · `OBS` observability · `SEED` corpora.

### Requirement levels

- **MUST** — required for conformance. A failing MUST disqualifies the implementation from
  comparison.
- **SHOULD** — expected; a deviation must be recorded in the implementation's notes with a
  reason.
- **MAY** — permitted, never required, never measured.

### Conformance profiles

Not every platform can implement every part of this application, and comparing a
backend-only platform on full-stack metrics is not a fair comparison. Requirements are
therefore grouped into profiles, and an implementation declares which it conforms to.

| Profile | Contains | Who implements it |
|---|---|---|
| **DATA** | The JSON data API (§5) and the catalog model (§4). No rendering. | Every implementation, including backend-only platforms (e.g. Supabase). |
| **APP** | DATA, plus the rendered pages (§6), sessions, and cart/checkout. | Full-stack platforms (Harper, Vercel, Netlify). |
| **NATIVE** | Platform capabilities with no portable equivalent (§10). | Exercised by its own platform only. **Never** compared. |

**Comparisons are only ever drawn within a shared profile.** A Harper-vs-Supabase
comparison is a DATA comparison. A Harper-vs-Vercel comparison may be an APP comparison.
Reporting an APP metric against a DATA-only implementation is a spec violation.

---

## 3. Application concept

A storefront for a large, variant-heavy catalog: roughly **50,000 products** expanding to
**100,000+ purchasable SKUs** through option axes such as size, color, and material.

This shape is deliberate. It is what Harper's ecommerce deployments actually are — catalog
page delivery — and it puts weight on the operations that separate a collapsed stack from a
separated one:

- **Facet counting over 100k+ SKUs** on every listing request.
- **Product-level aggregates over variants** — price range, "in stock in any variant",
  available swatches — which are either maintained on write or computed on read.
- **Invalidation fan-out.** One SKU going out of stock potentially affects its own detail
  page, every listing page it appears on, the "in stock" facet counts, and the product-level
  availability rollup.
- **A working set that exceeds memory** at the largest corpus tier, so results are not an
  artifact of everything fitting in RAM.

---

## 4. Domain model

Platform-neutral. Field names are normative for the API in §5; storage representation is
not specified.

### 4.1 Entities

**Category** — a node in a single-rooted tree.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable, opaque |
| `slug` | string | URL segment, unique among siblings |
| `name` | string | |
| `parentId` | string \| null | `null` for top level |
| `path` | string[] | Ancestor slugs, root first, excluding self |
| `depth` | integer | `path.length` |

**Product** — the unit a shopper browses. Never purchasable directly.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable, opaque |
| `slug` | string | Globally unique |
| `title` | string | |
| `description` | string | |
| `brand` | string | |
| `categoryIds` | string[] | ≥ 1 |
| `optionAxes` | OptionAxis[] | Ordered; defines the variant matrix |
| `attributes` | object | Flat string→string; facetable |
| `createdAt` | integer | Epoch ms; deterministic per seed |

**OptionAxis** — `{ name: string, values: string[] }`. Ordered, e.g.
`{ name: "size", values: ["S","M","L"] }`.

**Variant (SKU)** — the purchasable unit.

| Field | Type | Notes |
|---|---|---|
| `sku` | string | Globally unique |
| `productId` | string | |
| `options` | object | One entry per axis, e.g. `{size:"M",color:"navy"}` |
| `price` | integer | **Minor units** (cents). Never a float. |
| `currency` | string | ISO 4217; `USD` for v1 |
| `stock` | integer | ≥ 0 |
| `imageSeed` | string | Deterministic input to placeholder media (§8.3) |

**ProductSummary** — the projection returned by listing and search. Carries the aggregates:

| Field | Type | Derivation |
|---|---|---|
| `id`, `slug`, `title`, `brand` | | from Product |
| `priceMin`, `priceMax` | integer | min / max `price` over the product's variants |
| `inStock` | boolean | true iff **any** variant has `stock > 0` |
| `swatches` | string[] | distinct values of the axis named `color`, ordered as declared; `[]` if absent |
| `variantCount` | integer | |
| `imageSeed` | string | `imageSeed` of the lowest-ordered variant |

### 4.2 Invariants

- `CAT-001` **MUST** — Every Variant's `options` has exactly one entry per axis in its
  Product's `optionAxes`, and each value appears in that axis's `values`.
- `CAT-002` **MUST** — `sku` and `Product.slug` are globally unique.
- `CAT-003` **MUST** — A ProductSummary's aggregates are **consistent with the current
  variants at the time of the response**. How they are kept consistent is unspecified; being
  stale is a conformance failure, not a performance characteristic.
- `CAT-004` **MUST** — Prices are integer minor units end to end. No implementation may
  introduce a binary floating point representation of money.
- `CAT-005` **MUST** — Every Product has ≥ 1 Variant.
- `CAT-006` **SHOULD** — A Product belongs to at most one category per root subtree.

---

## 5. Data API (profile: DATA)

Transport is HTTP. Bodies are JSON, `content-type: application/json; charset=utf-8`.
Paths below are **canonical**; an implementation whose platform idiom differs (e.g.
PostgREST) **MAY** serve equivalent paths, and **MUST** then publish a mapping table that
the shared verification suite is configured with. The mapping is part of the published
comparison.

### 5.1 Conventions

- `API-001` **MUST** — Unknown query parameters are ignored, not errored.
- `API-002` **MUST** — A malformed parameter value returns `400` with
  `{ "error": { "code": string, "message": string } }`.
- `API-003` **MUST** — A missing resource returns `404` with the same error shape.
- `API-004` **MUST** — Listing responses are **stably ordered**: the sort key, with `sku` or
  `id` as the final tiebreak. Two identical requests against an unchanged corpus return
  identical ordering.
- `API-005` **MUST** — Pagination is `page` (1-based) and `pageSize`. Default `pageSize` 24,
  maximum 96. `pageSize` above the maximum is clamped, not errored.
- `API-006` **SHOULD** — Responses carry an `ETag`, and a matching `If-None-Match` returns
  `304` with no body.

### 5.2 Listing

`GET /api/catalog/products`

Query: `category` (slug, includes descendants) · `page` · `pageSize` · `sort` ·
`facet.<name>=<value>` (repeatable; see below) · `inStock=true`.

`sort` ∈ `relevance` (search only) · `price_asc` · `price_desc` · `newest` · `name_asc`.
Default `name_asc` for listing.

Response:

```json
{
  "items": [ /* ProductSummary */ ],
  "page": 1,
  "pageSize": 24,
  "total": 1284,
  "facets": [
    { "name": "color", "values": [ { "value": "navy", "count": 312 } ] }
  ]
}
```

- `PLP-001` **MUST** — `category` selects the named category **and all descendants**.
- `PLP-002` **MUST** — `total` is the exact count of products matching the filters, not an
  estimate and not capped.
- `PLP-003` **MUST** — Facet counts are computed **over the full filtered result set**, not
  over the returned page.
- `PLP-004` **MUST** — Repeated `facet.<name>` values combine as **OR** within one facet
  name and **AND** across different facet names.
- `PLP-005` **MUST** — A facet's own counts are computed with that facet's selections
  **excluded** from the filter, so a shopper can see the effect of switching a value within
  a facet they have already used. Counts for all other facets reflect every active
  selection.
- `PLP-006` **MUST** — `inStock=true` filters to products where `inStock` is true, and the
  `inStock` facet counts reflect live variant stock.
- `PLP-007` **MUST** — `price_asc` / `price_desc` sort on `priceMin` / `priceMax`
  respectively.
- `PLP-008` **MUST** — Requesting a page beyond the last returns `200` with `items: []`, not
  `404`.
- `PLP-009` **SHOULD** — Facets offered: `color`, `size`, `brand`, `material`, `inStock`.

### 5.3 Detail

`GET /api/catalog/products/:slug`

Response: the full Product, its `optionAxes`, and **every** variant with current `price` and
`stock`.

- `PDP-001` **MUST** — Every variant of the product is returned, with live `stock`.
- `PDP-002` **MUST** — A stock write (§5.5) is reflected here within the freshness budget
  `FRESH_MS` (§9.2).
- `PDP-003` **MUST** — Response includes enough information to render the full variant
  matrix, including unavailable combinations, which are marked rather than omitted.
- `PDP-004` **MUST** — An unknown slug returns `404`.

### 5.4 Search

`GET /api/catalog/search?q=<terms>`

Accepts every listing parameter in addition to `q`. Default `sort` is `relevance`.

- `SRCH-001` **MUST** — Full-text matching over `title`, `brand`, and `description`.
- `SRCH-002` **MUST** — Faceting and pagination behave exactly as in §5.2, over the matched
  set.
- `SRCH-003` **MUST** — An empty or whitespace-only `q` returns `400`.
- `SRCH-004` **MUST** — Matching is case- and diacritic-insensitive.
- `SRCH-005` **SHOULD** — Multi-term queries are conjunctive (all terms must match).
- `SRCH-006` **MAY** — Typo tolerance. If implemented it is declared, because it changes
  result counts and therefore comparability of `total`.

### 5.5 Admin writes

Authenticated (§7). These are the **measured** write path.

| Method | Path | Body |
|---|---|---|
| `PATCH` | `/api/admin/variants/:sku` | `{ "stock"?: integer, "price"?: integer }` |
| `POST` | `/api/admin/variants/bulk` | `{ "updates": [ { "sku", "stock"?, "price"? } ] }` |

- `ADM-001` **MUST** — Requires an authenticated principal holding the operator role.
  Unauthenticated → `401`; authenticated without the role → `403`.
- `ADM-002` **MUST** — A successful write is observable on the detail response within
  `FRESH_MS`, and on listing responses, facet counts, and product aggregates within
  `FANOUT_MS` (§9.2).
- `ADM-003` **MUST** — `stock` < 0 or a non-integer `price` → `400`; no partial application.
- `ADM-004` **MUST** — Bulk updates apply atomically per SKU. The response reports
  per-SKU success or failure.
- `ADM-005` **MUST** — A write that changes whether any variant is in stock updates the
  product's `inStock` aggregate and the `inStock` facet counts.

---

## 6. Pages (profile: APP)

Server-rendered HTML. The shared verification suite drives these through a real browser.

| Route | Page |
|---|---|
| `/` | Home |
| `/c/:categoryPath*` | Listing |
| `/p/:slug` | Detail |
| `/search?q=` | Search results |
| `/account`, `/account/orders` | Account (auth required) |
| `/cart`, `/checkout` | Cart, checkout |

- `PAGE-001` **MUST** — Home, listing, detail and search render on the server; their primary
  content is present in the initial HTML response body.
- `PAGE-002` **MUST** — Listing pages expose facets, sort, and pagination as real links or
  form submissions with distinct URLs, so state is shareable and crawlable.
- `PAGE-003` **MUST** — The detail page renders the variant matrix with per-variant
  availability, and selecting a variant updates the displayed price and availability.
- `PAGE-004` **MUST** — Every page emits `Server-Timing` (§`OBS`).
- `PAGE-005` **SHOULD** — Implementations render markup from the shared component library so
  the comparison measures the stack rather than the front end.
- `PAGE-006` **MUST** — Pages are functional without client-side JavaScript for navigation,
  faceting, and pagination.

---

## 7. Identity and accounts

Two distinct principals. Conflating them is a conformance failure.

| Principal | Population | Purpose |
|---|---|---|
| **Operator** | Tens | Admin writes (§5.5). Platform-native access control where available. |
| **Shopper** | 100k+ | Storefront sessions, cart, orders. Application-level. |

- `AUTH-001` **MUST** — Shopper credentials are verified against a **real password hash**
  using a memory-hard or iterated KDF. Plaintext, unsalted, or fast-digest storage (MD5,
  SHA-*) is a conformance failure.
- `AUTH-002` **MUST** — KDF algorithm and parameters are **identical across
  implementations** and recorded in the comparison. They are a pinned constant, not a
  platform choice — otherwise the comparison measures the chosen work factor.
- `AUTH-003` **MUST** — Sessions are established out of band for measured runs; measured
  requests carry an existing credential. Login itself is exercised for correctness, and is
  **not** in any measured hot path (§9.1).
- `AUTH-004` **MUST** — Every authenticated request validates its session or token. This
  validation **is** in the measured path — it is the architecturally interesting half of
  auth.
- `AUTH-005` **MUST** — Operator authorization for §5.5 is enforced server-side, and is not
  bypassable by a shopper session.
- `AUTH-006` **MUST** — All accounts are seeded deterministically (§8) and are driveable by
  an automated client with no human interaction and no third-party interstitial.
- `AUTH-007` **SHOULD** — Federated login (OAuth) may be offered additionally. It is
  **excluded from measured paths**: the handshake leaves the platform and costs every
  implementation the same.

---

## 8. Corpora and determinism

- `SEED-001` **MUST** — Catalog data is generated from a **deterministic seeded generator**.
  The same tier and seed produce identical entities, ids, slugs, prices, stock and timestamps
  on every platform. A comparison run against differing corpora is void.
- `SEED-002` **MUST** — Three tiers:

  | Tier | Products | SKUs (approx) | Purpose |
  |---|---|---|---|
  | `sm` | 1,000 | 2,500 | Local development, CI |
  | `md` | 10,000 | 25,000 | Functional verification |
  | `lg` | 50,000 | 100,000+ | Benchmarks. **Sized to exceed a free-tier node's memory.** |

- `SEED-003` **MUST** — The `lg` tier's working set is large enough that it cannot be served
  entirely from memory on the compared tier's hardware. If a platform's free tier grows,
  `lg` grows with it, and the change is recorded as a new spec version.
- `SEED-004` **MUST** — Category tree, option axes, and attribute vocabularies are fixed by
  the generator, not sampled per run.
- `SEED-005` **MUST** — Seeding is reproducible from a documented command, and the resulting
  corpus is verifiable by a checksum over a canonical serialization.
- `SEED-006` **MUST** — Product media are **deterministically generated placeholders**
  derived from `imageSeed`, served from each implementation's own origin, byte-identical
  across implementations. Real photography would turn the comparison into a bandwidth test.
  See §10 for the expansion point.

---

## 9. Measurement eligibility

This section does not define benchmarks. It marks what is eligible to be one.

### 9.1 Status by area

| Area | v1 |
|---|---|
| Listing, detail, search, home reads | **Measured** |
| Admin writes and their invalidation fan-out | **Measured** |
| Session validation on authenticated reads | **Measured** |
| Login / password verification | Built, **not measured** (`AUTH-003`) |
| Personalization generation | Stubbed in all measured runs (§`PERS`) |
| Cart, checkout, orders | Built, **not measured in v1** |
| Anything in §10 | **Never measured** |

### 9.2 Freshness budgets

Named here so implementations target the same numbers; the values are set with the first
comparison and recorded in this document when they are.

| Constant | Meaning | Value |
|---|---|---|
| `FRESH_MS` | Admin write → visible on the detail response | *TBD at first benchmark* |
| `FANOUT_MS` | Admin write → reflected in listing results, facet counts, aggregates | *TBD at first benchmark* |

### 9.3 Observability

- `OBS-001` **MUST** — Every HTML and API response carries a `Server-Timing` header
  decomposing server-side time into at least: data access, rendering, and total.
- `OBS-002` **MUST** — The decomposition is present from the first commit of a surface, not
  added later. It is what makes reported numbers auditable.
- `OBS-003` **MUST** — Responses indicate whether they were served from a cache, and the
  mechanism is documented per implementation.

### 9.4 Personalization

- `PERS-001` **MUST** — A shopper resolves to exactly one **segment** from a fixed, seeded
  set.
- `PERS-002` **MUST** — Home and listing surfaces render segment-keyed copy, and detail
  surfaces render segment-keyed recommendations.
- `PERS-003` **MUST** — In every measured run the copy/recommendation generator is
  **stubbed** with a fixed simulated latency, identical across implementations. A live model
  call injects third-party latency equally and measures nothing.
- `PERS-004` **MUST** — Segment is part of the cache key space wherever responses are
  cached. Serving one segment's content to another is a conformance failure.

### 9.5 Cart and checkout

- `CART-001` **MUST** — A shopper can add variants to a cart, change quantities, and
  check out.
- `CART-002` **MUST** — Checkout calls a **stubbed payment authorizer** with a fixed
  simulated latency, identical across implementations. No real payment provider.
- `CART-003` **MUST** — Checkout decrements stock for the ordered SKUs and produces an order
  visible in order history.
- `CART-004` **MUST** — Checkout of a SKU with insufficient stock fails cleanly with no
  partial order and no stock change.

### 9.6 Realtime

- `RT-001` **MUST** — An open detail page receives per-SKU stock changes without a full page
  reload.
- `RT-002` **SHOULD** — The transport is whatever each platform recommends. The requirement
  is the observable behavior and its latency, not the protocol.

---

## 10. Non-portable tier (profile: NATIVE)

Capabilities exercised by an implementation to demonstrate its platform, with **no portable
equivalent** and therefore **never compared**. Each must be flagged in the implementation's
notes.

Examples on Harper: MQTT, replication topology, `image-optimizer`.

**Recorded expansion points** — real customer problems deliberately out of v1 scope, named
here so their absence is a decision and not an oversight:

- **Real product media at catalog scale.** Media delivery is a genuine ecommerce cost
  centre. v1 uses generated placeholders (`SEED-006`) to keep the comparison off bandwidth.
  The seam to swap in real media is part of the design.
- **User-write throughput.** Cart and checkout are built in v1 but not measured. Measuring
  transactional throughput and contention is v2 work against a surface that already exists.
- **Federated identity as a measured path** (`AUTH-007`).

---

## 11. Conformance and change control

- An implementation publishes a **conformance report**: its profile, every requirement id,
  and pass / fail / deviation-with-reason.
- The shared verification suite is the executable form of this document. Each test names the
  requirement ids it covers, and every MUST is covered by at least one test.
- This document is **versioned and snapshotted with each comparison**. A published
  comparison names the exact spec version it was run against.
- Requirement ids are permanent. Withdrawn requirements are struck through, never reused.

### Review gate

P0 does not complete until this document has passed: self-review → cross-model review →
at least one human reviewer. No application code is written before that.

| Gate | Status |
|---|---|
| Self-review | ☑ 2026-09-15 |
| Cross-model review | ☐ |
| Human review | ☐ |

**Self-review consisted of:** a mechanism-leak scan of the normative text (§4 onward names
no platform and no platform-specific construct); `scripts/check-spec-sync.mjs`, which
asserts SPEC.md and `packages/spec` agree on every id and level; and
`e2e/scripts/coverage.mjs`, which asserts every applicable MUST has a test — 41 MUSTs under
DATA, 60 under APP, all covered. Both checks are committed with negative tests, so the
agreement is enforced rather than asserted.

**Known open, deliberately:** `FRESH_MS` and `FANOUT_MS` (§9.2) are unset until the first
benchmark establishes achievable values. Every requirement referencing them
(`PDP-002`, `ADM-002`) is otherwise complete.
