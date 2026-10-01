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
| `SPEC.md` — 27 requirements | Written. **Review gate not passed.** |
| Schema — 8 tables | Built |
| `POST /cart/:id/quote` | Built, unverified beyond smoke tests |
| `GET /product/:id` | Built, unverified beyond smoke tests |
| Background writer | Harness-side only; no in-app writer |
| `dev` dataset — 46,583 rows | Committed, plain git |
| `bench` dataset — 40,656,446 rows | Committed via Git LFS |
| Conformance suite | **6 of 27 real**, 21 stubs |
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
