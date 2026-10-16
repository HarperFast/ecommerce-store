# Development plan

**Last updated:** 2026-10-16 · **Spec version:** `0.2.0-draft` · **Harper:** `5.3.2` · **Dataset generator:** `0.5.0`

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
| Datasets | Generator `0.5.0`: carts drawn from a scrambled discrete Zipf. `dev` in plain git, `bench` in Git LFS; checksum-verified before loading. |
| Conformance | Every MUST has declared coverage; execution and assertion gaps remain below. |
| Harness and containers | Load ladder, 2 CPU / 2 GiB target, snapshot restore with provenance, per-step target CPU from cgroups, run-record verification after every trial. For tier 2: slice placement, per-step cycles joined from the host's sampler, a second build of the target by commit (`TARGET_REF`), and published-run settings (60 s steps, seeded Poisson arrivals, base images pinned by digest). The first tier-2 sessions (2026-10-15/16) are recorded in [application-architecture-benchmarks#8](https://github.com/HarperFast/application-architecture-benchmarks/pull/8), not here. |
| CI | Repo checks and conformance on pushes and pull requests; LFS pulled only for dataset changes. Both jobs last recorded passing. |

## Recent work

- **2026-10-16 — Per-wave Server-Timing, for diagnostics** (Ethan: no-spend fairness work; this branch). With `SERVER_TIMING_WAVES=1`, a quote adds one entry per read wave: `cart`, `lookups`, `customer`, `variants`, `inventory`, `products` and `promotions`, the last with its probe and candidate counts. A product miss adds `product`, `variants`, `lookups`, `inventory`, `related` and `assembly`. Each wave is timed from issue to settle, so overlapping waves overlap. The flag is off by default, so a measured run executes the same reads, and `run-benchmark.sh` refuses measured trials with it on. `cache`, `data`, `compute` and `total` are unchanged, and quotes are identical with it on and off. On `dev` carts with the dataset `0.5.0` `bench` promotions (tier 1, combined promotion key), the `promotions` wave was 1.3 of the quote's 1.42 ms of reads at the median; every other wave was under 0.1 ms.

