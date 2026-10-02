# Benchmark harness

The load harness for this implementation, standalone. It drives the specification's two endpoints over HTTP and nothing else, so it can point at any implementation — but it is not yet generalized, and no competitive target has been built.

## Running

The supported path is containerized — see [`containers/README.md`](../containers/README.md), which fixes the resource budget, the networking mode, and the run lifecycle:

```bash
SCALE=dev ./containers/run-benchmark.sh
```

Directly against a local Harper, for iteration only:

```bash
node scripts/load-dataset.mjs --scale dev && node bench/run.mjs --rates 400,800,1600 --duration 12
```

## Datasets

| Scale | Rows | Stored | Use |
|---|---|---|---|
| `dev` | 46,583 | raw, committed | Local iteration. Loads in under 2s. **Never a benchmark target** — it fits entirely in memory, which is the one thing the benchmark dataset must not do. |
| `bench` | 40,656,446 | gzipped, committed | The benchmark. ~4.5 GB expanded, against a 2 GiB container. |

`bench` is committed compressed; `node scripts/prepare-dataset.mjs --scale bench` expands and verifies it. Checksums are always over the **uncompressed** bytes — dataset identity is about the data, not the transport.

Each step writes raw per-request samples to `bench/results/run-<timestamp>.json`, alongside the exact run conditions: dataset scale, seed and per-file checksums, host, harness settings, and the caveats that apply to that run.

## What it implements

From the measurement rules in the benchmarks README:

- **Open load model.** Arrivals are paced against a fixed timeline and issued whether or not earlier requests have returned. A closed loop lets the target throttle the load offered to it, which hides the saturation behaviour being looked for.
- **Load ladder.** A single saturating rate produces no inflection point. The reportable result is "sustains N rps before p99 crosses T", which requires the ladder.
- **Generator headroom.** The generator's own CPU is recorded per step. Above 0.8 of a core the step is flagged and must not be reported as a target measurement.
- **In-flight ceiling.** Past the ceiling, arrivals are *shed* and counted. A step that sheds exceeded the target's capacity — its achieved rate is a lower bound, not a measurement.
- **Raw samples retained**, so intervals can be applied later without re-running.
- **Correctness guards.** The quote is deterministic by construction (`QUOTE-008`), which is the ground-truth check: a throughput-only benchmark reports a silently wrong quote as a result.
- **Background writes** run concurrently with reads, so caches have to stay coherent rather than filling once and never invalidating. Writes go through the application's write surface, not the datastore — a direct write invalidates nothing, and the coherence cost is the point.
- **A real access skew.** Keys are drawn from the distribution defined in `@ecommerce-store/spec` — the same one the dataset was built against, so the dataset's hot products and the workload's hot products are the same products. Tier and region are weighted to the seeded customer population rather than drawn uniformly.
- **Measured cache-hit rate and invalidation fan-out**, recorded per step. A hit rate of zero is flagged: that is what `WRITE-003`'s forbidden shortcut — achieving freshness by disabling caching — looks like in the numbers.

## What it does NOT implement — and what therefore may not be claimed

- **CPU clock is not pinned.** No cycle-normalized efficiency figure (ops per CPU-gigacycle) may be derived from any run this harness has produced. The rules require pinning and the measurement is not currently trustworthy without it.
- **No containerization.** Every target must be containerized identically, with the networking mode recorded, before any cross-target comparison. Container networking costs real latency and that difference alone can exceed the architectural difference being measured.
- **No per-target CPU breakdown.** Harper is one process so the split that matters in an assembled stack (framework vs database vs cache) has no analogue yet. `targetCpuSeconds` is captured but is a single number.
- **No cold-start measurement.** The run lifecycle wants cold, warm and hot as three separate numbers. The harness reports the warm-up's first response, which is not the same thing.
- **No trial restore.** The workload includes writes, so state does not survive between trials. Every trial should start from a restored dataset; right now it does not, so repeated runs drift.

## Why the access distribution is load-bearing

An earlier version drew keys uniformly over 20,000 products x 4 tiers x 4 regions — a 320,000-key space a short run almost never revisits. Measured cache-hit rate was **2.5%**. A cache nobody asks for twice cannot be measured, and neither can the cost of invalidating it, so `WRITE-003` and most of §6 were unmeasurable without anyone noticing.

With the shared skew (1% of the catalog takes 50% of traffic) the same workload measures **77.7% at 200 rps rising to 89.3% at 2000 rps**. Nothing about the application changed.

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
