# Development plan

Status tracking for this repo. The [README](../README.md) documents the application; this documents the work.

**Last updated:** 2026-10-06 · **Spec version:** `0.2.0-draft`

Counts are deliberately absent from this file — of requirements, of tests, of rows. They were wrong within days every time they were written down, and each one has an authoritative source that cannot drift: `SPEC.md` and the requirement registry for requirements, `npm run check` for coverage, each dataset's `MANIFEST.json` for rows.

---

## Where this sits

```
application-architecture-benchmarks   methodology, measurement rules, competitor implementations
    └── ecommerce-store (this repo)   the reference implementation + the specification
            └── snapshot repos        published, dated comparison results
```

The benchmarks repo's methodology is binding here. Results are never published from this repo.

## Status

| Piece | State |
|---|---|
| `SPEC.md` | Written; two rounds of cross-model review applied. **Review gate not passed** — see SPEC.md §8, which is the only place gate status is tracked |
| Schema | Built — the eight specified tables, plus `ProductView`, a derived cache |
| Caching | `ProductView`, a `sourcedFrom` cache keyed by product × tier × region, invalidated write-through with an expiry backstop |
| Write surface | `POST /admin/variant/:sku`, `POST /admin/inventory/:id` — write and invalidate |
| `POST /cart/:id/quote` | Built, covered by the conformance suite |
| `GET /product/:id` | Built, covered by the conformance suite. Its `Server-Timing` omits the compute phase — see Open, below |
| Background writer | Harness-side only; no in-app writer |
| Datasets | `dev` committed plain, `bench` committed via Git LFS; both checksum-verified before load |
| Conformance suite | Every MUST covered, no stubs remaining — with one caveat recorded under Open |
| Load harness | Works; knows what it cannot claim |
| Containers | Works, 2 CPU / 2 GiB target, with snapshot restore between trials |
| CI | Repo checks and conformance, on every push. LFS is pulled only when the dataset changes. The conformance job has not yet completed green |

## Next

1. **A `bench`-scale run that completes.** No run has yet finished the full ladder at `bench` scale, so the observations below are partial and nothing downstream of them is settled.
2. **A ground-truth correctness guard in the harness.** The measurement rules require it and the harness does not have it. This is the largest outstanding hole in the measurement story — see `bench/README.md`.
3. **Confirm `FRESH_MS`.** SPEC.md §6 now sets it provisionally; the figure wants a real run behind it, and `PDP-003` / `WRITE-002` depend on it.
4. **An in-application background writer.** The harness drives writes through the operations API. That is fine for coherence pressure but is not the same as the application doing it.

## Blocked on someone else

| | Needed from |
|---|---|
| **A Linux host.** On macOS, Podman runs in a VM: CPU/memory limits bind against the VM's share, not the host's, and the VM boundary sits in the network path. Clock pinning is impossible, so no cycle-normalized efficiency figure exists. | Maintainers |
| **Review gate** — tracked in SPEC.md §8. Human review outstanding. | Maintainers |
| **The promotion evaluation order is invented.** Normative because two correct implementations otherwise disagree on a total. Nobody who has built a pricing engine has read it. | A reviewer with pricing experience |
| **OAuth authorization-server question** — drafted at [`questions/oauth-authorization-server-scope.md`](questions/oauth-authorization-server-scope.md), unsent. Not blocking; auth is future work. | `@harperfast/oauth` maintainers |

## First bench-scale observations (2026-10-05) — NOT results

A `bench`-scale run reached three ladder steps before the load generator died of heap
exhaustion. The numbers below are recorded because they are the first evidence the dataset
is doing its job, and discarded as measurements because the run did not complete, the
generator was in trouble throughout, and the clock was not pinned.

| offered | achieved | p50 | p90 | p99 | errors | cache hit |
|---|---|---|---|---|---|---|
| 100 | 99.9 | 29.2 | 94.1 | 369.8 | 0 | 18.4% |
| 200 | 199.4 | 274.1 | **29,470** | 31,382 | 10 | 26.9% |
| 400 | 166.1 | 50.6 | 11,787 | 22,410 | 1,369 | 33.5% |

Cold start to first response: **3,056 ms** — the first cold number the project has recorded.

What it suggests, pending a run that completes:

- **Capacity is somewhere between 100 and 200 rps**, against 2,000+ rps at `dev` scale on the
  same container. A ~13x drop is what a working set exceeding memory looks like, so
  `DATA-004` appears to be doing exactly what it was written for.
- **The ladder default brackets this range.** A ladder whose steps all sit past collapse
  locates no inflection point, which is the one thing the ladder exists to find.
