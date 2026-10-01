# Contributing

This repo follows Harper's [organization contribution guidelines](https://github.com/HarperFast/.github/blob/main/CONTRIBUTING.md) and [Code of Conduct](https://github.com/HarperFast/.github/blob/main/CODE_OF_CONDUCT.md).

This is the reference implementation for the [Harper Application Architecture Benchmarks](https://github.com/HarperFast/application-architecture-benchmarks). That repo's methodology, measurement rules, and rules about how results may be described are **binding here**. Read it before proposing anything that touches the specification, the dataset, or the endpoints.

## Before you start

Open an issue, or say hello in [Discord](https://harper.fast/discord), before large changes.

Some changes are much heavier than their diff suggests, because published benchmark results were produced against them:

| Change | Why it is heavy |
|---|---|
| `SPEC.md` | Every implementation on every platform is measured against it. A requirement that changes meaning invalidates comparisons already published. |
| `dataset/` | The dataset is a pinned contract. Regenerating it changes every number ever produced from it. |
| `resources/` pricing logic | The promotion evaluation order is normative. Two implementations that disagree on a total produce an invalid comparison, not a close one. |

Expect more discussion and slower merges on those than on a bug fix or a doc correction.

## Prerequisites

This repo uses **Git LFS** for the benchmark dataset. Install it before cloning, or the large files arrive as text pointers rather than data:

```bash
git lfs install
```

Already cloned without it? `git lfs pull` fixes it in place. The `dev` dataset is plain git and needs none of this.

## Before you open a pull request

```bash
npm run check
```

That runs four things, each with a committed negative test: `SPEC.md` agrees with the requirement registry, every MUST has a test, the tree typechecks, and a simulated deploy lands nothing dev-only on a node.

Then the conformance suite, which is the executable form of the specification:

```bash
npm run test:e2e
```

Every test names the requirement ids it covers. **A new MUST without a test fails CI** — that is the point of the coverage gate, not an inconvenience to route around.

## What is especially welcome

- **A faster way to satisfy a requirement.** If the Harper implementation is leaving performance on the table, that is a bug in the reference, and the reference exists to be good.
- **A requirement that cannot be implemented on another stack.** `SPEC.md` is supposed to be stack-neutral; if something in it could not be satisfied by Fastify + Postgres + Redis, it is mis-specified and we want to know.
- **Evidence that a measurement is unsound.** Instructions for reproducing a flaw are more useful than a report of one.

## What this repo is not

It is not where competitor implementations live — those belong in the benchmarks repo. It is not where benchmark results are published — those are dated snapshot repos. See [`docs/plan.md`](docs/plan.md) for how the pieces fit and what state each is in.
