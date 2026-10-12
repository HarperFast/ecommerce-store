#!/usr/bin/env bash
# Full local benchmark lifecycle, containerized.
#
# Implements the run lifecycle from the benchmarks README in order, because how a system is
# loaded determines what is resident when measurement starts:
#
#   1. Seed      — load the versioned dataset into an EMPTY target. NOT measured.
#   2. Cold      — start the target, measure time to first successful response.
#   3. Warm-up   — a fixed workload, identical for every target. Not a tuning budget.
#   4. Measure   — the reported run.
#
# Because the workload includes writes, state does not survive between trials. A snapshot is
# taken after seeding and restored before each trial, so the third trial is not measuring a
# catalog the first two already mutated.
#
# Settings (environment; containers/.env supplies defaults and never overrides what is set):
#
#   SCALE            dev | bench                                     (dev)
#   RATES DURATION   the ladder, offered rps and seconds per step    (25..200, 15)
#   TRIALS           measured trials; 0 seeds and snapshots only     (1)
#   SKIP_LOAD=1      restore the existing snapshot instead of seeding
#   COMPOSE_EXTRA    extra compose files layered over compose.yaml, space-separated, relative
#                    to containers/ — e.g. compose.tier2.yaml for tier-2 slice placement
#   TIER             1 (local containers) | 2 (Linux host); recorded, and sets the caveats
#   PRE_START_HOOK   host command run between stopping the target and its measured start —
#                    tier 2: `sync; echo 3 > /proc/sys/vm/drop_caches` (as root)
#   DATASET_ROOT     where expanded datasets live                    (<repo>/.work/dataset)
#   SNAPSHOT_DIR     where snapshots and their provenance live       (containers/.snapshots)
#   TARGET_CGROUPS   override the target's cgroups for CPU accounting, `name=id-or-/path,...`
#   CONDITIONS_DIR   an external run-conditions record (tier 2: conditions.sh), referenced
#   KEEP_TARGET=1    leave the target running at the end
#   ALLOW_UNVERIFIED_SNAPSHOT=1   restore a snapshot whose provenance is missing or differs
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
REPO="$(cd .. && pwd)"

# Resolve the container CLI rather than assuming `docker`.
#
# On a Podman host `docker` is commonly a shell ALIAS, which exists in an interactive shell
# and does not exist inside a script — so this failed with "docker: command not found" only
# when run non-interactively, which is the only way it is ever actually run.
if command -v docker >/dev/null 2>&1; then
  CONTAINER_CLI=docker
elif command -v podman >/dev/null 2>&1; then
  CONTAINER_CLI=podman
else
  echo "need docker or podman on PATH" >&2
  exit 1
fi

# Load the local container settings — the loader authenticates against the operations API,
# which `harper run` requires. A variable already set in the environment wins: sourcing the
# file with `set -a` silently replaced `TARGET_CPUS=4 ./run-benchmark.sh` with the file's 2.
if [ ! -f .env ]; then
  echo "containers/.env not found — copy containers/.env.example and set a password" >&2
  exit 1
fi
while IFS='=' read -r key value || [ -n "$key" ]; do
  key="${key#export }"; key="${key//[[:space:]]/}"
  case "$key" in ''|\#*) continue ;; esac
  value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
  [ -n "${!key+set}" ] || export "$key=$value"
done < .env

SCALE="${SCALE:-dev}"
# Default ladder brackets the knee at BENCH scale, where the working set does not fit in
# memory and capacity is an order of magnitude below dev. A 400-2400 ladder spent four of
# its five steps past collapse, which locates nothing.
RATES="${RATES:-25,50,75,100,125,150,200}"
DURATION="${DURATION:-15}"
TRIALS="${TRIALS:-1}"
TIER="${TIER:-1}"
# package.json is the one source of truth for the platform version, as in CI. The Dockerfile
# and compose defaults are fallbacks for manual builds and must not drift from it.
export HARPER_VERSION="${HARPER_VERSION:-$(node -p "require('../package.json').devDependencies.harper")}"
export TARGET_CPUS="${TARGET_CPUS:-2}"
export TARGET_MEMORY="${TARGET_MEMORY:-2g}"
export HARPER_THREADS="${HARPER_THREADS:-2}"
export DATASET_ROOT="${DATASET_ROOT:-$REPO/.work/dataset}"
SNAPSHOT_DIR="${SNAPSHOT_DIR:-$PWD/.snapshots}"
mkdir -p "$DATASET_ROOT" "$SNAPSHOT_DIR"

COMPOSE_FILES="compose.yaml ${COMPOSE_EXTRA:-}"
COMPOSE="$CONTAINER_CLI compose"
for file in $COMPOSE_FILES; do COMPOSE="$COMPOSE -f $file"; done

