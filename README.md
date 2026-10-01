# Harper Ecommerce Store

A Harper-native ecommerce catalog service, and the reference implementation for the [Harper Application Architecture Benchmarks](https://github.com/HarperFast/application-architecture-benchmarks).

It exists to be three things at once: a worked example of how to build an efficient Harper application, the home of the specification every benchmark implementation is measured against, and a target that is tested and benchmarked against each significant Harper release.

> **Status: pre-release.** The specification has not passed its review gate and the conformance suite is incomplete. See [`docs/plan.md`](docs/plan.md).

## The application

A catalog service for a large, variant-heavy store: 2 million products across 6.5 million purchasable SKUs, stocked across eight fulfillment locations.

Two endpoints.

### `POST /cart/:id/quote`

Prices a cart. Resolves in four to five dependent waves — 60 to 150 record reads — because each wave needs the previous wave's answer before it can issue its own:

1. The cart.
2. Product and variant for every line.
3. Inventory across fulfillment locations, honouring location priority; and the customer's tier and loyalty balance.
4. Eligible promotions by tier, SKU and category, then real pricing logic over them — stacking, exclusivity, thresholds, BOGO.
5. Shipping by region and total cart weight; tax by jurisdiction.

Every response is unique to its cart, so it is **never response-cacheable**. Entity caches still do the job real deployments give them.

Promotions evaluate in a fixed order — exclusive, then threshold, then BOGO, then stackable, ties breaking on ascending promotion id, each discount rounding half-up as it is applied. The order is normative: without it two correct implementations disagree on a total.

### `GET /product/:id?tier=&region=`

The product aggregate: the product, its variants, live inventory for those variants, resolved price, review rollup, and related items. Mostly cacheable, but **price varies by tier and availability by region**, so both belong in any cache key.

### Background writes

A steady stream of inventory and price updates against the same records the reads touch. Not an endpoint, and not under test — it exists so caches have to stay coherent with their source of truth, which a read-only workload would never force.

## Data model

Eight tables, deliberately not pre-joined: `cart`, `customer`, `product`, `variant`, `inventory`, `location`, `promotion`, `rate`.

Money is integer minor units end to end — no float ever enters a total. Product-level values are resolved on read rather than materialized on write, because the fan-out is the thing being measured. [`docs/data-model.md`](docs/data-model.md) has the reasoning, including what would reverse it.

## Running it

Requires [Git LFS](https://git-lfs.com) — the benchmark dataset lives there. `dev` does not.

```bash
git lfs install && npm install
```

Start Harper with the small development dataset:

```bash
npm run dev
```

```bash
npm run seed -- --scale dev && node scripts/load-dataset.mjs --scale dev
```

```bash
curl -s -X POST localhost:9926/cart/cart-000042/quote -H 'content-type: application/json' -d '{}'
```

## Datasets

| | Rows | Stored | Use |
|---|---|---|---|
| `dev` | 46,583 | plain git, 5 MB | Local work. Loads in under two seconds. **Never a benchmark target** — it fits entirely in memory, the one thing the benchmark data must not do. |
| `bench` | 40,656,446 | Git LFS, 329 MB compressed | The benchmark. ~4.5 GB expanded, against a 2 GiB container. |

Both are generated once, committed, and verified by checksum before every load. Implementations do not re-derive them — identity is established by hash, not by every runtime reproducing one PRNG stream. [`docs/seed-design.md`](docs/seed-design.md).

## Conformance

[`SPEC.md`](SPEC.md) states 27 numbered, stack-neutral requirements. [`packages/spec`](packages/spec) is its machine-readable half; [`e2e/`](e2e) is its executable half, where every test names the requirement ids it covers.

```bash
npm run check && npm run test:e2e
```

If a requirement in `SPEC.md` could not be satisfied by Fastify + Postgres + Redis, it is mis-specified — please say so.

## Benchmarking

Containerized, with a fixed resource budget and the load generator outside it: [`containers/README.md`](containers/README.md). The harness and, just as importantly, the claims it does **not** support: [`bench/README.md`](bench/README.md).

## Documentation

| | |
|---|---|
| [`SPEC.md`](SPEC.md) | The specification |
| [`docs/data-model.md`](docs/data-model.md) | The eight tables and why aggregates resolve on read |
| [`docs/seed-design.md`](docs/seed-design.md) | Deterministic datasets, and why they are committed |
| [`docs/structure.md`](docs/structure.md) | Repository layout. Read before adding a dependency |
| [`docs/future-work.md`](docs/future-work.md) | What is out of scope, and the decisions behind it |
| [`docs/plan.md`](docs/plan.md) | Development status, open decisions, what may not yet be claimed |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How to propose changes |

## Versions

harper `5.2.12` · Node `>=22` · TypeScript `7.0.2`

## License

[Apache 2.0](LICENSE)
