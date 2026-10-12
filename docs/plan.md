# Development plan

**Last updated:** 2026-10-12 · **Spec version:** `0.2.0-draft` · **Harper:** `5.3.2`

This file tracks status, blockers, and observations. [README.md](../README.md) introduces the application. Requirement ids live in [SPEC.md](../SPEC.md) and its registry; coverage comes from `npm run check`; dataset counts and hashes come from each `MANIFEST.json`.

## Project boundaries

| Repository | Responsibility |
|---|---|
| `application-architecture-benchmarks` | Binding methodology, measurement rules, competitor implementations |
| `ecommerce-store` | Reference implementation, specification, and conformance suite |
| Dated snapshot repos | Published comparison results |

Results are never published from this repo.

## Status

| Piece | State |
|---|---|
| Specification | Draft, with two rounds of cross-model review applied. Review gate remains open; [Conformance](../SPEC.md#conformance) is the authoritative gate record. |
| Schema and caching | Eight entities plus derived `ProductView`, keyed by product × tier × region; invalidation after the write commits, with an expiry backstop. Secondary indexes only where queried. Lookup-table memos expire within `FRESH_MS`. |
| Write surface | `POST /admin/variant/:sku` and `POST /admin/inventory/:id` write and invalidate. |
| Endpoints | Quote and product aggregate built and covered by conformance tests. Both emit data, compute, and total. |
| Background writer | Harness-side only; no in-application writer. |
| Datasets | `dev` in plain git, `bench` in Git LFS; checksum-verified before loading. |
| Conformance | Every MUST has declared coverage; execution and assertion gaps remain below. |
| Harness and containers | Load ladder, 2 CPU / 2 GiB target, snapshot restore with provenance, per-step target CPU from cgroups, run-record verification after every trial, tier-2 placement override. No complete `bench` ladder yet. |
| CI | Repo checks and conformance on pushes and pull requests; LFS pulled only for dataset changes. Both jobs last recorded passing. |

## Recent work

- **2026-10-12 — Harper 5.3.2 and benchmark readiness** (branch `harper-5.3`):
  - **Upgrade.** Harper 5.2.12 → 5.3.2. The global install fails on `node:24-slim` without Python since 5.3.2 dropped its shrinkwrap, and msgpackr-extract's linux-arm64 prebuilt ships only musl binaries, so on glibc arm64 msgpackr silently decoded in pure JS. **The 5.2.12 image ran that way on every tier-1 run.** The image now compiles it and refuses to build without native acceleration. Install and thread configuration match 5.3.2's deploy path.
  - **Cache coherence.** Three ways a product view outlived a write, each now fixed: the invalidation shared the write's transaction and lost to fills stamped later (Harper orders by transaction *start*); queued fills read through another fill's transaction because Harper 5.3.2's fill queue carries the first fill's async context; and invalidations could be cancelled after the write was durable. Unknown tiers and regions no longer mint unevictable views. [verify-coherence.mjs](../scripts/verify-coherence.mjs) reproduced the first in 3 of 9 runs and now runs in CI.
  - **Harness measurement bugs.** Every arrival was dispatched one inter-arrival interval late, adding +40 ms at 25 rps down to +5 ms at 200 rps. Achieved rate credited completions drained after the offer window, so a target that fell behind could report the offered rate. Container runs recorded no target CPU; it now comes from the target's cgroup. 77% of `bench` write mass missed the products the reads sample (`WRITE-001`); write keys now derive from the read sample. Few keep-alive connections pinned two-thirds of Harper's work to one of its two workers; the generator now rotates a fixed pool of 32. Requests ask for no compression; product-only hit rate; partial records survive a generator crash.
  - **Orchestrator.** Clean seeding into an emptied volume; restore before every trial; cold start probed from the host with no in-target healthcheck; `PRE_START_HOOK`; `COMPOSE_EXTRA` with a tier-2 placement override; snapshot provenance; `TRIALS=0`; failed trials counted, not fatal; target stopped on exit; `verify-run-record.mjs` after every trial.
  - **Application.** Product compute phase (`OBS-001`); cache status from Harper's `loadedFromSource`; lookup memos bounded by expiry (`CACHE-002`); eleven unqueried secondary indexes dropped; pricing corrected where the dataset never reached it (BOGO threshold, integer largest remainder, fail-loud rate matching), with identical totals on every `dev` and `bench` cart.
  - **Seeded.** A 5.3.2 `bench` snapshot with provenance: 40,656,446 rows loaded in 1,116 s; 1.26 GB compressed against 1.61 GB for the 5.2 snapshot with every index.

- **2026-10-09 — Documentation edit:** shortened guides, removed duplicated schema and rationale, and clarified existing measurement and coverage limits. No application, requirement semantics, or dataset changes.
- **2026-10-09 — Check repair:** the specification anchor checker now skips nested Git repositories and worktrees. Regression tests run with `check:anchors` and verify that broken links in this checkout still fail.

Validation: full `npm run check` passes in this checkout, including deployment simulation, with npm cache write access granted outside the sandbox. Local link and diff checks also pass. This does not change the last recorded CI status.

## Next

1. **Run `bench`-scale ladders on a clean window, then on tier 2.** One contended trial completed on 2026-10-12 (below). A 5.3.2 `bench` snapshot with provenance exists (`containers/.snapshots/bench-harper-5.3.2.tar.gz` in the main checkout); `SKIP_LOAD=1` restores it. Decide the key sample size first: at 20,000 keys per table the working set fits in the target's memory.
2. **Add independent expected values.** Build a correctness suite keyed to the dataset manifest checksum. Conformance checks shape and consistency; the harness also needs expected quotes derived independently from the implementation under test. Publish expected values as data so every stack compares against the same answers without sharing pricing code.
3. **Confirm `FRESH_MS`.** The provisional budget in [Background writes](../SPEC.md#background-writes) needs run evidence; `PDP-003` and `WRITE-002` depend on it.
4. **Add an in-application background writer.** The harness currently drives writes through the application write surface. This exercises coherence but differs from application-owned background work.

## External dependencies

| Need | Owner |
|---|---|
| Linux host for controlled measurements; macOS Podman's VM complicates resource limits, networking, and clock control | Maintainers |
| Outstanding specification reviews | Maintainers; status in [Review gate](../SPEC.md#review-gate) |
| Sanity-check the invented promotion evaluation order | Reviewer with pricing-engine experience |
| Answer the [OAuth scope question](questions/oauth-authorization-server-scope.md), drafted but unsent | `@harperfast/oauth` maintainers; not blocking P0 |

## Bench-scale observations on 5.3.2 (2026-10-12)

**Tier-1 signal, contaminated, not results.** One trial on Harper 5.3.2 with this branch's harness, restored from the 5.3.2 snapshot, on the shared Podman VM. Another agent's Harper target and generator were running throughout (recorded in the run's `otherContainersRunning`). The clock was neither pinned nor measured. Run-record verification passed.

| Offered rps | Achieved rps | p50 ms | p90 ms | p99 ms | Quote p50 / p99 | Product p50 / p99 | Target CPU (cores) | Product hit |
|---|---|---|---|---|---|---|---|---|
| 25 | 25.0 | 20.5 | 33.1 | 76.0 | 25.2 / 78.2 | 4.4 / 17.3 | 0.48 | 2.3% |
| 50 | 50.0 | 20.4 | 44.8 | 380.3 | 28.6 / 460.7 | 4.1 / 73.0 | 0.87 | 5.6% |
| 75 | 75.0 | 21.2 | 63.8 | 327.2 | 35.4 / 549.3 | 3.9 / 48.8 | 1.08 | 10.4% |
| 100 | 99.9 | 21.0 | 130.2 | 725.4 | 57.5 / 811.0 | 4.1 / 31.6 | 1.33 | 11.6% |
| 125 | 120.0 | 207.3 | 796.1 | 1,136.6 | 396.1 / 1,169.5 | 31.7 / 483.8 | 1.75 | 17.6% |
| 150 | 147.1 | 166.6 | 607.2 | 889.8 | 378.4 / 926.5 | 22.5 / 447.1 | 1.83 | 19.2% |
| 200 | 142.2 (saturated) | 3,674.1 | 4,438.9 | 4,765.5 | 3,850 / 4,811 | 3,458 / 4,408 | 1.98 | 19.6% |

Cold start to first successful response was 2,369 ms. Target CPU per successful request fell from about 19 ms at 25 rps to 12–14 ms at 100 rps and above. The target reached its 2-CPU budget at 200 rps, so it saturates on CPU, not I/O. Quotes, not product views, set the knee.

What this run does **not** show:

- **`DATA-004`.** The target cgroup's memory, page cache included, peaked at 725 MiB of 2 GiB. The sample of 20,000 keys per table, under the skew, reaches far less than the catalog, so this ladder's working set fit in memory. A run that is to support `DATA-004` needs a larger key sample, a longer run, or both. That is a workload decision.
- **Steady state.** The product hit rate climbs from 2% to 20% across the ascending ladder; see the warm-up item in Open.

### Harper 5.2.12 against 5.3.2 on `dev` (2026-10-12)

Same branch code, interleaved arms (5.3.2, 5.3.2 with msgpackr acceleration disabled, 5.2.12; twice each), `dev`, 400/800/1600 rps for 20 s, with the other agent's containers running throughout. Target CPU per successful request ranged 1.2–2.0 ms at 400 rps, 0.9–1.2 ms at 800, and 0.8–1.0 ms at 1,600 across all arms. The spread between repeats of one arm was as large as any difference between arms, so **no version or acceleration effect is measurable here**. `dev` is served from Harper's in-process record cache, so record decoding, where msgpackr's native path matters, is rare; a difference, if any, would show at `bench`. Cold start was 1.9–2.2 s for every arm.

## First bench-scale observations (2026-10-05)

**Incomplete exploratory run, not results.** The generator exhausted its heap after three steps, was under pressure throughout, and ran without a pinned clock. These samples do not establish target capacity or efficiency. They were taken on Harper 5.2.12 without msgpackr native acceleration, every latency includes one inter-arrival interval of dispatch artifact (+10 ms at 100 rps, +5 ms at 200, +2.5 ms at 400), and no target CPU was recorded.

| Offered rps | Achieved rps | p50 ms | p90 ms | p99 ms | Errors | Cache hit |
|---|---|---|---|---|---|---|
| 100 | 99.9 | 29.2 | 94.1 | 369.8 | 0 | 18.4% |
| 200 | 199.4 | 274.1 | 29,470 | 31,382 | 10 | 26.9% |
| 400 | 166.1 | 50.6 | 11,787 | 22,410 | 1,369 | 33.5% |

The recorded cold-start probe interval was **3,056 ms**; it shares the run's limitations.

Follow-up hypotheses:

- The behavior between 100 and 200 offered rps motivated a lower default ladder. A complete run with generator headroom must locate the actual saturation boundary.
- The much lower achieved rates than the 2,000+ rps observed on `dev` may reflect a working set exceeding memory. These runs do not establish a valid ratio or verify `DATA-004`.
- Cache hits rose from 18% to 33%, compared with 77% in an early `dev` step. Investigate cold-cache effects versus a hot set too diffuse for the catalog size.
- The p90/p99 near 30 s at 200 rps match the 30–60 s long-transaction sweep that, before 5.3.1, released a disconnected request's write locks ([harper#2047](https://github.com/HarperFast/harper/pull/2047)); the harness aborts outstanding requests at each step's end. Unverified; recheck on 5.3.2.

## Open

| Gap | Needed action or decision |
|---|---|
| **No ground-truth guard.** The harness counts every 2xx as success. Determinism does not prove correctness. | Add pinned, independently computed expected quotes; see Next. |
| **Pricing phases are unevenly exercised.** Exclusive and threshold promotions each reach roughly half of `dev` carts; BOGO and stackable discounts barely register under the shared 60% cap. | Decide between changing the cap, narrowing cart-wide eligibility, or changing order. Each changes the workload and requires coordinated dataset regeneration. |
| **Promotion-index benefit is unmeasured.** Sentinel probes pass completeness checks and narrow candidates, but are marginally slower than a scan on `dev`. | Measure at `bench` scale before claiming a benefit; quote fan-out may still dominate. |
| **Unexplained `dev` latency.** One step had p90 in seconds; a higher step had single-digit milliseconds. Quotes were slow, not products. | Recheck on 5.3.2 with the dispatch fix; see the 2026-10-05 hypothesis about pre-5.3.1 write-lock release. |
| **The write surface and response details are specified by tests, not `SPEC.md`.** The harness and suite require `POST /admin/variant/:sku` `{basePrice}`, `POST /admin/inventory/:id` `{onHand}`, an `invalidated` count in each write response, the `Server-Timing` grammar (`cache;desc=hit\|miss`, `data`, `compute`, `total`), and quote fields (`currency`, `region`, `taxJurisdiction`, `totalWeight`) that only [model.ts](../packages/spec/src/model.ts) names. | Specify them, or name `packages/spec` as normative, before a second implementation is built against the prose. |
| **Metric definitions differ across stacks.** `invalidated` counts keys targeted (Harper writes an invalidation marker even for a never-cached key); a Redis `DEL` count is keys removed. Harper reports a request that waited on another request's in-flight fill as a hit. `total` excludes response serialization in both handlers. | Define each in `SPEC.md` so cache-hit rates and invalidation fan-out compare. |
| **The reachable working set fits in memory.** 20,000 sampled keys per table, under the skew, kept the 2026-10-12 `bench` ladder's target cgroup at 725 MiB of 2 GiB. `verify-run-record.mjs` checks `DATA-004` only by labels. | Decide the key sample (all 300,000 carts and 2,000,000 product ids fit in the generator) and record memory against the budget; then check `DATA-004` on evidence. |
| **One key takes 22.5% of draws.** The access skew's continuous power law gives index 0 a mass of (1/n)^(1/α): 22.5% of product reads, quotes, and writes at n = 20,000 and 32% at `dev`. The workload partly measures one hot row and one hot view. | Decide deliberately (a discrete Zipf, or a per-key cap) and disclose. Carts are built with the same function, so changing it regenerates the dataset. |
| **Warm-up is 10 s at the first rate.** About 250 requests against 320,000 views; hit rates climb across an ascending ladder, so later steps run warmer. | Decide a fixed warm-up by request count, identical across targets, and re-run the first rate at the end to measure drift. |
| **Arrivals are evenly spaced.** Deterministic spacing understates queueing against Poisson arrivals at the same utilization. | Decide whether to offer seeded Poisson arrivals. |
| **Network softirq is not charged to a cgroup.** Bridge traffic between a separated stack's containers is partly unaccounted, and on tier 2 may run outside the target's CPUs; Harper has no such hops. | On tier 2, record per-step softirq for the target CPUs, or steer bridge interrupts onto them; disclose either way. |
| **Duplicate SKU lines allocate inventory twice.** Promotions merge lines by SKU; availability does not, so a repeated SKU understates `shortfall`. The dataset has no such carts. | Clarify in `SPEC.md` whether lines merge for availability and in the response. |
| **No cycle join.** Steps carry wall-clock boundaries; nothing yet turns tier-2 host samples into per-step gigacycles or effective frequency. | A small join script, with the shared harness. |
| **Base images are tags.** `node:24`, `node:24-slim` float; the run records the target image id but not base digests. | Record digests every trial; pin them for a published run. |
| **Steps are 15 s.** At tier-2's 250 ms sampling, boundary error is up to ~3% of a step. | Longer steps for published runs, or state the error. |
| **Tier-2 limits inside the slice.** `compose.tier2.yaml` keeps the container's CPU quota and memory limit; the tier-2 procedure discourages per-container quotas. Harper sizes its block cache and heaps from its own cgroup's memory limit. | Decide; see the questions in the 2026-10-12 report. |
| **Harper 5.3.2: a `static` verb override is permission-checked on its first table read.** REST leaves `authorize` set, so a static custom resource reading a table answers 401 to anonymous callers, though server-side reads are documented as trusted. The endpoints stay instance-style. | Report upstream; convert to static verbs once fixed. |
| **Harper 5.3.2: queued cache fills run in the first fill's async context** (`server/throttle.ts`), so a resolver's ambient table reads join another fill's transaction. The resolver passes its context explicitly. | Report upstream. |
| **Harper 5.3.2 packaging.** The global install needs Python on glibc images, and msgpackr-extract's linux-arm64 prebuilt lacks glibc binaries. The Dockerfile works around both. | Report upstream (Harper; msgpackr-extract). |
| **Host-side Node.** `prepare-dataset.mjs` and `load-dataset.mjs` run on the host. | None required; containerize if a host without Node appears. |

## Open decisions

- **Tier multipliers:** currently normative in [Resolved unit price](../SPEC.md#resolved-unit-price). Moving them into `rate` rows with `kind: 'tier'` would pin them in the dataset and remove unchecked duplication between pricing code and seed vocabulary. Coordinate any regeneration with the pricing-phase decision.
- **Facet counting:** three options remain open in [future work](future-work.md#product-listing-facets-and-search).
- **Promotion lookup:** compare indexed array probes with a combined key at benchmark scale; see [data model](data-model.md#open).
- **Write durability across stacks:** `SPEC.md` does not say whether an acknowledged background write must survive a crash, or whether caches may be volatile. Harper's cache rows are written through the same durable path as its source of truth; Redis need not be.
- **Unknown query values:** the product endpoint answers 400 for an unknown region and prices an unknown tier as `standard`. `SPEC.md` specifies only the tier rule.
- **`@export` on the eight tables:** a super-user REST surface no comparison measures, and a write path that bypasses invalidation. Keep, or remove so the write surface is the only one.
- **The 5.2 `bench` snapshot** (`containers/.snapshots/bench.tar.gz`, no provenance, every index) cannot be restored under 5.3.2 without `ALLOW_UNVERIFIED_SNAPSHOT=1`. Delete once a 5.3.2 ladder has run.
- **Dataset distribution:** retain Git LFS for now. Reconsider release assets, which are deletable and unmetered, if dataset size, regeneration frequency, or clone volume grows.

## What may not be claimed yet

- **Correctness from a run:** the harness has no ground-truth guard.
- **Cycle-normalized efficiency:** the CPU clock is not pinned.
- **Cross-target comparisons:** only one implementation exists.
- **Component CPU breakdowns:** Harper is one container; per-container accounting exists but no assembled stack has been measured.
- **Benchmark results from `dev`:** it fits in memory.
- **Latency or target CPU from runs before 2026-10-12:** latency carries the dispatch artifact, target CPU was never recorded, and 5.2.12 images ran without msgpackr native acceleration.

[bench/README.md](../bench/README.md#limitations) describes the harness limits. No run produced here is publishable.