if [ "$SCALE" = dev ]; then
  DATASET_HOST="$REPO/dataset/dev"
  DATASET_IN_BENCH=/work/dataset/dev
else
  DATASET_HOST="$DATASET_ROOT/$SCALE"
  DATASET_IN_BENCH="/dataset/$SCALE"
fi
SNAPSHOT="$SNAPSHOT_DIR/${SCALE}-harper-${HARPER_VERSION}.tar.gz"
PROBE_URL="http://localhost:9926/product/product-000000?tier=standard&region=us-east"

say() { printf '\n==> %s\n' "$*"; }
now_ms() { node -e 'console.log(Date.now())'; }
sha256_of() { node -e "const c=require('node:crypto').createHash('sha256'); for (const f of process.argv.slice(1)) c.update(require('node:fs').readFileSync(f)); console.log(c.digest('hex'))" "$@"; }
# The schema as storage sees it: comments and blank lines are not part of it, so editing a
# comment does not orphan every snapshot.
schema_sha256() { node -e "const c=require('node:crypto').createHash('sha256'); for (const f of process.argv.slice(1)) for (const line of require('node:fs').readFileSync(f, 'utf8').split('\n')) { const code = line.replace(/#.*/, '').trim(); if (code) c.update(code + '\n'); } console.log(c.digest('hex'))" "$@"; }

target_id() { $COMPOSE ps -aq harper 2>/dev/null | head -1; }
# A long grace: a store SIGKILLed after a 40M-row load would make every trial pay its crash
# recovery inside the cold start.
stop_target() { $COMPOSE stop -t 120 harper >/dev/null 2>&1 || true; }
start_target() { $COMPOSE up -d harper >/dev/null; }
assert_clean_exit() {
  local code
  code="$($CONTAINER_CLI inspect --format '{{.State.ExitCode}}' "$(target_id)" 2>/dev/null || echo unknown)"
  if [ "$code" != 0 ]; then
    echo "the target exited with status $code; refusing to archive a store that did not shut down cleanly" >&2
    exit 1
  fi
}
wait_ready() { node wait-ready.mjs --url "$PROBE_URL" --accept "$1" --since "$2"; }

# Snapshot provenance: what the archived storage was produced by. A snapshot taken under
# another Harper version, schema (indexes are storage), dataset, or architecture is not the
# state this run claims to start from — a tier-1 arm64 snapshot copied to an x86-64 tier-2
# host would otherwise be restored without complaint.
provenance() {
  node -e '
    const [scale, manifestSha, schemaSha, harperVersion, arch, imageId, commit, dirty] = process.argv.slice(1);
    console.log(JSON.stringify({ scale, datasetManifestSha256: manifestSha, schemaSha256: schemaSha, harperVersion, arch, imageId, code: { commit, dirty: dirty === "1" } }));
  ' "$SCALE" "$(sha256_of "$DATASET_HOST/MANIFEST.json")" "$(schema_sha256 "$REPO"/schemas/*.graphql)" \
    "$HARPER_VERSION" "$IMAGE_ARCH" "$IMAGE_ID" "$CODE_COMMIT" "$CODE_DIRTY"
}
check_provenance() {
  local recorded="$SNAPSHOT.json"
  if [ ! -f "$recorded" ]; then
    echo "snapshot $SNAPSHOT has no provenance record ($recorded)" >&2
    [ "${ALLOW_UNVERIFIED_SNAPSHOT:-0}" = 1 ] && return 0
    exit 1
  fi
  node -e '
    const recorded = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const current = JSON.parse(process.argv[2]);
    const keys = ["scale", "datasetManifestSha256", "schemaSha256", "harperVersion", "arch"];
    const differs = keys.filter((k) => recorded[k] !== current[k] || current[k] === "unknown");
    for (const k of differs) console.error(`snapshot ${k}: ${recorded[k]}, this run: ${current[k]}`);
    process.exit(differs.length ? 1 : 0);
  ' "$recorded" "$(provenance)" || { [ "${ALLOW_UNVERIFIED_SNAPSHOT:-0}" = 1 ] || exit 1; }
}

restore_snapshot() {
  stop_target
  $COMPOSE run --rm --no-deps -v "$SNAPSHOT_DIR:/snap:ro" harper \
    bash -c "rm -rf /data/* /data/.[!.]* && tar -C /data -xzf /snap/$(basename "$SNAPSHOT")" >/dev/null
}

# Targets share one budget on tier 2: a resident target holds memory inside the next one's. A
# trap, so a failure part-way through stops it too.
finish() { [ "${KEEP_TARGET:-0}" = 1 ] || stop_target; }
trap finish EXIT

CODE_COMMIT="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo)"
CODE_DIRTY="$([ -n "$(git -C "$REPO" status --porcelain 2>/dev/null)" ] && echo 1 || echo 0)"

