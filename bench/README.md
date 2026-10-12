# Benchmark harness

The HTTP load harness exercises the specification's two endpoints and concurrent background writes. It can address another implementation, but only Harper exists today.

**No run is a publishable result.** Read [Limitations](#limitations) before interpreting output. The [benchmark methodology](https://github.com/HarperFast/application-architecture-benchmarks) governs all measurements and claims.

## Run

Use the [container workflow](../containers/README.md) to set resource limits and restore state between trials:

```bash
SCALE=dev ./containers/run-benchmark.sh
```

For local iteration against a running Harper instance:

```bash
node scripts/load-dataset.mjs --scale dev
node bench/run.mjs --duration 12
```

Direct runs have no fixed resource budget, snapshot restore, or cold-start measurement. Their output is not a result.

`--rates` overrides the load ladder. The default targets the suspected saturation range at `bench` scale and is low for `dev`.

## Data and output

`dev` is an in-memory fixture for development and CI, never a benchmark target. `bench` is the pinned benchmark dataset, designed to exceed target memory. See [dataset generation](../docs/seed-design.md) for storage, expansion, and checksum rules. Row counts and hashes come from each dataset's `MANIFEST.json`.

A run retains per-request samples and conditions in `bench/results/run-<timestamp>.json` by default: dataset scale, seed, checksums, host, harness settings, and caveats. Container runs write to the `bench-results` volume under `/results`.

## Implemented measurements

| Mechanism | Purpose and interpretation |
|---|---|
| Open load model | Issue arrivals on a fixed timeline regardless of outstanding requests, so the target cannot throttle offered load. |
| Load ladder | Locate the rate at which latency or errors exceed the target. A single saturating rate cannot locate that boundary. |
| Generator CPU | Record CPU per step. Above 0.8 of a core, flag the step and exclude it as a target measurement. |
| In-flight ceiling | Shed and count arrivals beyond the ceiling. A shedding step's achieved rate is a lower bound, not a capacity measurement. |
| Raw samples | Retain request samples for later distribution and interval analysis. |
| Background writes | Update inventory and prices through the application's write surface, exercising invalidation as well as reads. |
| Access skew | Share the dataset's hot-key distribution; weight tier and region to the seeded customer population. |
| Cache behavior | Record cache-hit rate and invalidation fan-out. Flag a zero hit rate, which may indicate the caching shortcut forbidden by `WRITE-003`. |

## Limitations

- **No ground-truth correctness guard.** Every 2xx counts as success. Conformance checks determinism, but the harness does not compare responses with independently computed expected values. It needs pinned expected quotes derived from `SPEC.md`. Throughput currently says nothing about quote correctness.
- **CPU clock is not pinned.** Do not derive cycle-normalized efficiency (ops per CPU-gigacycle) from any run produced here.
- **No component CPU breakdown.** `targetCpuSeconds` is one number for Harper. Framework/database/cache accounting awaits an assembled stack.
- **No cross-target comparison.** The orchestrator implements resource limits, restore, and cold/warm/hot phases for one target. Identical treatment across implementations has not been demonstrated.
- **Run requirements are not verified automatically.** The orchestrator does not invoke `scripts/verify-run-record.mjs`; declared coverage alone does not validate a run. See [open work](../docs/plan.md#open).

Dated observations and unresolved behavior belong in [docs/plan.md](../docs/plan.md#first-bench-scale-observations-2026-10-05), not a results report. Nothing from `dev` is reportable.

## Access distribution

Uniform draws over product × tier × region rarely revisit a key during a short run, making cache hits and invalidation costs hard to measure. The shared distribution in `@ecommerce-store/spec` aligns workload and dataset hot products.

Observed hit rates are much lower at `bench` scale than at `dev`. Whether this reflects a cold cache or a hot set too diffuse for the chosen skew remains open.

## Generator headroom

The generator must not become the bottleneck:

- Schedule arrivals incrementally; a materialized timeline consumes memory proportional to run length.
- Retain only needed sample fields, not response bodies or unused timing strings.
- Choose an in-flight ceiling appropriate to expected rate and latency. Excessive queuing can measure generator backlog instead of target behavior.
- Abort outstanding requests at step end so their completions cannot contaminate the next step.
