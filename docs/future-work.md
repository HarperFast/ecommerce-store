# Future work

Everything here is out of scope for P0, which is two endpoints, one background writer, eight tables and one dataset. Each entry records the decision that will apply when the scope reopens, because those conclusions cost more to rediscover than the code costs to write.

Ordered roughly as the benchmarks README orders its own Future Work: storefront UI, auth flows, product listing pages, search, checkout commit, images, realtime.

---

## Product listing, facets, and search

**Scope when it returns:** category listing with descendant expansion, facet counts over the full filtered set, multi-select facets, sort, pagination, and full-text search over the same faceted path.

**The requirement worth stating verbatim now**, because it is the one an optimisation silently breaks:

> A facet's own counts are computed with that facet's selections **excluded** from the filter, so a shopper can see the effect of switching a value within a facet they have already used. Counts for all other facets reflect every active selection.

Three facet-counting mechanisms were identified, undecided pending measurement: count from the index per request (correct, scales with matched-set size); maintained counter records per (category, facet, value) — which **cannot** answer the exclusion rule above on its own, only the unfiltered first page; and bitmap intersection with popcount, the search-engine answer and the most work to build.

**Why it was interesting:** facet counting over 100k+ SKUs is the query where a separated stack reaches for a fourth service (Algolia, Elastic, pgvector). That is a real architectural difference, and it is still worth measuring when listing pages return.

## Pages and server rendering

**Scope when it returns:** server-rendered home, listing, detail and search; facets and pagination as real URLs; functional without client-side JavaScript.

**Out of scope by rule**, not by priority — the benchmarks README excludes anything dominated by static asset delivery, browser rendering, or client-side evaluation.

**Consequence for the scaffold:** `@harperfast/nextjs`, `next.config.ts`, React and the shared UI package were **removed**, not retained inert — carrying them shipped hundreds of megabytes to every node for a framework with nothing to do at P0. Note that the repo-root constraint in [`structure.md`](structure.md) does **not** depend on Next.js — the `deploy_component` single-tree constraint forces it independently — so reintroducing a framework with the storefront reopens nothing there.

## Conformance profiles

**The idea:** partition requirements into `DATA` (JSON API, implementable by a backend-only platform) and `APP` (DATA plus pages, sessions, checkout), and draw comparisons only within a shared profile.

**Moot at P0**: every target is a backend stack and nothing renders, so there is one profile and the partition carries no information.

**Revisit when** either storefront UI returns, or platform-as-a-service comparisons begin. The motivating rule still stands — comparing a backend-only platform on full-stack metrics is unfair — so the partition will be needed again the moment a target cannot implement the whole specification. Reintroducing it means adding one field to the registry — cheap, and better re-derived than inherited.

## Identity and accounts

**Scope when it returns:** two principals, deliberately distinct:

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

The provisional choice is N=2¹⁵ r=8 p=3 with an explicit `maxmem`, pending re-measurement on target hardware. Two caveats attach to the table above: it was produced on a workstation with far more memory than a node, so it cannot show memory pressure, and the claim that these are the *recommended* parameter sets is unverified — confirm against the current OWASP Password Storage Cheat Sheet before relying on it.

If auth is ever measured, the parameters must be **pinned identically across implementations**, or the comparison measures whichever work factor each team picked.

### Federated identity

The parked question for the `@harperfast/oauth` maintainers is preserved verbatim at [`questions/oauth-authorization-server-scope.md`](questions/oauth-authorization-server-scope.md). Short version: the plugin contains a full OAuth 2.1 authorization server, but it appears federated by design — it mints tokens while sending humans upstream to Google/GitHub to actually authenticate. Whether it can authenticate a first-party user against Harper's own credential store decides both whether load generators can drive login at all (third parties block automated browsers) and whether there is a Harper-native identity story worth measuring against Supabase Auth / Auth0 / Clerk.

Unblocked and unanswered. Nothing at P0 depends on it.

## Loyalty redemption

`QUOTE-004` requires the loyalty balance to be read and carried in the response, not redeemed against it. Redemption lives here instead.

The reasoning is a general test for whether a requirement earns its place: redeeming a balance in a quote is arithmetic on a field already fetched in wave 2 — no extra read, no extra wave, no cache pressure. It would have imposed a normative rule on every competing implementation (conversion rate, cap, position in the promotion order, treatment of the tax base) in exchange for distinguishing no architecture. A requirement that costs every implementer and separates no stack is measurement noise.

Redemption becomes genuinely interesting at **checkout**, where it decrements a balance under concurrency — a contended per-customer write, which is exactly the kind of thing the comparison exists to expose. 39% of seeded customers carry a balance, median 26,038 minor units against cart subtotals of roughly 20,000–120,000, so a policy will need a cap when it arrives.

## Checkout commit, personalization, realtime

- **Checkout commit** (`CART-001`–`CART-004`): cart mutation, a stubbed payment authorizer with fixed simulated latency identical across implementations, stock decrement, and clean failure on insufficient stock with no partial order. Note the cart *quote* is in P0; only the commit is deferred. A real payment provider was rejected outright — it injects identical third-party latency into every implementation and measures nothing.
- **Personalization** (`PERS-001`–`PERS-004`): segment-keyed copy and recommendations, generator stubbed with fixed latency in measured runs. The requirement that matters is that **segment is part of the cache key space** — serving one segment's content to another is a correctness failure that presents as a caching bug. P0 keeps a reduced form of this: `tier` and `region` vary the PDP response.
- **Realtime** (`RT-001`–`RT-002`): per-SKU stock push to an open detail page, transport left to each platform.

## Dataset tiers

**There is one benchmark dataset size, deliberately.** The benchmarks README is explicit that a dataset fitting entirely in cache is not representative, and that sweeping store size as a variable is out of scope. The property that matters is that the working set must exceed memory, so results are not an artifact of everything fitting in RAM.

A small fixture earns its place as a development and CI convenience, never as a benchmark target. That is what `dev` is.

## Media

Deterministic generated placeholder imagery derived from a per-variant `imageSeed`, served from each implementation's own origin so bytes are identical and the comparison does not become a bandwidth test.

Real product media at catalog scale is a genuine ecommerce cost centre and remains a recorded expansion point rather than an omission — the benchmarks README lists images under Future Work for the same reason.