- **Cache hit rate climbs but stays low** (18% → 33%). At `dev` it reached 77% in the first
  step. Worth watching: it may simply be a cold cache over a far larger key space, or the
  hot set may be too diffuse at this catalog size even with the skew.

## Open

Known gaps, each with why it is still open rather than closed.

| | Why it is still open |
|---|---|
| **No ground-truth correctness guard in the harness.** It treats every 2xx as success and never compares a response to an independently computed expected value. Determinism alone does not establish correctness — a consistently wrong answer is deterministic too. | The measurement rules require this. It needs pinned fixtures with expected quotes, computed independently of the implementation under test. |
| **Part of the coverage gate is not executed.** `scripts/verify-run-record.mjs` declares coverage of the requirements that are properties of a *run* rather than a request — the dataset's memory behaviour and the write stream. Nothing runs it: not `npm run check`, not CI, not `run-benchmark.sh`. The gate scans its `COVERS:` line statically, so those requirements currently pass on a comment. | The split is right — they genuinely cannot be asserted by hitting an endpoint. The fix is to run the verifier against the run record the orchestrator already emits, which means wiring it into `run-benchmark.sh` rather than into `npm run check`, where there is no run record to check. |
| **The product endpoint's `Server-Timing` omits the compute phase.** `OBS-001` requires data access, compute and total on **both** endpoints. The quote emits all three; the product aggregate emits cache, data and total. The conformance test for the aggregate asserts only what is emitted, so the gate passes — `OBS-001` is credited to the quote's test. | Small fix, but it is the coverage gate being satisfied by the letter rather than the requirement, which is the failure mode the gate exists to prevent. |
| **Pricing phase balance.** With one discount budget and a 60% cap, cart-wide promotions consume the headroom first: exclusive and threshold reach roughly half of `dev` carts each, BOGO and stackable barely register. | A workload-design tradeoff, not a bug — cap strictness versus phase coverage. Loosening the cap, narrowing cart-wide eligibility, or reordering the phases all change what the benchmark measures. Needs a decision, then one regeneration of both datasets. |
| **The promotion index is unmeasured at the scale it exists for.** The scan is replaced by two `in` probes on sentinel-bearing key arrays, verified a superset in every tier × category combination and narrowing the candidate set substantially. But at `dev` the indexed path is marginally *slower* than the scan it replaced — at that corpus size the scan was never the cost. | The benefit only appears where the scan was thousands of rows. Nothing is claimed for it until a `bench`-scale run measures it; it could plausibly show up as nothing if the quote's fan-out dominates there too. |
| **Stride sampling still floors.** `Math.floor(total/limit)` can leave the tail of a table unreachable. | Smaller than the prefix bug it replaced, but the same class. |
| **A `dev` ladder step showed p90 in the seconds while a much higher step showed single-digit milliseconds.** | Not understood. Quotes, not products, are the slow requests. Dev scale on a 2-CPU container with no clock pinning is not a measurement, so this is recorded to be re-checked at `bench` scale rather than chased now. |
| **Upsert does not restore exact membership.** Reloading over a populated instance leaves rows the new dataset does not contain. | Matters for trial restore; the snapshot path sidesteps it today. |

## Open decisions

- **Facet counting**, when listing pages return. Three candidates identified, none chosen; see [`future-work.md`](future-work.md).
- **Promotion eligibility lookup** — indexed array probes versus one denormalized key. A P1 measurement, not a guess. See [`data-model.md`](data-model.md).
- **Dataset distribution via Git LFS or release assets.** LFS today: the org is on Enterprise with ample headroom and near-zero usage, so the current dataset is comfortable. Release assets are unmetered and deletable, which matters if regeneration becomes routine. Revisit if the dataset grows substantially, regeneration becomes frequent, or clone volume climbs.

## What may not be claimed yet

Recorded because the gap between "we measured something" and "we may say this" is where benchmarks lose credibility.

- **No correctness claim from any run.** The harness has no ground-truth guard; a run says the target answered, not that it answered correctly.
- **No cycle-normalized efficiency.** The CPU clock is not pinned. Any ops-per-CPU-gigacycle figure derived from this harness is unsound.
- **No cross-target comparison.** There is one implementation. Containerization is identical-by-construction only because there is nothing to be identical *to* yet.
- **No per-component CPU breakdown.** Harper is one process; the framework/database/cache split has no analogue until an assembled stack exists.
- **Nothing from the `dev` dataset.** It fits entirely in memory, which is the one thing the benchmark data must not do.
