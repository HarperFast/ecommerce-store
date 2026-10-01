# Benchmark harness

The load harness for this implementation, standalone. It drives the specification's two endpoints over HTTP and nothing else, so it can point at any implementation — but it is not yet generalized, and no competitive target has been built.

## Running

Harper must be up with the dataset loaded:

```bash
node scripts/load-dataset.mjs
```

```bash
node bench/run.mjs --rates 400,800,1200,1600,2400 --duration 12
```

Each step writes raw per-request samples to `bench/results/run-<timestamp>.json`, alongside the exact run conditions: dataset scale, seed and per-file checksums, host, harness settings, and the caveats that apply to that run.

## What it implements

From the measurement rules in the benchmarks README:

- **Open load model.** Arrivals are paced against a fixed timeline and issued whether or not earlier requests have returned. A closed loop lets the target throttle the load offered to it, which hides the saturation behaviour being looked for.
- **Load ladder.** A single saturating rate produces no inflection point. The reportable result is "sustains N rps before p99 crosses T", which requires the ladder.
- **Generator headroom.** The generator's own CPU is recorded per step. Above 0.8 of a core the step is flagged and must not be reported as a target measurement.
- **In-flight ceiling.** Past the ceiling, arrivals are *shed* and counted. A step that sheds exceeded the target's capacity — its achieved rate is a lower bound, not a measurement.
- **Raw samples retained**, so intervals can be applied later without re-running.
- **Correctness guards.** The quote is deterministic by construction (`QUOTE-008`), which is the ground-truth check: a throughput-only benchmark reports a silently wrong quote as a result.
- **Background writes** run concurrently with reads, so caches have to stay coherent rather than filling once and never invalidating.

## What it does NOT implement — and what therefore may not be claimed

- **CPU clock is not pinned.** No cycle-normalized efficiency figure (ops per CPU-gigacycle) may be derived from any run this harness has produced. The rules require pinning and the measurement is not currently trustworthy without it.
- **No containerization.** Every target must be containerized identically, with the networking mode recorded, before any cross-target comparison. Container networking costs real latency and that difference alone can exceed the architectural difference being measured.
- **No per-target CPU breakdown.** Harper is one process so the split that matters in an assembled stack (framework vs database vs cache) has no analogue yet. `targetCpuSeconds` is captured but is a single number.
- **No cold-start measurement.** The run lifecycle wants cold, warm and hot as three separate numbers. The harness reports the warm-up's first response, which is not the same thing.
- **No trial restore.** The workload includes writes, so state does not survive between trials. Every trial should start from a restored dataset; right now it does not, so repeated runs drift.

## Current numbers, and why they are not a result

A first local ladder against Harper 5.2.12, dataset scale `bench` (6.8M rows), 50/50 quote/product mix with 20 writes/sec:

| Offered rps | Achieved | p50 | p90 | p99 |
|---|---|---|---|---|
| 400 | 399.8 | 2.3 | 4.2 | 7.7 |
| 800 | 799.9 | 2.2 | 4.3 | 10.3 |
| 1200 | 1199.5 | 3.0 | 8.2 | 37.1 |
| 1600 | 1386.9 | 29.8 | 1765.8 | 1875.9 |
| 2400 | 1385.1 (shed) | 257.0 | 5345.8 | 5550.1 |

The knee sits between 1200 and 1600 rps, with throughput plateauing around 1390.

**This is not a publishable result.** Beyond the gaps above, it was produced under `harper dev`, which runs **one worker thread** — a development configuration, not a benchmark configuration. The number is a single-threaded floor and says nothing about the platform's capacity. It is recorded here because it proves the harness works end to end and locates the inflection, which is what a rough cut is for.

## Known harness history

The first version scheduled every arrival up front with `setTimeout` and exhausted memory at high rates — the generator failing before the target. The second buffered every response body and failed the same way once the target saturated. Both are fixed; both are recorded because "prove the load generator is not the bottleneck" is a rule that earned its place here twice in one afternoon.