- **2026-10-16 — Promotion candidates by a combined key** (investigating the finding in [application-architecture-benchmarks#8](https://github.com/HarperFast/application-architecture-benchmarks/pull/8) that the reference's `bench` quote spends a median 19.1 ms reading at tier 2; this branch). `collectPromotions` ANDed two indexed `in` conditions, and Harper 5.3.2 answers `in` by walking the attribute's whole index, so with `bench`'s 5,000 promotions the lookup took 13 of a tier-1 quote's 14 ms of reads. Promotions now carry a computed, indexed `eligibilityKeys`, one key per (tier key, category key) pair, and the quote probes the pairs its cart can match. On `dev` carts with the `bench` promotions, the quote's reads fell from 14.0 to 1.6 ms median; on `dev`, from 1.0 to 0.4 ms. Quotes are identical, the dataset is unchanged, and the two single-dimension indexes are dropped. Rows with missing or empty keys index as unrestricted, so the index stays a superset. Details in [promotion candidates on `bench`](#promotion-candidates-on-bench-2026-10-16). Upstream, the `in` walk is [harper#3240](https://github.com/HarperFast/harper/issues/3240) (milestone v5.4) and the per-row yields [harper#3241](https://github.com/HarperFast/harper/issues/3241). Ethan's ruling: the reference reads candidates per quote from the source of truth, with no in-memory promotion index, and does not use `in` until [harper#3240](https://github.com/HarperFast/harper/issues/3240) ships.

- **2026-10-15 — Ready for the first tier-2 session** (Ethan: Harper against Fastify + Postgres + Redis on GCP; checked against application-architecture-benchmarks `origin/gcp-tier2` at `68b7a3c`):
  - **Placement.** `compose.tier2.yaml` matches `host-setup.sh`: the target in `bench.slice/bench-target.slice` (CPUs 2–3, 2 GiB, no swap), the generator in `bench-generator.slice` (CPUs 4–7). A container cannot see its slice's limits, so Harper keeps its own 2 GiB limit to size its caches from; its CPU quota is dropped. Verification fails a tier-2 record whose target ran outside the slice or without a memory limit.
  - **Cycle join.** [cycles.mjs](../bench/cycles.mjs) joins `sample.sh`'s per-cgroup perf counts to each step: target and generator gigacycles, effective GHz, IPC, ops per gigacycle. The orchestrator runs it when `SAMPLES_DIR` is set; verification fails a tier-2 step without cycles.
  - **Two builds in one session.** `TARGET_REF=dd3a5f5^` builds the target before quote batching from that commit's tree with the checkout's Dockerfile, as its own image, against the same snapshot. Each record names its build.
  - **Published-run settings.** `bench` steps last 60 s, arrivals are seeded Poisson, and both base images are pinned by multi-arch digest (`PUBLISHED_RUN`, `x-base-images`). Verification fails a `bench` record without them.
  - **From wiring the Fastify orchestration.** `DATA-004`'s memory evidence is judged per cgroup against its own limit, with reads in every step, so a split budget is not penalized ([rule](../bench/README.md#data-004-memory-evidence)). The orchestrator refuses a checkout without the installed workspace. `TARGET_IMAGE` names the target image per compose project.
  - **Untested until the Linux host:** see [Open](#open).

- **2026-10-15 — Quote reads overlapped** (Ethan: in this branch and PR). `quote.js` sends each read as soon as its key is known: the customer and every distinct SKU's variant from the cart, inventory once the customer names the region, each distinct product once the variants name it, promotions once the tier and categories are known. Prices are unchanged: identical responses for all 2,000 `dev` carts from fresh loads in containers, and for all 300,000 `bench` carts offline. On `dev` it costs more target CPU per quote, not less; see [quote batching on `dev`](#quote-batching-on-dev-2026-10-15). `BENCH_ARGS` passes harness flags such as `--quote-share 1` through the orchestrator.

- **2026-10-15 — Two decisions (Ethan):** the `bench` warm-up is fixed at 120,000 requests at 100 rps, about 20 minutes, from the 10-minute soak below; `dev` keeps 2,000 at 200 rps. Both live in `WARMUP` in `@ecommerce-store/spec`, are recorded with each run, and are checked by `verify-run-record.mjs`. And `bench` runs only on the tier-2 host or a platform as a service, never locally.

- **2026-10-14 — Realistic access, regenerated dataset** (same branch; Ethan approved the regeneration for this change and kept it in one PR):
  - **Distribution.** A discrete Zipf over rank (`s = 0.8845`, solved so the hottest 1% of the 2,000,000-product catalog takes half the draws), scrambled from rank to key by a seeded Feistel bijection. The hottest product takes 2.6% of draws, not 22.5%, and hot keys are spread across the id space. Stated in [SPEC.md](../SPEC.md#access-distribution); checked by counting draws in `npm run check`.
  - **Dataset `0.5.0`.** Only `cart` changed; every other table is byte-identical. The measured `bench` cart-line mass is 50.0% on the hottest 1% and 2.54% on the top product. See [regenerations](seed-design.md#regenerations).
  - **Every key.** The harness draws from all 300,000 carts and 2,000,000 products and plans its writes up front; generator RSS peaked at 238 MiB of its 1 GiB.
  - **Page cache.** The orchestrator drops the page cache the restore filled before every cold start; it had been serving the target from memory outside its budget.

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

1. **Run `bench` on the tier-2 host: Harper against Fastify + Postgres + Redis, and Harper's quote batching against the build before it.** The procedure is in [containers/README.md](../containers/README.md#tier-2). Budget the time: a trial is about 30 minutes (a 20-minute warm-up, seven 60 s steps, restore and cold start), so three builds at three trials each is about 4.5 hours plus 20 minutes of seeding per target, against the VM's 8-hour limit. `bench` never runs locally; `DATA-004` evidence comes from tier 2. The local 5.3.2 snapshots stay in the main checkout's `containers/.snapshots/`.
2. **Re-run the Fastify + Postgres + Redis target (application-architecture-benchmarks #6) against dataset `0.5.0`.** It is pinned to `1f4a350`, which carries the `0.4.0` dataset and the old access distribution.
3. **Add independent expected values.** Build a correctness suite keyed to the dataset manifest checksum. Conformance checks shape and consistency; the harness also needs expected quotes derived independently from the implementation under test. Publish expected values as data so every stack compares against the same answers without sharing pricing code.
4. **Confirm `FRESH_MS`.** The provisional budget in [Background writes](../SPEC.md#background-writes) needs run evidence; `PDP-003` and `WRITE-002` depend on it.
5. **Add an in-application background writer.** The harness currently drives writes through the application write surface. This exercises coherence but differs from application-owned background work.

## External dependencies

| Need | Owner |
|---|---|
| Linux host for controlled measurements: the GCP tier-2 host, qualified on `c4-standard-16-lssd` (application-architecture-benchmarks #5); first sessions recorded in [application-architecture-benchmarks#8](https://github.com/HarperFast/application-architecture-benchmarks/pull/8) | Maintainers |
| Outstanding specification reviews | Maintainers; status in [Review gate](../SPEC.md#review-gate) |
| Sanity-check the invented promotion evaluation order | Reviewer with pricing-engine experience |
| Answer the [OAuth scope question](questions/oauth-authorization-server-scope.md), drafted but unsent | `@harperfast/oauth` maintainers; not blocking P0 |

## Promotion candidates on `bench` (2026-10-16)

**Tier-1 diagnostics, not results.** Podman's Linux VM (aarch64), Harper 5.3.2, no other containers, clock neither pinned nor measured. Each target is a 2 CPU / 2 GiB container.

**The cause.** In Harper 5.3.2, `searchByIndex` (`resources/search.ts`) does not use an index's ranges for `in`: it walks the attribute's whole index, tests every entry against the value set, and under async iteration spends one `setImmediate` turn per entry. The planner leads with the narrower `in` (the categories), reads every row it matches, and filters those on the tier, switching to an id set built by walking the tier index once misses pile up. Cost follows the table, not the matches, which is why `dev`'s 160 promotions never showed it.

**The lookup alone.** In process, one worker, only the 5,000 `bench` promotions loaded, probed with the tier and categories of the 400 hottest `bench` carts, three passes each:

| Candidate lookup | Rows returned | p50 | p90 | CPU per lookup |
|---|---|---|---|---|
| Two `in` conditions, ANDed (before) | 647 | 13.6 ms | 16.1 ms | 14.5 ms |
| Every row, filtered in JavaScript | 647 | 17.4 ms | 18.9 ms | 18.2 ms |
| The tier `in` alone | 2,195 | 11.2 ms | 12.6 ms | 11.9 ms |
| The same two conditions as ORs of `equals`, ANDed | 647 | 4.6 ms | 7.9 ms | 5.4 ms |
| The combined key, an OR of `equals` (after) | 647 | 1.07 ms | 2.3 ms | 1.35 ms |

The four lookups over both dimensions returned the same promotions for every probe. Run natively on macOS, the `in` lookup took 72 ms at p50 for 19 ms of CPU, the rest waiting on event-loop turns, so per-entry yields cost more there than on Linux.

**The whole quote.** The reference with only the lookup changed, two workers, `dev` loaded with and without its promotions replaced by the `bench` table, timed with the comparison's `server-timing.mjs` (the 1,000 hottest carts and products warmed, then the 400 hottest carts one at a time):

| Dataset | Quote `data` p50 / p90, before | After |
|---|---|---|
| `dev` | 1.02 / 1.62 ms; repeated, 0.92 / 1.53 ms | 0.42 / 0.89 ms |
| `dev` carts, `bench` promotions | 14.15 / 17.29 ms; repeated, 14.00 / 17.08 ms | 1.62 / 3.49 ms |

The promotion table's size alone took a quote's reads from 1 ms to 14 ms. Tier 2's 19.1 ms ([application-architecture-benchmarks#8](https://github.com/HarperFast/application-architecture-benchmarks/pull/8)) adds different hardware and `bench`-scale point reads; how much of it this lookup was is not measured there. The tier-2 REST probe of this lookup (the comparison's `promotion-probe.sh`, 7 to 10 ms) wrote each condition as an OR of `equals`, the faster form in the table above, so it understated what the quote's `in` lookup cost.

**Correctness.** Responses were byte-identical before and after for all 2,000 `dev` carts, with the `dev` promotions and with the `bench` promotions (5,897 and 2,286 applied promotion ids). Offline, the old and new candidate sets are identical for all 300,000 `bench` carts: 22,122 distinct tier and category sets, 634 candidates on average. Because every `bench` quote stops at its exclusive promotion, `bench` responses cannot show a lost non-exclusive candidate, so the sets were also checked inside Harper: for each of the 85,310 distinct (tier, category list) probes the `bench` carts produce, the reference's search returned exactly the promotions a full scan admits, with no duplicates. The conformance suite passes. A database seeded under either schema and restarted under the other rebuilt the changed index on start, answered its first quote within 2 s, and returned identical quotes. A search on an index still being rebuilt fails rather than answering from part of it.

## Quote batching on `dev` (2026-10-15)

Alternating trials in one session: `e6d8c19` (before) and the batched quote (after), three rounds of a mixed ladder (800–3,200 rps, half quotes) and a quote-only ladder (400–2,000 rps, `--quote-share 1`), 20 s steps, every trial seeded fresh and cold-started. No other containers ran. Medians of the quote-only steps, before → after:

| Offered quotes/s | Target CPU per quote | Quote p50 | Quote p99 |
|---|---|---|---|
| 400 | 1.49 → 1.59 ms | 2.6 → 2.9 ms | 14 → 99 ms |
| 800 | 1.00 → 1.20 ms | 2.7 → 3.1 ms | 42 → 116 ms |
| 1,200 | 0.87 → 1.11 ms | 3.1 → 4.0 ms | 49 → 366 ms |
| 1,600 | 0.81 → 0.88 ms | 3.6 → 4.1 ms | 39 → 197 ms |
| 2,000 | 0.84 → 0.89 ms | 6.9 → 9.1 ms | 156 → 375 ms |

- **Quote-only:** batching cost more CPU per quote in 10 of 11 paired steps (geometric mean +13%) and raised p99 in 10 of 11. Both sustained 2,000 quotes/s, the highest step.
- **Mixed:** no consistent difference. CPU per request was higher after in 5 of 11 paired steps; both fell short of 3,200 rps (2,911–3,193 achieved).
- **Writes:** 400 per step in both arms, no failures, identical invalidation counts. The harness does not time writes, so batching's effect on the write path's own tail is unmeasured.
- **Excluded:** five first-round steps, four before and one after, stalled for up to 15 s. Zoom was running on the host then, and a Chrome tab burst to 2.5 cores during the stall after. The later rounds had neither Zoom nor stalls. Bluetooth's daemon held about one host core throughout.

A likely reason, unverified: in Harper 5.3.2 a read that misses the worker's record cache goes to RocksDB asynchronously through a thread pool. On `dev` those reads find their data in memory, so overlapping them hides no I/O, and a quote's reads now queue together inside the target's two CPUs. Whether batching pays where reads wait on disk is unmeasured; `bench` runs only on tier 2.

## Bench-scale observations on dataset 0.5.0 (2026-10-14)

**Tier-1 signal, not results.** Harper 5.3.2, the Podman VM idle apart from this target (no other containers; VM load average 0.2), clock neither pinned nor measured. The database is 6.0 GB on disk against a 2 GiB budget.

Two seven-step ladders (30 s steps) differed only in whether the VM's page cache was dropped before the cold start:

| | Warm VM cache | Dropped |
|---|---|---|
| Cold start | 1.9 s | 4.7 s |
| Highest unsaturated step | 150 rps, p50 16.4 ms | 125 rps, p50 16.7 ms |
| Saturated at | 200 offered, 179 achieved | 150 offered, 133 achieved |
| Target memory peak | 1,016 MiB (50%) | 1,411 MiB (69%) |
| Disk reads per step | 16–22 MiB | 32–55 MiB |
| Product cache hits | 0.8% → 9.2% | 0.8% → 8.7% |

The warm cache was the restore's, charged to no target; the orchestrator now drops it by default.

A 10-minute soak at 100 rps from a dropped cache shows where the working set lands. The target's memory climbed from 524 MiB a minute in to 1,774 MiB (87% of budget) and was still rising about 26 MiB a minute at the end; anonymous memory levelled at 973 MiB (heaps plus Harper's 512 MiB block cache), and page cache reached 769 MiB. It read 531 MiB from disk during the step, about 22 MiB a minute by the end, with no page-cache refaults. p50 16.0 ms, p99 222 ms, product hits 6.5%, target CPU 1.19 cores.

**`DATA-004` is not yet demonstrated.** The catalog is three times the budget, every key is reachable, and the target keeps reading its cold tail from disk, but within 10 minutes its memory had not filled and nothing was evicted and re-read. `verify-run-record.mjs` failed all three runs on that check, as it should. At the soak's final growth rate the cache fills in roughly another 10 minutes, which set the `bench` warm-up at 20 minutes (120,000 requests at 100 rps). These were the last local `bench` runs: `bench` now runs only on tier 2, where the evidence for `DATA-004` will come from.

## Bench-scale observations on 5.3.2, dataset 0.4.0 (2026-10-12)

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
| **The combined promotion key is unmeasured on tier 2.** On tier 1 it took a quote on `dev` carts with the `bench` promotions from 14 ms of reads to 1.6 ms; see [promotion candidates on `bench`](#promotion-candidates-on-bench-2026-10-16). | Re-run the tier-2 Server-Timing diagnostic and the comparison with it, then attribute whatever remains of the `bench` quote's reads. Needs Ethan's approval for spend. |
| **Unexplained `dev` latency.** One step had p90 in seconds; a higher step had single-digit milliseconds. Quotes were slow, not products. On 5.3.2, stalls of up to 15 s hit five of 54 `dev` steps, in both builds, only while Zoom and a Chrome tab loaded the host. | Treat as host contention unless tier 2 shows it; the 2026-10-05 write-lock hypothesis predates 5.3.1. |
| **Quote batching is unproven.** On `dev` it costs 13% more target CPU per quote and raises quote p99; see [quote batching on `dev`](#quote-batching-on-dev-2026-10-15). Ethan keeps it in for now. | Alternate two builds in the tier-2 session and decide from it. Since the combined promotion key, `dd3a5f5^` no longer isolates batching: it carries the old lookup and schema, and its schema refuses the checkout's snapshot. Build the "before" from the checkout with `dd3a5f5` reverted (it reverts cleanly); see [containers](../containers/README.md#tier-2). |
| **The write surface and response details are specified by tests, not `SPEC.md`.** The harness and suite require `POST /admin/variant/:sku` `{basePrice}`, `POST /admin/inventory/:id` `{onHand}`, an `invalidated` count in each write response, the `Server-Timing` grammar (`cache;desc=hit\|miss`, `data`, `compute`, `total`), and quote fields (`currency`, `region`, `taxJurisdiction`, `totalWeight`) that only [model.ts](../packages/spec/src/model.ts) names. | Specify them, or name `packages/spec` as normative, before a second implementation is built against the prose. |
| **Metric definitions differ across stacks.** `invalidated` counts keys targeted (Harper writes an invalidation marker even for a never-cached key); a Redis `DEL` count is keys removed. Harper reports a request that waited on another request's in-flight fill as a hit. `total` excludes response serialization in both handlers. | Define each in `SPEC.md` so cache-hit rates and invalidation fan-out compare. |
| **`DATA-004` is undemonstrated.** With every key reachable and the cache dropped, a local 10-minute soak filled 87% of the target's memory and was still growing; nothing was evicted. `verify-run-record.mjs` fails such a run: no cgroup reached 90% of its limit while still reading from disk. | Decided: a fixed `bench` warm-up of 120,000 requests at 100 rps (about 20 minutes), which verification checks. Show `DATA-004` on tier 2; `bench` no longer runs locally. Re-running the first rate at the end to measure drift is still open. |
| **The Fastify target uses the old dataset.** application-architecture-benchmarks #6 is pinned to `1f4a350` (dataset `0.4.0`, the old distribution). | Follow up against dataset `0.5.0` before any comparison. |
| **Network softirq is not charged to a cgroup.** Bridge traffic between a separated stack's containers is partly unaccounted, and on tier 2 may run outside the target's CPUs; Harper has no such hops. | On tier 2, record per-step softirq for the target CPUs, or steer bridge interrupts onto them; disclose either way. |
| **Duplicate SKU lines allocate inventory twice.** Promotions merge lines by SKU; availability does not, so a repeated SKU understates `shortfall`. The dataset has no such carts. | Clarify in `SPEC.md` whether lines merge for availability and in the response. |
| **Untested until the Linux host.** `sample.sh`'s per-cgroup CSV has never been captured, so the join reads it by perf's documented column order (tested against the probe's real per-CPU output). Also untested: `!reset` under Docker's Compose plugin, cgroup accounting of a `docker-<id>.scope` inside `bench-target.slice`, the join waiting on perf's flush, the page-cache hook under `sudo`, the x86-64 image build, and a real Fastify target beside Harper. | Check each in the first session's shakedown trial, before the measured trials. |
| **Harper 5.3.2: a `static` verb override is permission-checked on its first table read.** REST leaves `authorize` set, so a static custom resource reading a table answers 401 to anonymous callers, though server-side reads are documented as trusted. The endpoints stay instance-style. | Report upstream; convert to static verbs once fixed. |
| **Harper 5.3.2: `in` on an indexed attribute walks the whole index**, one event-loop turn per entry under async iteration, so it costs the same whatever it matches. The reference no longer uses it. | Filed upstream as [harper#3240](https://github.com/HarperFast/harper/issues/3240) (milestone v5.4); the per-row yields are [harper#3241](https://github.com/HarperFast/harper/issues/3241). The reference avoids `in` until #3240 ships (Ethan, 2026-10-16); then revisit whether the combined key still pays, since `in` alone does not intersect two dimensions. |
| **Harper 5.3.2: queued cache fills run in the first fill's async context** (`server/throttle.ts`), so a resolver's ambient table reads join another fill's transaction. The resolver passes its context explicitly. | Report upstream. |
| **Harper 5.3.2 packaging.** The global install needs Python on glibc images, and msgpackr-extract's linux-arm64 prebuilt lacks glibc binaries. The Dockerfile works around both. | Report upstream (Harper; msgpackr-extract). |
| **Host-side Node.** `prepare-dataset.mjs` and `load-dataset.mjs` run on the host. | None required; containerize if a host without Node appears. |

## Open decisions

- **Tier multipliers:** currently normative in [Resolved unit price](../SPEC.md#resolved-unit-price). Moving them into `rate` rows with `kind: 'tier'` would pin them in the dataset and remove unchecked duplication between pricing code and seed vocabulary. Coordinate any regeneration with the pricing-phase decision.
- **Facet counting:** three options remain open in [future work](future-work.md#product-listing-facets-and-search).
- **Write durability across stacks:** `SPEC.md` does not say whether an acknowledged background write must survive a crash, or whether caches may be volatile. Harper's cache rows are written through the same durable path as its source of truth; Redis need not be.
- **Unknown query values:** the product endpoint answers 400 for an unknown region and prices an unknown tier as `standard`. `SPEC.md` specifies only the tier rule.
- **`@export` on the eight tables:** a super-user REST surface no comparison measures, and a write path that bypasses invalidation. Keep, or remove so the write surface is the only one.
- **The 5.2 `bench` snapshot** (`containers/.snapshots/bench.tar.gz`, no provenance, every index) cannot be restored under 5.3.2 without `ALLOW_UNVERIFIED_SNAPSHOT=1`. Delete once a 5.3.2 ladder has run.
- **Dataset distribution:** retain Git LFS for now. Reconsider release assets, which are deletable and unmetered, if dataset size, regeneration frequency, or clone volume grows.

## What may not be claimed yet

- **Correctness from a run:** the harness has no ground-truth guard.
- **Cycle-normalized efficiency:** never from tier 1, where the clock is neither pinned nor measured; on tier 2 only from runs whose cycles were joined, stated as "all-core turbo, measured at N GHz".
- **Cross-target comparisons:** only one implementation exists.
- **Component CPU breakdowns:** Harper is one container; per-container accounting exists but no assembled stack has been measured.
- **Benchmark results from `dev`:** it fits in memory.
- **Any number from dataset `0.4.0`**, which covers every run before 2026-10-14: the access distribution and the carts have changed.
- **Latency or target CPU from runs before 2026-10-12:** latency carries the dispatch artifact, target CPU was never recorded, and 5.2.12 images ran without msgpackr native acceleration.

[bench/README.md](../bench/README.md#limitations) describes the harness limits. No run produced here is publishable.