say "building target (harper=$HARPER_VERSION cpus=$TARGET_CPUS memory=$TARGET_MEMORY threads=$HARPER_THREADS tier=$TIER)"
$COMPOSE build harper
IMAGE_ID="$($CONTAINER_CLI image inspect --format '{{.Id}}' "$($COMPOSE config --images harper 2>/dev/null | head -1)" 2>/dev/null || echo unknown)"
IMAGE_ARCH="$($CONTAINER_CLI image inspect --format '{{.Architecture}}' "$IMAGE_ID" 2>/dev/null || echo unknown)"

# --- 1. seed (not measured) --------------------------------------------------------------
#
# SKIP_LOAD reuses an existing snapshot instead of reloading. Loading 40M rows takes ~19
# minutes and is explicitly not measured, so re-paying it to re-run a ladder buys nothing.
# The RESTORE is not optional even then: a previous run's background writes mutated the
# data, and a trial must start from the state the snapshot captured.
if [ "${SKIP_LOAD:-0}" = "1" ]; then
  if [ ! -f "$SNAPSHOT" ]; then
    echo "SKIP_LOAD=1 but $SNAPSHOT does not exist" >&2
    exit 1
  fi
  check_provenance
  say "SKIP_LOAD — trials restore $(basename "$SNAPSHOT")"
else
  if [ "$SCALE" != "dev" ]; then
    say "expanding $SCALE dataset into $DATASET_HOST"
    (cd .. && node scripts/prepare-dataset.mjs --scale "$SCALE" --out "$DATASET_HOST")
  fi

  # Into an EMPTY target. The loader upserts, so loading over a previous state kept every row
  # the incoming dataset does not contain — a dev load over a bench volume is a mix of two
  # datasets that reports a clean load.
  say "seeding an empty target"
  stop_target
  $COMPOSE run --rm --no-deps harper bash -c 'rm -rf /data/* /data/.[!.]*' >/dev/null
  start_target
  wait_ready any "$(now_ms)" >/dev/null

  say "loading dataset ($SCALE) — not measured"
  (cd .. && node scripts/load-dataset.mjs --scale "$SCALE" --dataset "$DATASET_HOST" --url http://localhost:9925)

  # --- snapshot, so trials start from identical state ---------------------------------------
  say "snapshotting loaded state to $(basename "$SNAPSHOT")"
  stop_target
  assert_clean_exit
  rm -f "$SNAPSHOT.json"
  # NO `-v harper-data:/data` here: that names an UNSCOPED volume, while the service uses the
  # compose-project-scoped `harper-ecommerce-bench_harper-data`. The explicit mount replaced
  # the service's own, so the snapshot archived an empty volume and the restore restored it.
  $COMPOSE run --rm --no-deps -v "$SNAPSHOT_DIR:/snap" harper \
    bash -c "tar -C /data -czf /snap/$(basename "$SNAPSHOT").partial . && mv /snap/$(basename "$SNAPSHOT").partial /snap/$(basename "$SNAPSHOT")" >/dev/null
  provenance | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify({...JSON.parse(s), createdAt: new Date().toISOString()}, null, 2)))' > "$SNAPSHOT.json"
fi

image_digest() { $CONTAINER_CLI image inspect --format '{{index .RepoDigests 0}}' "$1" 2>/dev/null || echo unknown; }
BASE_DIGESTS="node:24=$(image_digest node:24),node:24-slim=$(image_digest node:24-slim)"

