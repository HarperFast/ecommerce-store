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
- **Pinned Harper version**, installed globally and checked at build time.
- **Production dependency install:** `npm install --force --omit=dev`, matching Harper's deployment path.

## Lifecycle

1. **Seed:** expand, verify, and load the dataset; loading is not measured.
2. **Snapshot:** archive the loaded state for trial restore.
3. **Cold start:** restart the target and record the time to the first response accepted by the readiness probe.
4. **Warm-up:** drive a fixed workload, identical across targets.
5. **Measure:** run the load ladder.

Restore the snapshot between trials so earlier writes do not alter later trials' starting state. Cold, warm, and hot phases are recorded separately. The readiness probe accepts HTTP status below 500; this is not a correctness check.

Output is stored in the `bench-results` volume at `/results`.

## Rebuild after code changes

Application code is copied into the image at build time. `docker compose up` alone does not rebuild it. The orchestrator always builds; for a manual cycle, run:

```bash
docker compose -f containers/compose.yaml build harper
```

## Host limitations

The CPU clock is not pinned, so these runs cannot support cycle-normalized efficiency claims. Harper's CPU accounting is a single total; there is no framework/database/cache breakdown yet.

On macOS, Podman runs in a VM. Resource limits apply within its allocation, and the VM adds a network boundary. Valid controlled comparisons need a Linux host and the remaining [measurement gaps](../bench/README.md#limitations) closed.
