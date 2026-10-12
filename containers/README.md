# Containerized benchmarks

Local benchmark topology with a fixed target budget and a separate load generator. This does not model a hosted platform. See the [harness limitations](../bench/README.md#limitations); no run is a publishable result yet.

## Run

Requires Docker or Podman with Compose. Copy `containers/.env.example` to `containers/.env` and set the local test credentials required by Harper's non-interactive installer.

For development:

```bash
SCALE=dev ./containers/run-benchmark.sh
```

For the benchmark dataset and repeated trials:

```bash
SCALE=bench TRIALS=3 ./containers/run-benchmark.sh
```

`dev` is for iteration only. Benchmark data requires Git LFS; see [setup](../CONTRIBUTING.md#setup).

The header of [run-benchmark.sh](run-benchmark.sh) lists every setting. The ones that change what a run means:

| Setting | Effect |
|---|---|
| `TRIALS=0` | Build, seed, and snapshot; measure nothing. |
| `SKIP_LOAD=1` | Restore the existing snapshot instead of seeding. The snapshot's provenance must match. |
| `COMPOSE_EXTRA` | Extra compose files layered over `compose.yaml`. `compose.tier2.yaml` places the target and generator in the tier-2 host's slices. |
| `TIER` | Recorded with the run; tier 1 records that the clock is neither pinned nor measured. |
| `PRE_START_HOOK` | Host command run between stopping the target and its measured start. Tier 2 drops the page cache here. |
| `DATASET_ROOT`, `SNAPSHOT_DIR` | Where expanded datasets and snapshots live, so a worktree can use another checkout's. |
| `KEEP_TARGET=1` | Leave the target running afterwards; by default it is stopped. |

## Resource budget

| Service | CPUs | Memory |
|---|---|---|
| `harper` target | 2 | 2 GiB |
| `bench` generator | 2 | 1 GiB |

A competing stack must fit all its processes—framework, database, and cache—within the target budget. The generator stays outside that budget. Harper defaults to two worker threads here to match its CPU allocation.

## Fixed run conditions

These choices affect measurements and must match across targets:

- **Bridge networking.** Mixing host and bridge networking would invalidate a comparison.
- **Plain HTTP on both ports.** TLS termination is excluded.
- **Named volume on a real filesystem.** Never tmpfs.
- **Pinned Harper version**, installed globally and checked at build time, with msgpackr's native decoder verified loaded. Its linux-arm64 prebuilt ships only musl binaries, so the image compiles it; a target running without it measures a slower Harper than ships on x86-64.
- **No healthcheck in any target container.** A healthcheck runs its probe inside the target's budget for the whole run. Readiness is probed from the host.
- **Production dependency install:** `npm install --force --omit=dev --ignore-scripts`, matching Harper's deployment path.

## Lifecycle

1. **Seed:** expand, verify, and load the dataset into an emptied volume; loading is not measured.
2. **Snapshot:** archive the loaded state for trial restore, with a provenance record beside it.
3. **Cold start:** stop the target, run `PRE_START_HOOK`, start it, and record the time to the first successful (2xx) response. The probe polls the published port from the host every 25 ms ([wait-ready.mjs](wait-ready.mjs)).
4. **Warm-up:** drive a fixed workload, identical across targets.
5. **Measure:** run the load ladder.
6. **Verify:** check the run record with [verify-run-record.mjs](../scripts/verify-run-record.mjs). A failing trial is reported and its record kept; re-run it.

Restore the snapshot between trials so earlier writes do not alter later trials' starting state. Cold, warm, and hot phases are recorded separately. A successful readiness response is not a correctness check.

Snapshots are named `<scale>-harper-<version>.tar.gz`. The provenance record names the dataset manifest hash, schema hash, Harper version, image, and architecture, and a restore refuses a snapshot whose scale, dataset, schema, version, or architecture differs from the run's. An existing snapshot without a record is refused unless `ALLOW_UNVERIFIED_SNAPSHOT=1`.

## Accounting

The generator reads the target's CPU per step from cgroup v2 `cpu.stat`, through a read-only mount of the host's cgroup tree: the target container's scope by default, or the cgroups in `TARGET_CGROUPS` (a separated stack's containers, or a tier-2 slice). Each step records its wall-clock start, offer end, and drain end, so host-side samples such as tier 2's per-cgroup cycle counts can be joined to it. The orchestrator passes the conditions the generator cannot see — Harper version, image, budget, compose files, tier, snapshot provenance, cold start, and other containers running on the machine — and they are recorded under `conditions.orchestrator`.

Output is stored in the `bench-results` volume at `/results`.

## Rebuild after code changes

Application code is copied into the image at build time. `docker compose up` alone does not rebuild it. The orchestrator always builds; for a manual cycle, run:

```bash
docker compose -f containers/compose.yaml build harper
```

## Host limitations

The CPU clock is not pinned, so these runs cannot support cycle-normalized efficiency claims. Harper's CPU accounting is a single total; there is no framework/database/cache breakdown yet.

On macOS, Podman runs in a VM. Resource limits apply within its allocation, and the VM adds a network boundary. Valid controlled comparisons need a Linux host and the remaining [measurement gaps](../bench/README.md#limitations) closed.