failed_trials=0
trial=1
while [ "$trial" -le "$TRIALS" ]; do
  # Every trial, the first included, starts from a restore: the same bytes, written the same
  # way, so trial 1 does not differ from the rest by having the volume the seed left behind.
  say "trial $trial — restoring $(basename "$SNAPSHOT")"
  restore_snapshot

  # --- 2. cold start ----------------------------------------------------------------------
  # stop → hook → start, so the hook (a page-cache drop on tier 2) lands between them. The
  # probe runs on the host, outside the target's budget, every 25 ms.
  say "trial $trial — cold start"
  stop_target
  if [ -n "${PRE_START_HOOK:-}" ]; then
    say "pre-start hook: $PRE_START_HOOK"
    bash -c "$PRE_START_HOOK"
  fi
  cold_start=$(now_ms)
  start_target
  up_returned=$(now_ms)
  cold_ms=$(wait_ready ok "$cold_start")
  say "trial $trial — cold start to first successful response: ${cold_ms}ms ($((up_returned - cold_start))ms of it in compose up)"

  target="$(target_id)"
  cgroups="${TARGET_CGROUPS:-harper=$target}"
  limits="$($CONTAINER_CLI inspect --format '{{.HostConfig.NanoCpus}} {{.HostConfig.CpuQuota}} {{.HostConfig.CpuPeriod}} {{.HostConfig.Memory}} {{.HostConfig.CgroupParent}}' "$target" 2>/dev/null || echo)"
  others="$($CONTAINER_CLI ps --format '{{.Names}}' | grep -v '^harper-ecommerce-bench' | paste -sd, - || true)"
  conditions="$(node -e '
    const [tier, cli, cliVersion, composeFiles, harperVersion, imageId, arch, cpus, memory, threads, benchCpus, benchMemory, snapshot, hook, conditionsDir, others, coldMs, upMs, limits, baseDigests, benchImage] = process.argv.slice(1);
    let snapshotProvenance = null;
    try { snapshotProvenance = JSON.parse(require("node:fs").readFileSync(snapshot + ".json", "utf8")); } catch {}
    const [nanoCpus, cpuQuota, cpuPeriod, memoryBytes, cgroupParent] = limits.split(" ");
    console.log(JSON.stringify({
      tier: Number(tier), containerCli: cli, containerCliVersion: cliVersion, composeFiles: composeFiles.trim().split(/\s+/),
      network: "compose bridge", tls: false,
      target: {
        harperVersion, image: { id: imageId, arch }, baseImages: Object.fromEntries(baseDigests.split(",").map((pair) => pair.split("="))),
        budget: { cpus: Number(cpus), memory, threads: Number(threads) },
        // What the runtime actually applied, not what was asked for.
        applied: { nanoCpus: Number(nanoCpus) || null, cpuQuota: Number(cpuQuota) || null, cpuPeriod: Number(cpuPeriod) || null, memoryBytes: Number(memoryBytes) || null, cgroupParent: cgroupParent || null },
      },
      generator: { image: benchImage, budget: { cpus: Number(benchCpus), memory: benchMemory } },
      snapshot: { file: require("node:path").basename(snapshot), provenance: snapshotProvenance },
      preStartHook: hook || null,
      coldStart: { ms: Number(coldMs), composeUpMs: Number(upMs), probe: "host, published port, 25 ms, first 2xx; timed from before compose up" },
      conditionsDir: conditionsDir || null,
      otherContainersRunning: others ? others.split(",") : [],
    }));
  ' "$TIER" "$CONTAINER_CLI" "$($CONTAINER_CLI --version)" "$COMPOSE_FILES" "$HARPER_VERSION" "$IMAGE_ID" "$IMAGE_ARCH" \
    "$TARGET_CPUS" "$TARGET_MEMORY" "$HARPER_THREADS" "${BENCH_CPUS:-2}" "${BENCH_MEMORY:-1g}" "$SNAPSHOT" \
    "${PRE_START_HOOK:-}" "${CONDITIONS_DIR:-}" "$others" "$cold_ms" "$((up_returned - cold_start))" "$limits" \
    "$BASE_DIGESTS" "$(image_digest node:24-slim)")"
  [ -n "$others" ] && say "other containers running on this machine (recorded): $others"

  # --- 3 + 4. warm-up and measure, from a container OUTSIDE the target's budget -----------
  # --no-deps: a target that died after its cold start must fail the trial, not be silently
  # started again by compose with a start nobody measured.
  say "trial $trial — ladder $RATES"
  log="$(mktemp)"
  if ! $COMPOSE run --rm --no-deps \
    -e RUN_CONDITIONS="$conditions" -e TARGET_CGROUPS="$cgroups" \
    -e CODE_COMMIT="$CODE_COMMIT" -e CODE_DIRTY="$CODE_DIRTY" \
    bench node bench/run.mjs \
    --url http://harper:9926 \
    --dataset "$DATASET_IN_BENCH" \
    --rates "$RATES" --duration "$DURATION" --out /results \
    --cold-ms "$cold_ms" | tee "$log"; then
    echo "trial $trial: the generator failed; the steps it finished are in its record" >&2
    failed_trials=$((failed_trials + 1))
  fi
  record="$(sed -n 's/^run record: //p' "$log" | tail -1)"
  rm -f "$log"

  # --- run-level requirements and measurement rules, against the record just written ------
  # A trial that fails is re-run; its record is kept, never deleted.
  if [ -n "$record" ]; then
    say "trial $trial — verifying $record"
    if ! $COMPOSE run --rm --no-deps bench node scripts/verify-run-record.mjs $([ "$SCALE" = dev ] && echo --dev) "$record"; then
      failed_trials=$((failed_trials + 1))
    fi
  fi
  trial=$((trial + 1))
done

say "results are in the bench-results volume:"
echo "  $COMPOSE run --rm --no-deps bench ls -la /results"
if [ "$failed_trials" -gt 0 ]; then
  echo "$failed_trials trial check(s) failed — re-run those trials; their records are kept" >&2
  exit 1
fi
