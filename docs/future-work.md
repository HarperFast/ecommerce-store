# Future work

Everything here was designed, then scoped out when P0 narrowed to two endpoints and a background writer. It is kept because the *decisions* cost more to rediscover than the code did to write, and because several were argued through to a conclusion that will still apply when the scope reopens.

Code for any of it is recoverable from git history at `a9ddedb`. The code is not the valuable part.

Ordered roughly as the benchmarks README orders its own Future Work: storefront UI, auth flows, product listing pages, search, checkout commit, images, realtime.

---

## Product listing, facets, and search

**Was:** `PLP-001`–`PLP-009`, `SRCH-001`–`SRCH-006`. Category listing with descendant expansion, facet counts over the full filtered set, multi-select facets, sort, pagination, and full-text search over the same faceted path.

**The requirement worth preserving verbatim**, because it is the one an optimisation silently breaks:

> A facet's own counts are computed with that facet's selections **excluded** from the filter, so a shopper can see the effect of switching a value within a facet they have already used. Counts for all other facets reflect every active selection.

Three facet-counting mechanisms were identified, undecided pending measurement: count from the index per request (correct, scales with matched-set size); maintained counter records per (category, facet, value) — which **cannot** answer the exclusion rule above on its own, only the unfiltered first page; and bitmap intersection with popcount, the search-engine answer and the most work to build.

**Why it was interesting:** facet counting over 100k+ SKUs is the query where a separated stack reaches for a fourth service (Algolia, Elastic, pgvector). That is a real architectural difference, and it is still worth measuring when listing pages return.

## Pages and server rendering

**Was:** `PAGE-001`–`PAGE-006`. Server-rendered home, listing, detail and search; facets and pagination as real URLs; functional without client-side JavaScript.

**Now out of scope by rule**, not by priority — the benchmarks README excludes anything dominated by static asset delivery, browser rendering, or client-side evaluation.

**Consequence for the scaffold:** `@harperfast/nextjs` and `next.config.ts` have nothing to do at P0. The wiring is retained but inert. Note that the repo-root constraint in [`structure.md`](structure.md) does **not** depend on Next.js — the `deploy_component` single-tree constraint forces it independently — so dropping Next.js later would not reopen that decision.

## Conformance profiles

**Was:** requirements partitioned into `DATA` (JSON API, implementable by a backend-only platform) and `APP` (DATA plus pages, sessions, checkout), with comparisons only ever drawn within a shared profile.

**Moot at P0**: every target is a backend stack and nothing renders, so there is one profile and the partition carries no information.

**Revisit when** either storefront UI returns, or platform-as-a-service comparisons begin. The motivating rule still stands — comparing a backend-only platform on full-stack metrics is unfair — so the partition will be needed again the moment a target cannot implement the whole specification. Reintroducing it means adding one field to the registry — cheap, and better re-derived than inherited.

## Identity and accounts

**Was:** `AUTH-001`–`AUTH-007`, plus a full design. Two principals, deliberately distinct:

| | Operator | Shopper |
|---|---|---|
| Population | tens | 100,000+ |
| Purpose | admin writes | storefront sessions, cart, orders |
| Enforcement | platform-native users + roles | application-level record + sessions |

The argument for splitting them: platform-native access control is DB-enforced and yields the admin write surface with almost no handler code, which is itself a finding against stacks that hand-write it — but it is not shaped for 100k storefront accounts, where session validation cost on *every request* is the architecturally interesting measurement.

**Carried questions:** where a customer-service operator sits (needs shopper-scoped access); whether shopper records get DB-enforced or app-enforced access control; and the measured cost difference between validating a native session and an application session, which is the real comparison axis against a stateless-JWT model (fast, weak revocation).

### Password hashing — measured, keep this

`scripts/measure-kdf.mjs` is retained. The finding inverted the intuition and would otherwise be rediscovered the hard way:

> **Memory per hash, not time per hash, is what caps a small node.** scrypt is memory-hard by design and concurrent logins each hold their own buffer simultaneously.

| Parameters | Mem/hash | Node default `maxmem` | Serial | Max concurrent in 512 MiB |
|---|---|---|---|---|
| N=2¹⁷ r=8 p=1 | 128 MiB | **THROWS** | 234 ms | 4 |
| N=2¹⁶ r=8 p=2 | 64 MiB | **THROWS** | 213 ms | 8 |
| N=2¹⁵ r=8 p=3 | 32 MiB | **THROWS** | 160 ms | 16 |
| N=2¹⁴ r=8 p=5 | 16 MiB | ok | 126 ms | 32 |
| N=2¹³ r=8 p=10 | 8 MiB | ok | 131 ms | 64 |

At the commonly-cited N=2¹⁷, **eight concurrent logins reserve 1 GiB** — an entire small node. And Node's `crypto.scrypt` defaults `maxmem` to 32 MiB and **throws** at every set at or above 32 MiB per hash, at first real login rather than at startup.

Tentative choice was N=2¹⁵ r=8 p=3 with explicit `maxmem`, provisional pending re-measurement on target hardware. Two caveats recorded at the time: the numbers are from an 18 GiB workstation that cannot show memory pressure, and the claim that these are the *recommended* sets is recall rather than verified — confirm against the current OWASP Password Storage Cheat Sheet before relying on it.

If auth is ever measured, the parameters must be **pinned identically across implementations**, or the comparison measures whichever work factor each team picked.

### Federated identity

The parked question for the `@harperfast/oauth` maintainers is preserved verbatim at [`questions/oauth-authorization-server-scope.md`](questions/oauth-authorization-server-scope.md). Short version: the plugin contains a full OAuth 2.1 authorization server, but it appears federated by design — it mints tokens while sending humans upstream to Google/GitHub to actually authenticate. Whether it can authenticate a first-party user against Harper's own credential store decides both whether load generators can drive login at all (third parties block automated browsers) and whether there is a Harper-native identity story worth measuring against Supabase Auth / Auth0 / Clerk.

Unblocked and unanswered. Nothing at P0 depends on it.

## Checkout commit, personalization, realtime

- **Checkout commit** (`CART-001`–`CART-004`): cart mutation, a stubbed payment authorizer with fixed simulated latency identical across implementations, stock decrement, and clean failure on insufficient stock with no partial order. Note the cart *quote* is in P0; only the commit is deferred. A real payment provider was rejected outright — it injects identical third-party latency into every implementation and measures nothing.
- **Personalization** (`PERS-001`–`PERS-004`): segment-keyed copy and recommendations, generator stubbed with fixed latency in measured runs. The requirement that matters is that **segment is part of the cache key space** — serving one segment's content to another is a correctness failure that presents as a caching bug. P0 keeps a reduced form of this: `tier` and `region` vary the PDP response.
- **Realtime** (`RT-001`–`RT-002`): per-SKU stock push to an open detail page, transport left to each platform.

## Dataset tiers

**Was:** three tiers — `sm` (1k products), `md` (10k), `lg` (50k products / 100k+ SKUs) — with `lg` deliberately sized to exceed a free node's memory.

**Now one size.** The benchmarks README is explicit that a dataset fitting entirely in cache is not representative, and that sweeping store size as a variable is out of scope. The surviving idea is the *reason* `lg` existed: the working set must exceed memory, so results are not an artifact of everything fitting in RAM.

`sm` may still earn its place as a CI fixture, but as a development convenience, never as a benchmark target.

## Media

Deterministic generated placeholder imagery derived from a per-variant `imageSeed`, served from each implementation's own origin so bytes are identical and the comparison does not become a bandwidth test.

Real product media at catalog scale is a genuine ecommerce cost centre and remains a recorded expansion point rather than an omission — the benchmarks README lists images under Future Work for the same reason.
