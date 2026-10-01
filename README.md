# Harper Ecommerce Store

The golden reference implementation for the [Harper Application Architecture Benchmarks](https://github.com/HarperFast/application-architecture-benchmarks).

> **Status: P0 — spec draft.** [`SPEC.md`](SPEC.md) is written; the review gate has not been passed and there is no application code yet.

## What this is

Three things at once:

1. **A Harper reference.** How to build an efficient Harper application, readable by a developer or customer who wants to understand the platform.
2. **The specification's home.** It carries the conformance suite that defines what every benchmark implementation must do.
3. **A benchmark target.** Tested and independently benchmarked against every significant Harper release.

The methodology, the measurement rules, and the rules governing how results may be described live in the benchmarks repo and are **binding**. This repo defines the application.

> **The rule:** the specification is functional and stack-neutral; implementations are maximally native to their stack. If a requirement in `SPEC.md` could not be satisfied by Fastify + Postgres + Redis, it is mis-specified.

## Scope

P0 is deliberately small — two endpoints, one background writer, eight tables, one dataset:

| | |
|---|---|
| `POST /cart/:id/quote` | The endpoint under test. Four to five dependent waves, 60–150 reads, real pricing logic. Every response is cart-unique, so no implementation can win by caching a response. |
| `GET /product/:id?tier=&region=` | The read-heavy leg. Mostly cacheable, varies by tier and region. |
| Background writes | A steady stream of inventory and price updates against the same records the reads touch, so caches have to stay coherent. Not an endpoint under test. |

Storefront UI, auth, listing pages, search, checkout commit, images and realtime are future work. The reasoning and the decisions already taken on them are kept in [`docs/future-work.md`](docs/future-work.md) rather than rediscovered later.

## Reading order

| | |
|---|---|
| [`SPEC.md`](SPEC.md) | The specification. Start here. |
| [`packages/spec`](packages/spec) | Its machine-readable half — route contract, types, requirement registry. |
| [`e2e/`](e2e) | Its executable half — every test names the requirements it covers. |
| [`docs/data-model.md`](docs/data-model.md) | The eight tables, and why aggregates resolve on read. |
| [`docs/seed-design.md`](docs/seed-design.md) | Why the dataset is committed rather than regenerated. |
| [`docs/structure.md`](docs/structure.md) | Why the repo is laid out this way. Read before adding a dependency. |
| [`docs/future-work.md`](docs/future-work.md) | What was scoped out, and the decisions that came with it. |

## Checks

```bash
npm run check
```

Four checks, each with a committed negative test: `SPEC.md` agrees with the requirement registry; every MUST has a test; the tree typechecks; and a simulated deploy lands nothing dev-only on the node.

## Versions

Pinned and verified 2026-10-01: harper `5.2.12` · TypeScript `7.0.2` · Node `>=22`.

## License

MIT
