# Development plan

**Last updated:** 2026-10-09 · **Spec version:** `0.2.0-draft`

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
| Schema and caching | Eight entities plus derived `ProductView`, keyed by product × tier × region; write-through invalidation with expiry backstop. |
| Write surface | `POST /admin/variant/:sku` and `POST /admin/inventory/:id` write and invalidate. |
| Endpoints | Quote and product aggregate built and covered by conformance tests. Product timing lacks a compute phase. |
| Background writer | Harness-side only; no in-application writer. |
| Datasets | `dev` in plain git, `bench` in Git LFS; checksum-verified before loading. |
| Conformance | Every MUST has declared coverage; execution and assertion gaps remain below. |
| Harness and containers | Load ladder, 2 CPU / 2 GiB target, and snapshot restore implemented. No complete `bench` ladder yet. |
| CI | Repo checks and conformance on pushes and pull requests; LFS pulled only for dataset changes. Both jobs last recorded passing. |

## Recent work

- **2026-10-09 — Documentation edit:** shortened guides, removed duplicated schema and rationale, and clarified existing measurement and coverage limits. No application, requirement semantics, or dataset changes.

Validation: local links and diff checks pass. `npm run check` hits a pre-existing anchor-check failure in the nested `.claude/worktrees/spec-pricing` checkout. In a clean copy, all stages through typechecking pass; deployment validation remains incomplete because the sandbox blocked npm cache writes. This does not change the last recorded CI status.

## Next

1. **Complete a `bench`-scale ladder.** The first attempt ended in generator heap exhaustion. Its observations cannot establish capacity or index performance.
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

## First bench-scale observations (2026-10-05)

**Incomplete exploratory run, not results.** The generator exhausted its heap after three steps, was under pressure throughout, and ran without a pinned clock. These samples do not establish target capacity or efficiency.

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

## Open

| Gap | Needed action or decision |
|---|---|
| **No ground-truth guard.** The harness counts every 2xx as success. Determinism does not prove correctness. | Add pinned, independently computed expected quotes; see Next. |
| **Run coverage is declared but not executed.** `scripts/verify-run-record.mjs` covers memory behavior and write-stream requirements, but neither checks, CI, nor the orchestrator invokes it. | Wire it into `run-benchmark.sh`, which produces the run record. `npm run check` has no run record to validate. |
| **Product compute timing is missing.** `OBS-001` requires data, compute, and total for both endpoints. Product emits cache, data, and total; its test accepts that, while the quote test supplies the requirement's coverage credit. | Add the phase and assert it on both endpoints. |
| **Pricing phases are unevenly exercised.** Exclusive and threshold promotions each reach roughly half of `dev` carts; BOGO and stackable discounts barely register under the shared 60% cap. | Decide between changing the cap, narrowing cart-wide eligibility, or changing order. Each changes the workload and requires coordinated dataset regeneration. |
| **Promotion-index benefit is unmeasured.** Sentinel probes pass completeness checks and narrow candidates, but are marginally slower than a scan on `dev`. | Measure at `bench` scale before claiming a benefit; quote fan-out may still dominate. |
| **Stride sampling floors `total/limit`.** The table tail can remain unreachable. | Correct coverage of the sampled range. |
| **Unexplained `dev` latency.** One step had p90 in seconds; a higher step had single-digit milliseconds. Quotes were slow, not products. | Recheck at `bench` scale; the unpinned `dev` run cannot support a measurement claim. |
| **Upsert does not restore exact membership.** Reloading leaves rows absent from the incoming dataset. | Snapshot restore avoids this between current trials; revisit loader semantics if reload becomes the restore path. |

## Open decisions

- **Tier multipliers:** currently normative in [Resolved unit price](../SPEC.md#resolved-unit-price). Moving them into `rate` rows with `kind: 'tier'` would pin them in the dataset and remove unchecked duplication between pricing code and seed vocabulary. Coordinate any regeneration with the pricing-phase decision.
- **Facet counting:** three options remain open in [future work](future-work.md#product-listing-facets-and-search).
- **Promotion lookup:** compare indexed array probes with a combined key at benchmark scale; see [data model](data-model.md#open).
- **Dataset distribution:** retain Git LFS for now. Reconsider release assets, which are deletable and unmetered, if dataset size, regeneration frequency, or clone volume grows.

## What may not be claimed yet

- **Correctness from a run:** the harness has no ground-truth guard.
- **Cycle-normalized efficiency:** the CPU clock is not pinned.
- **Cross-target comparisons:** only one implementation exists.
- **Component CPU breakdowns:** Harper is recorded as one process; no assembled stack exists yet.
- **Benchmark results from `dev`:** it fits in memory.

[bench/README.md](../bench/README.md#limitations) describes the harness limits. No run produced here is publishable.
