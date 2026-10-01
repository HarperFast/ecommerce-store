# Development plan

Status tracking for this repo. The [README](../README.md) documents the application; this documents the work.

**Last updated:** 2026-10-01 · **Spec version:** `0.2.0-draft`

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
| `SPEC.md` — 29 requirements | Written; two rounds of cross-model review applied. **Human review gate not passed.** |
| Schema — 8 tables | Built |
| `POST /cart/:id/quote` | Built, unverified beyond smoke tests |
| `GET /product/:id` | Built, unverified beyond smoke tests |
| Background writer | Harness-side only; no in-app writer |
| `dev` dataset — 46,583 rows | Committed, plain git |
| `bench` dataset — 40,656,446 rows | Committed via Git LFS |
| Conformance suite | **8 of 29 real**, 21 stubs |
| Load harness | Works; knows what it cannot claim |
| Containers | Works, 2 CPU / 2 GiB target |
| CI | Written, **never executed** — no remote yet |

## Next

1. **Fill in the conformance suite.** 21 requirements are still `test.fixme`. This gates everything else: a benchmark against an unverified implementation measures an unknown.
2. **A `bench`-scale run.** ~20 min load, then the ladder. First number not produced against a dataset that fits in RAM.
3. **Set `FRESH_MS`.** SPEC.md §6 is deliberately `TBD`; it can only come from a real run, and `PDP-003` / `WRITE-002` depend on it.
4. **An in-application background writer.** Currently the harness drives writes through the operations API. That is fine for coherence pressure but is not the same as the application doing it.

## Blocked on someone else

| | Needed from |
|---|---|
| **A Linux host.** On macOS, Podman runs in a VM: CPU/memory limits bind against the VM's share, not the host's, and the VM boundary sits in the network path. Clock pinning is impossible, so no cycle-normalized efficiency figure exists. | Maintainers |
| **Review gate** — self-review passed, cross-model and human review outstanding. Reset when the spec was rewritten. | Maintainers |
| **The promotion evaluation order is invented.** Normative because two correct implementations otherwise disagree on a total. Nobody who has built a pricing engine has read it. | A reviewer with pricing experience |
| **GitHub repo** — local only. CI has never run. | Maintainers |
| **OAuth authorization-server question** — drafted at [`questions/oauth-authorization-server-scope.md`](questions/oauth-authorization-server-scope.md), unsent. Not blocking; auth is future work. | `@harperfast/oauth` maintainers |

## Open from cross-model review (rounds 1–2)

Two rounds of three-reviewer cross-model review (Claude subagent, agy/Gemini, codex) ran against the foundation. Fixes are in `4c7630b` and `91b5650`. What they surfaced and I did **not** fix:

| | Why it is still open |
|---|---|
| **Pricing phase balance.** With one discount budget and a 60% cap, cart-wide promotions consume the headroom first: of 300 dev carts, exclusive reaches 51% and threshold 47%, but BOGO 1% and stackable 2%. | A workload-design tradeoff, not a bug — cap strictness versus phase coverage. Loosening the cap, narrowing cart-wide eligibility, or reordering the phases all change what the benchmark measures. Needs a decision, then one regeneration of both datasets. |
| **No ground-truth correctness guard in the harness.** It treats every 2xx as success and never compares a response to an independently computed expected value. Determinism alone does not establish correctness — a consistently wrong answer is deterministic too. | The measurement rules require this. It needs pinned fixtures with expected quotes, computed independently of the implementation under test. |
| **`Rng.skewed()` is near-uniform.** The top 1% of the catalog takes 1.52% of draws against 1% for uniform. `MANIFEST.json` publishes "zipf-ish" as a recorded run condition. | Without a hot subset, cache-hit rate is not a meaningful measurement. Fixing it means a real Zipf inverse-CDF and regenerating both datasets. |
| **`Server-Timing` emits only `total`.** OBS-001 requires data-access and compute phases; OBS-002 requires cache status; neither exists. | Blocks any claim that decomposes where time goes — which is most of what the harness is for. |
| **`loyaltyBalance` is read but never applied.** QUOTE-004 says "read and applied". | Needs a normative redemption policy in SPEC.md first; inventing one only in Harper would make implementations non-equivalent. |
| **Stride sampling still floors.** `Math.floor(total/limit)` can leave the tail of a table unreachable. | Smaller than the prefix bug it replaced, but the same class. |
| **Upsert does not restore exact membership.** Reloading over a populated instance leaves rows the new dataset does not contain. | Matters for trial restore; the snapshot path sidesteps it today. |

## Open decisions

- **Facet counting**, when listing pages return. Three candidates identified, none chosen; see [`future-work.md`](future-work.md).
- **Promotion eligibility lookup** — three indexed array probes versus one denormalized key. A P1 measurement, not a guess. See [`data-model.md`](data-model.md).
- **Dataset distribution via Git LFS or release assets.** LFS today: the org is on Enterprise (250 GiB storage / 250 GiB monthly bandwidth) with zero current usage, so 329 MB is comfortable. Release assets are unmetered and deletable, which matters if regeneration becomes routine. Revisit if the dataset passes ~2 GiB, regeneration becomes frequent, or clone volume climbs.

## What may not be claimed yet

Recorded because the gap between "we measured something" and "we may say this" is where benchmarks lose credibility.

- **No cycle-normalized efficiency.** The CPU clock is not pinned. Any ops-per-CPU-gigacycle figure derived from this harness is unsound.
- **No cross-target comparison.** There is one implementation. Containerization is identical-by-construction only because there is nothing to be identical *to* yet.
- **No per-component CPU breakdown.** Harper is one process; the framework/database/cache split has no analogue until an assembled stack exists.
- **No cold-start number from a trial.** The harness records the orchestrator's measurement; it is not yet reported per trial.
- **Nothing from the `dev` dataset.** It fits entirely in memory, which is the one thing the benchmark data must not do.

## Done

- **P0 scaffold and structural decisions** — repo root is the component root (forced: `deploy_component` takes a single tree and Harper does not implement npm's `#path:` extension). Plain npm workspaces, no vendoring. `e2e/` deliberately outside the workspace.
- **Narrowed to the benchmarks P0** — 68 requirements to 27. Everything removed is preserved with its reasoning in [`future-work.md`](future-work.md).
- **Application, dataset, harness** — eight tables, both endpoints, deterministic generator, open-model load ladder that locates saturation.
- **Two datasets** — `dev` for iteration, `bench` sized to exceed the container's memory.
- **Containers** — fixed resource budget, generator outside it, bridge networking, plain HTTP, pinned Harper, all recorded.
- **Git LFS** — history rewritten so the dataset never existed as plain blobs; ~780 MB of superseded data purged.
- **CI** — repo checks plus conformance, with LFS pulled only when the dataset changes.
