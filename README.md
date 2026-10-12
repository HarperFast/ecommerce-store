# Harper Ecommerce Store

A Harper-native catalog service and reference implementation for the [Harper Application Architecture Benchmarks](https://github.com/HarperFast/application-architecture-benchmarks). This repo contains the application, its stack-neutral specification, and the conformance suite used by every implementation.

> **Pre-release.** The specification has not passed its review gate, and no run is a publishable result. See [project status and open work](docs/plan.md).

## The application

The benchmark catalog has 2 million products, 6.5 million purchasable SKUs, and eight fulfillment locations. Two endpoints exercise its read paths:

| Endpoint | Behavior | Caching |
|---|---|---|
| `POST /cart/:id/quote` | Reads the cart, products, variants, inventory, customer, promotions, shipping, and tax in roughly four to five dependent waves (60–150 reads). | Entity caches are allowed; response caching is forbidden. |
| `GET /product/:id?tier=&region=` | Returns the product, variants, inventory, resolved price, review rollup, and related items. | Cache keys include tier and region. |

Background inventory and price writes target the same records, exercising cache coherence. Their latency is not a headline metric.

Eight logical entities are the source of truth: `cart`, `customer`, `product`, `variant`, `inventory`, `location`, `promotion`, and `rate`. Money uses integer minor units. [SPEC.md](SPEC.md) defines pricing and promotion order; [the data-model notes](docs/data-model.md) explain Harper's implementation.

## Run locally

Requires Node `>=22`. Install [Git LFS](https://git-lfs.com) to use the benchmark dataset; the development dataset is stored in plain git.

```bash
git lfs install
npm install
npm run dev
```

In another terminal, load the committed development dataset and request a quote:

```bash
node scripts/load-dataset.mjs --scale dev
curl -s -X POST localhost:9926/cart/cart-000042/quote -H 'content-type: application/json' -d '{}'
```

**Do not run `npm run seed` for setup.** It regenerates the pinned dataset. Read [Contributing](CONTRIBUTING.md) before changing it.

## Datasets

| Scale | Storage | Use |
|---|---|---|
| `dev` | Plain git | Local development and CI. Fits in memory; never a benchmark target. |
| `bench` | Git LFS, compressed | Benchmarking. Designed to exceed the target container's memory budget. |

Each dataset's `MANIFEST.json` defines its row counts and checksums. Every implementation loads the committed artifact and verifies its checksum; see [dataset generation](docs/seed-design.md).

## Validate and benchmark

```bash
npm run check
npm run test:e2e
```

[SPEC.md](SPEC.md) defines the requirements, [packages/spec](packages/spec) holds the contract and registry, and [e2e](e2e) tests conformance. Requirements must be implementable on other stacks, including Fastify + Postgres + Redis.

Use the [container workflow](containers/README.md) for benchmark runs. Read the [harness limitations](bench/README.md#limitations) before interpreting any output.

## Documentation

| Document | Purpose |
|---|---|
| [Specification](SPEC.md) | Stack-neutral requirements and review gate |
| [Project plan](docs/plan.md) | Status, priorities, blockers, and dated observations |
| [Data model](docs/data-model.md) | Harper schema and indexing decisions |
| [Dataset generation](docs/seed-design.md) | Reproducibility and distribution rules |
| [Repository structure](docs/structure.md) | Deployment layout and dependency rules |
| [Future work](docs/future-work.md) | Deferred scope and decisions |
| [Contributing](CONTRIBUTING.md) | Change and validation workflow |

## Versions and license

Harper `5.2.12` · Node `>=22` · TypeScript `7.0.2` · [Apache 2.0](LICENSE)
