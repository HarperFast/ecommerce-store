# Contributing

Follow Harper's [contribution guidelines](https://github.com/HarperFast/.github/blob/main/CONTRIBUTING.md) and [Code of Conduct](https://github.com/HarperFast/.github/blob/main/CODE_OF_CONDUCT.md).

The [Application Architecture Benchmarks methodology](https://github.com/HarperFast/application-architecture-benchmarks) governs this repo, including measurement and reporting. Read it before changing the specification, dataset, or endpoints.

## Before you start

Check [docs/plan.md](docs/plan.md) for current work and blockers. Open an issue or discuss large changes in [Discord](https://harper.fast/discord).

These changes need particular care because they affect comparison validity:

| Change | Constraint |
|---|---|
| `SPEC.md` | Preserve stack neutrality. Changes in meaning affect every implementation and comparisons using that version. |
| `dataset/` | The dataset is a pinned contract. Regenerating it changes the basis of every run. |
| Pricing logic | Preserve the specification's promotion order and totals across implementations. |
| Dependencies | Read [docs/structure.md](docs/structure.md): workspace dependencies can ship even under `--omit=dev`. |

## Setup

Follow the [local setup](README.md#run-locally). The benchmark dataset requires Git LFS; if you cloned without it, run:

```bash
git lfs install
git lfs pull
```

The `dev` dataset needs no LFS. Load the committed data for normal work; `npm run seed` is only for intentional dataset changes.

## Before opening a pull request

```bash
npm run check
npm run test:e2e
```

`check` validates requirement ids and levels, specification links, declared MUST coverage, promotion-index completeness, dataset checksums, types, and deployment dependencies. The conformance suite tests the HTTP behavior; each test names the requirement ids it covers. **A new MUST without a test fails CI.** Declared coverage does not prove every check runs; known gaps are in [the plan](docs/plan.md#open).

Update `docs/plan.md` when status, decisions, or limitations change.

## Useful contributions

- Faster implementations that preserve required behavior.
- Requirements that cannot be satisfied on another stack, such as Fastify + Postgres + Redis.
- Reproducible evidence of measurement flaws.

Competitor implementations belong in the benchmarks repo. Published results belong in dated snapshot repos, never here.
