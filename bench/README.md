# Benchmark harness

The HTTP load harness exercises the specification's two endpoints and concurrent background writes. It can address another implementation, but only Harper exists today.

**No run is a publishable result.** Read [Limitations](#limitations) before interpreting output. The [benchmark methodology](https://github.com/HarperFast/application-architecture-benchmarks) governs all measurements and claims.

## Run

Use the [container workflow](../containers/README.md) to set resource limits and restore state between trials:

```bash
SCALE=dev ./containers/run-benchmark.sh
```

Local runs use `dev` only. `bench` runs only on the tier-2 Linux host or a platform as a service; see the [container workflow](../containers/README.md#run).

For local iteration against a running Harper instance:

```bash
node scripts/load-dataset.mjs --scale dev
node bench/run.mjs --duration 12
```

Direct runs have no fixed resource budget, snapshot restore, cold-start measurement, or target CPU figure. Their output is not a result.

`--rates` overrides the load ladder. The default targets the suspected saturation range at `bench` scale and is low for `dev`. The warm-up is fixed per scale (`WARMUP` in `@ecommerce-store/spec`); `--warmup-requests` and `--warmup-rate` override it for experiments, and a run whose warm-up differs fails verification.

## Data and output

`dev` is an in-memory fixture for development and CI, never a benchmark target. `bench` is the pinned benchmark dataset, designed to exceed target memory. See [dataset generation](../docs/seed-design.md) for storage, expansion, and checksum rules. Row counts and hashes come from each dataset's `MANIFEST.json`.

A run retains per-request samples and conditions in `bench/results/run-<timestamp>.json` by default: dataset scale, seed, checksums, host, harness settings, and caveats. Container runs write to the `bench-results` volume under `/results`.

## Implemented measurements

| Mechanism | Purpose and interpretation |
|---|---|
| Open load model | Issue arrivals on a fixed timeline regardless of outstanding requests, so the target cannot throttle offered load. |
| Arrivals | `bench` uses seeded Poisson arrivals: exponential gaps with the offered rate's mean, from a stream seeded per step, so every target gets the same arrival times and evenly spaced arrivals do not understate queueing. `dev` keeps evenly spaced arrivals; `--arrivals poisson\|uniform` overrides. Each step offers exactly its requests; a Poisson step can run slightly past its nominal length. |
| Published-run settings | `bench` steps last at least 60 s and the base images are pinned by digest (`PUBLISHED_RUN` in `@ecommerce-store/spec`, `x-base-images` in `compose.yaml`). Verification fails a `bench` record without them. |
| Load ladder | Locate the rate at which latency or errors exceed the target. A single saturating rate cannot locate that boundary. |
| Generator CPU | Record CPU per step. Above 0.8 of a core, flag the step and exclude it as a target measurement. |
| Dispatch lag | Record scheduled-arrival-to-dispatch lag per step (p50, p99, max). Above 5 ms at p99, the generator fell behind its own schedule. |
| Target CPU | Read the target's cgroup v2 `cpu.stat` at each step boundary, per container and summed (`targetCpuSeconds`, `targetComponents`). Container runs only; see [accounting](../containers/README.md#accounting). |
| Step boundaries | Record each step's wall-clock start, offer end, and drain end, so host-side samples can be joined to steps. |
| Cycles (tier 2) | [cycles.mjs](cycles.mjs) joins the tier-2 sampler's per-cgroup perf counts (250 ms) to each step's window, offer start to drain end, prorating the intervals its edges cut. Each step gets target and generator gigacycles, effective GHz (cycles ÷ CPU time), IPC, and ops per gigacycle (successful reads ÷ target gigacycles). Verification fails a tier-2 record with a step that has none. |
| In-flight ceiling | Shed and count read arrivals beyond the ceiling; a shed arrival still consumes its key draw, so the sequence stays identical across targets. Writes are outside the ceiling. |
| Achieved rate | Successful responses completed *inside* the offer window. A step is `saturated` when it shed arrivals or completed under 95% of the offered rate in the window; its achieved rate is then a floor, not a capacity. |
| Raw samples | Retain request samples for later distribution and interval analysis. |
| Background writes | Update inventory and prices through the application's write surface, exercising invalidation as well as reads. The stream is planned up front with the reads' distribution, so writes land on what is read (`WRITE-001`), and only the planned products' variants and inventory are loaded. Each write times out after 30 s and counts as failed. |
| Access skew | Draw every cart and product with the dataset's scrambled Zipf; weight tier and region to the seeded customer population. |
| Generator memory | Record the generator's peak RSS, heap, and container cgroup peak against its limit; it holds every cart and product id. |
| Cache behavior | Record the product endpoint's cache-hit rate (the quote is never cacheable) and the write surface's reported invalidations. Flag a zero hit rate, which may indicate the caching shortcut forbidden by `WRITE-003`. |
| Warm-up | A fixed number of requests at a fixed rate, from the same request stream as the ladder: 120,000 at 100 rps on `bench`, 2,000 at 200 rps on `dev`. Recorded with what it actually offered; verification fails a mismatch. |
| Connection pool | 32 keep-alive connections opened before the warm-up and used least-recently-used first (`--connections`). Few connections pin a multi-threaded target's work to the workers the kernel assigned them. |
| No compression | Request `accept-encoding: identity` and count encoded responses; any fails verification. |
| Partial records | Rewrite the run record after every step, so a generator that dies keeps the steps it finished (`complete: false`). |

## Limitations

- **No ground-truth correctness guard.** Every 2xx counts as success. Conformance checks determinism, but the harness does not compare responses with independently computed expected values. It needs pinned expected quotes derived from `SPEC.md`. Throughput currently says nothing about quote correctness.
- **CPU clock is not pinned.** Do not derive cycle-normalized efficiency (ops per CPU-gigacycle) from a tier-1 run. On tier 2 the clock is bounded and measured, and the cycle join gives each step its figures; it is tested against the qualification's per-CPU perf output, not yet against a real `sample.sh` capture.
- **Target CPU is CPU-seconds, not cycles.** It is the cgroup's `usage_usec` from offer start to drain end, which includes the drain of the step's own tail. Harper is one container, so its breakdown is one component; an assembled stack gets one per container.
- **No cross-target comparison.** The orchestrator implements resource limits, restore, and cold/warm/hot phases for one target. Identical treatment across implementations has not been demonstrated.
- **Run verification checks what the record carries.** The orchestrator runs `scripts/verify-run-record.mjs` after every trial; it cannot check what was never recorded, such as quote correctness.

Dated observations and unresolved behavior belong in [docs/plan.md](../docs/plan.md#first-bench-scale-observations-2026-10-05), not a results report. Nothing from `dev` is reportable.

## Access distribution

Uniform draws over product × tier × region rarely revisit a key during a short run, making cache hits and invalidation costs hard to measure. Too few reachable keys, or too much mass on one, measures a cache that holds everything. The shared distribution in `@ecommerce-store/spec`, stated in [SPEC.md](../SPEC.md#access-distribution), is a discrete Zipf (`s = 0.8845`) over every cart and product, scrambled so hot keys are spread across the id space: the hottest 1% of products take half the draws and the hottest one 2.6%.

## Generator headroom

The generator must not become the bottleneck:

- Schedule arrivals incrementally; a materialized timeline consumes memory proportional to run length.
- Retain only needed sample fields, not response bodies or unused timing strings.
- Choose an in-flight ceiling appropriate to expected rate and latency. Excessive queuing can measure generator backlog instead of target behavior.
- Abort outstanding requests at step end so their completions cannot contaminate the next step.
