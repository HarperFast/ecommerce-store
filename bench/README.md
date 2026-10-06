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

Keys are drawn with skew because uniform draws make the cache unmeasurable. A uniform draw over the catalog crossed with tier and region spans a key space a short run almost never revisits, and the measured hit rate collapses to near zero. A cache nobody asks for twice cannot be measured, and neither can the cost of invalidating it — which silently takes `WRITE-003` and most of §6 out of reach without any test failing.

The skew is defined in `@ecommerce-store/spec` and shared with the dataset generator, so the dataset's hot products and the workload's hot products are the same products. A hot subset is what makes cache-hit rate mean anything.

Hit rate is far lower at `bench` scale than at `dev`, where the catalog fits in memory. Whether that is a cold cache over a much larger key space or a hot set too diffuse for the skew to concentrate is open — see `docs/plan.md`.

## Observations

Numbers this harness produces are recorded in [`docs/plan.md`](../docs/plan.md), with the conditions and caveats that apply to each. They are **not** repeated here: observations belong in one place, dated, beside the statement of what may not yet be claimed from them. A second copy drifts from the first.

**No run this harness has produced is a publishable result** — see the gaps above, and `docs/plan.md`'s "What may not be claimed yet".

## Keeping the generator out of the measurement

The rule the measurement rules press hardest: prove the load generator is not the bottleneck. Three properties of this harness exist for that, and each is easy to get wrong in a way no test catches.

- **Arrivals are not scheduled up front.** Materializing the whole timeline costs memory proportional to the run, and the generator dies before the target does.
- **Response bodies are not retained.** Only the fields actually read are kept per sample — notably not the `Server-Timing` string, when a single flag is all that is ever read from it. At `bench` scale aggregates run to tens of kilobytes, and a saturated step holds a great many at once.
- **The in-flight ceiling is a measurement choice, not just a safety valve.** A target serving a given rate at sub-second latency has roughly that many requests outstanding at steady state. A ceiling far above that queues work and measures the generator's own backlog rather than the target.

Abandoned requests are aborted at step end. Otherwise a saturated step's stragglers complete during the *next* step and are attributed to a rate they were never offered at.
