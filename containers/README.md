# Containerized benchmarks

Local benchmark topology with a fixed target budget and a separate load generator. This does not model a hosted platform. See the [harness limitations](../bench/README.md#limitations); no run is a publishable result yet.

## Run

Requires Docker or Podman with Compose, and the workspace installed: the harness and the verifier import `@ecommerce-store/spec` through it, and the orchestrator refuses to start without it. On a fresh checkout, including the tier-2 host, run `npm install --ignore-scripts --no-audit --no-fund` at the repository root first (`npm install`, as CI does: the lock file's platform-specific optional packages resolve differently across platforms). Copy `containers/.env.example` to `containers/.env` and set the local test credentials required by Harper's non-interactive installer.

Locally, run `dev` only:

```bash
SCALE=dev ./containers/run-benchmark.sh
```

**`bench` never runs locally.** It runs only on the tier-2 Linux host or a platform as a service, where its evidence — including `DATA-004`, a working set larger than memory — can be trusted. The orchestrator refuses `SCALE=bench` unless `TIER=2`. On the tier-2 host, with the slice placement, the page-cache drop, and the cycle join ([Tier 2](#tier-2) has a session with two builds):

```bash
SCALE=bench TIER=2 TRIALS=3 COMPOSE_EXTRA=compose.tier2.yaml SAMPLES_DIR=$S/samples PRE_START_HOOK='sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null' ./containers/run-benchmark.sh
```

`dev` is for iteration only. Benchmark data requires Git LFS; see [setup](../CONTRIBUTING.md#setup).

The header of [run-benchmark.sh](run-benchmark.sh) lists every setting. The ones that change what a run means:

| Setting | Effect |
|---|---|
| `TRIALS=0` | Build, seed, and snapshot; measure nothing. |
| `SKIP_LOAD=1` | Restore the existing snapshot instead of seeding. The snapshot's provenance must match. |
| `COMPOSE_EXTRA` | Extra compose files layered over `compose.yaml`. `compose.tier2.yaml` places the target and generator in the tier-2 host's slices. |
| `TIER` | Recorded with the run; tier 1 records that the clock is neither pinned nor measured. |
| `PRE_START_HOOK` | Host command run between stopping the target and its measured start, to drop the page cache the restore filled outside the target's budget. On a Podman machine it defaults to dropping the VM's cache, which also cools every other container on the machine; tier 2 sets it to drop the host's, as root. A `bench` record without one fails verification. |
| `DATASET_ROOT`, `SNAPSHOT_DIR` | Where expanded datasets and snapshots live, so a worktree can use another checkout's. |
| `KEEP_TARGET=1` | Leave the target running afterwards; by default it is stopped. |
| `TARGET_REF` | Build the target's application code from this commit, for example `dd3a5f5^`, the build before quote batching. Each build is its own image, tagged by commit; the Dockerfile, harness, and snapshot stay the checkout's. The record names the build in `conditions.code.commit` and `orchestrator.target.build`. |

## Resource budget

| Service | CPUs | Memory |
|---|---|---|
| `harper` target | 2 | 2 GiB |
| `bench` generator | 2 | 1 GiB |

A competing stack must fit all its processes—framework, database, and cache—within the target budget. The generator stays outside that budget. Harper defaults to two worker threads here to match its CPU allocation.

## Tier 2

On the tier-2 host ([application-architecture-benchmarks](https://github.com/HarperFast/application-architecture-benchmarks), `environments/gcp`), `COMPOSE_EXTRA=compose.tier2.yaml` places the target in `bench-target.slice` (CPUs 2–3, 2 GiB, no swap) and the generator in `bench-generator.slice` (CPUs 4–7), the slices `host-setup.sh` creates.

- **Memory limit kept.** A container cannot see its slice's limits. Harper sizes its block cache and worker heaps from its own container's limit, so the target keeps an explicit 2 GiB one; without it Harper would size from the VM's memory.
- **CPU quota dropped.** The slice's cpuset already gives two cores, and Harper's thread count is explicit. A quota on top would add throttling the tier-2 procedure discourages.
- **Checked.** `verify-run-record.mjs` fails a tier-2 record whose target ran outside the slice or without a memory limit.

- **Cycles.** With `SAMPLES_DIR` set to the session's `sample.sh` output, the orchestrator joins each trial's per-step cycles into its record ([cycles.mjs](../bench/cycles.mjs)) before verifying it. Verification fails a tier-2 record with a step that has none.

A session for the reference, with two builds alternating against one snapshot and `TARGET_REF` selecting the second. Seed once with the checkout; every trial after that uses `SKIP_LOAD=1`:

```bash
export SCALE=bench TIER=2 COMPOSE_EXTRA=compose.tier2.yaml SAMPLES_DIR=$S/samples \
  PRE_START_HOOK='sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null'
TRIALS=0 ./containers/run-benchmark.sh                                  # build, seed, snapshot
SKIP_LOAD=1 TRIALS=1 ./containers/run-benchmark.sh                      # the checkout (batched quotes)
SKIP_LOAD=1 TRIALS=1 TARGET_REF='dd3a5f5^' ./containers/run-benchmark.sh  # the build before batching
```

The snapshot's provenance checks the build's schema, so `TARGET_REF` cannot restore a snapshot whose storage it does not match.

## Fixed run conditions

These choices affect measurements and must match across targets:

- **Bridge networking.** Mixing host and bridge networking would invalidate a comparison.
- **Plain HTTP on both ports.** TLS termination is excluded.
- **No response compression.** Harper compresses only for clients that accept brotli, with `http.compressionThreshold` set, and neither holds here. A competing stack must not compress either.
- **Named volume on a real filesystem.** Never tmpfs.
- **Base images pinned by digest** (`x-base-images` in [compose.yaml](compose.yaml)): multi-arch index digests of `node:24` and `node:24-slim`, the same release on both tiers. The Dockerfile takes them as build arguments and has no default.
- **Pinned Harper version**, installed globally and checked at build time, with msgpackr's native decoder verified loaded. Its linux-arm64 prebuilt ships only musl binaries, so the image compiles it; without it, an arm64 target runs a slower Harper than an x86-64 one.
- **No healthcheck in any target container.** A healthcheck runs its probe inside the target's budget for the whole run. Readiness is probed from the host.
- **Production dependency install:** `npm install --force --omit=dev --ignore-scripts`, matching Harper's deployment path.

## Lifecycle

1. **Seed:** expand, verify, and load the dataset into an emptied volume; loading is not measured.
2. **Snapshot:** archive the loaded state for trial restore, with a provenance record beside it.
3. **Cold start:** stop the target, run `PRE_START_HOOK`, start it, and record the time to the first successful (2xx) response. The probe polls the published port from the host every 25 ms ([wait-ready.mjs](wait-ready.mjs)).
4. **Warm-up:** drive a fixed workload, identical across targets: 120,000 requests at 100 rps on `bench` (about 20 minutes, long enough for a target to fill its memory budget), 2,000 at 200 rps on `dev`.
5. **Measure:** run the load ladder.
6. **Verify:** check the run record with [verify-run-record.mjs](../scripts/verify-run-record.mjs). A failing trial, or one whose generator failed, is reported and its record kept; re-run it.

Every trial, the first included, starts by restoring the snapshot, so earlier writes do not alter later trials' starting state and trial 1 is not the odd one out. Cold, warm, and hot phases are recorded separately; the cold start also records how much of it the compose CLI took. A successful readiness response is not a correctness check. The target is stopped with a 120 s grace, and a snapshot is refused if it did not exit cleanly.

Snapshots are named `<scale>-harper-<version>-dataset-<generator version>.tar.gz`, so a new Harper version or a regenerated dataset writes a new snapshot beside the old ones. The provenance record names the dataset manifest hash, schema hash (comments excluded), Harper version, image, and architecture, and a restore refuses a snapshot whose scale, dataset, schema, version, or architecture differs from the run's, or is unknown. An existing snapshot without a record is refused unless `ALLOW_UNVERIFIED_SNAPSHOT=1`.

## Accounting

The generator reads the target's CPU per step from cgroup v2 `cpu.stat`, through a read-only mount of the host's cgroup tree: the target container's scope by default, or the cgroups in `TARGET_CGROUPS` (a separated stack's containers, or a tier-2 slice). Each step records its wall-clock start, offer end, and drain end, so host-side samples such as tier 2's per-cgroup cycle counts can be joined to it. The orchestrator passes the conditions the generator cannot see — Harper version, image and base-image digests, budget requested and applied, compose files, tier, snapshot provenance, cold start, and other containers running on the machine — and they are recorded under `conditions.orchestrator`.

Output is stored in the `bench-results` volume at `/results`.

## Tier-1 disk space

A Podman VM's disk image grows as the data volume is wiped and restored, and does not return freed blocks to macOS by itself. `podman machine ssh sudo fstrim -v /` returns them; one trim after a seed and two restores freed 16 GB on the host.

## Rebuild after code changes

Application code is copied into the image at build time. `docker compose up` alone does not rebuild it. The orchestrator always builds; for a manual cycle, run:

```bash
docker compose -f containers/compose.yaml build harper
```

## Host limitations

The CPU clock is not pinned, so these runs cannot support cycle-normalized efficiency claims. Target CPU is per container; Harper is one container, so it has no framework/database/cache breakdown, while an assembled stack gets one figure per container.

On macOS, Podman runs in a VM. Resource limits apply within its allocation, and the VM adds a network boundary. Valid controlled comparisons need a Linux host and the remaining [measurement gaps](../bench/README.md#limitations) closed.
