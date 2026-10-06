# Benchmark harness

The load harness for this implementation, standalone. It drives the specification's two endpoints over HTTP and nothing else, so it can point at any implementation — but it is not yet generalized, and no competitive target has been built.

## Running

The supported path is containerized — see [`containers/README.md`](../containers/README.md), which fixes the resource budget, the networking mode, and the run lifecycle:

```bash
SCALE=dev ./containers/run-benchmark.sh
```

Directly against a local Harper, for iteration only:

```bash
node scripts/load-dataset.mjs --scale dev && node bench/run.mjs --duration 12
```

`--rates` overrides the ladder. The default is chosen to bracket the inflection at `bench` scale, so it is deliberately low for `dev`.

## Datasets

| Scale | Stored | Use |
|---|---|---|
| `dev` | raw, committed | Local iteration. Loads in seconds. **Never a benchmark target** — it fits entirely in memory, which is the one thing the benchmark dataset must not do. |
| `bench` | gzipped, committed | The benchmark. Expands to several times the target container's memory budget, which is what `DATA-004` is for. |

Row counts and checksums live in each dataset's `MANIFEST.json` and are verified before every load. They are not repeated here: the manifest is the contract, and a second copy of it is a second thing to be wrong.

`bench` is committed compressed; `node scripts/prepare-dataset.mjs --scale bench` expands and verifies it. Checksums are always over the **uncompressed** bytes — dataset identity is about the data, not the transport.

Each step writes raw per-request samples to `bench/results/run-<timestamp>.json`, alongside the exact run conditions: dataset scale, seed and per-file checksums, host, harness settings, and the caveats that apply to that run.

## What it implements

From the measurement rules in the benchmarks README:

- **Open load model.** Arrivals are paced against a fixed timeline and issued whether or not earlier requests have returned. A closed loop lets the target throttle the load offered to it, which hides the saturation behaviour being looked for.
- **Load ladder.** A single saturating rate produces no inflection point. The reportable result is "sustains N rps before p99 crosses T", which requires the ladder.
- **Generator headroom.** The generator's own CPU is recorded per step. Above 0.8 of a core the step is flagged and must not be reported as a target measurement.
- **In-flight ceiling.** Past the ceiling, arrivals are *shed* and counted. A step that sheds exceeded the target's capacity — its achieved rate is a lower bound, not a measurement.
- **Raw samples retained**, so intervals can be applied later without re-running.
- **Background writes** run concurrently with reads, so caches have to stay coherent rather than filling once and never invalidating. Writes go through the application's write surface, not the datastore — a direct write invalidates nothing, and the coherence cost is the point.
- **A real access skew.** Keys are drawn from the distribution defined in `@ecommerce-store/spec` — the same one the dataset was built against, so the dataset's hot products and the workload's hot products are the same products. Tier and region are weighted to the seeded customer population rather than drawn uniformly.
- **Measured cache-hit rate and invalidation fan-out**, recorded per step. A hit rate of zero is flagged: that is what `WRITE-003`'s forbidden shortcut — achieving freshness by disabling caching — looks like in the numbers.

## What it does NOT implement — and what therefore may not be claimed

- **No ground-truth correctness guard.** Every 2xx is counted as a success; no response is compared against an expected value computed independently of the implementation under test. Determinism (`QUOTE-008`) is checked and is necessary, but it is not sufficient and must not be described as if it were: **a consistently wrong answer is deterministic too.** Closing this needs pinned fixtures carrying expected quotes, derived from `SPEC.md` rather than from this implementation's output. Until then a throughput number from this harness says nothing about whether the quotes were right.
- **CPU clock is not pinned.** No cycle-normalized efficiency figure (ops per CPU-gigacycle) may be derived from any run this harness has produced. The rules require pinning and the measurement is not currently trustworthy without it.
- **No per-target CPU breakdown.** Harper is one process so the split that matters in an assembled stack (framework vs database vs cache) has no analogue yet. `targetCpuSeconds` is captured but is a single number.
- **Nothing to be identical *to*.** Containerization, trial restore and the cold/warm/hot split are implemented by the orchestrator (see [`containers/README.md`](../containers/README.md)) — but there is one target, so "containerized identically for every target" is true only because the set has one member. It becomes a real constraint, and a real risk, when a second target exists.

Run `bench/run.mjs` directly and you get none of the orchestrator's guarantees: no fixed resource budget, no snapshot restore between trials, no cold-start measurement. That path is for iteration, and its output is not a result.

## Why the access distribution is load-bearing

An earlier version drew keys uniformly over 20,000 products x 4 tiers x 4 regions — a 320,000-key space a short run almost never revisits. Measured cache-hit rate was **2.5%**. A cache nobody asks for twice cannot be measured, and neither can the cost of invalidating it, so `WRITE-003` and most of §6 were unmeasurable without anyone noticing.

With the shared skew (1% of the catalog takes 50% of traffic) the same workload measured **77.7% rising to 89.3%** across the ladder. Nothing about the application changed. Both of those figures are `dev`-scale, where the catalog fits in memory; at `bench` scale the hit rate is far lower, which is its own open question rather than a regression.

## Observations

Numbers this harness has produced are recorded in [`docs/plan.md`](../docs/plan.md), with the conditions and the caveats that apply to each. They are **not** repeated here.

That is deliberate. An earlier version of this file carried its own ladder table, which went stale the moment the dataset was re-ranged and then sat here misreporting the target's capacity by an order of magnitude. Observations belong in one place, dated, next to the statement of what may not yet be claimed from them.

**No run this harness has produced is a publishable result** — see the gaps above, and `docs/plan.md`'s "What may not be claimed yet".

## Known harness history

The generator has been the failure point three times, which is the specific thing the measurement rules warn about:

1. **Scheduled every arrival up front** with `setTimeout` and exhausted memory at high rates.
2. **Buffered every response body**, and failed the same way once the target saturated.
3. **Held too much in flight at `bench` scale.** The in-flight ceiling was set as a safety valve, without noticing it is also a measurement choice: a ceiling far above the target's steady-state outstanding count queues work and measures the generator's own backlog rather than the target. It also retained a per-request `Server-Timing` string when only one flag is ever read from it.

All three are fixed. They are recorded because "prove the load generator is not the bottleneck" is a rule that has earned its place here once per rewrite, and the third one got through two rounds of review before a `bench`-scale run found it.

Fixing (3) also surfaced that abandoned requests were not aborted at step end, so a saturated step's stragglers completed during the *next* step and were attributed to a rate they were never offered at.
