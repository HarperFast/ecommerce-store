#!/usr/bin/env bash
# Full local benchmark lifecycle, containerized.
#
# Implements the run lifecycle from the benchmarks README in order, because how a system is
# loaded determines what is resident when measurement starts:
#
#   1. Seed      — load the versioned dataset. NOT measured.
#   2. Cold      — start the target, measure time to first successful response.
#   3. Warm-up   — a fixed workload, identical for every target. Not a tuning budget.
#   4. Measure   — the reported run.
#
# Because the workload includes writes, state does not survive between trials. A snapshot is
# taken after seeding and restored before each trial, so the third trial is not measuring a
# catalog the first two already mutated.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
COMPOSE="docker compose -f compose.yaml"

SCALE="${SCALE:-dev}"
RATES="${RATES:-400,800,1200,1600,2400}"
DURATION="${DURATION:-15}"
TRIALS="${TRIALS:-1}"
export TARGET_CPUS="${TARGET_CPUS:-2}"
export TARGET_MEMORY="${TARGET_MEMORY:-2g}"
export HARPER_THREADS="${HARPER_THREADS:-2}"

say() { printf '\n==> %s\n' "$*"; }

say "building target (cpus=$TARGET_CPUS memory=$TARGET_MEMORY threads=$HARPER_THREADS)"
$COMPOSE build harper

say "starting target"
$COMPOSE up -d harper

say "waiting for health"
for _ in $(seq 1 60); do
  status=$($COMPOSE ps --format json harper 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s.trim().split("\n")[0]);console.log(j.Health||j.State||"")}catch{console.log("")}})' || echo "")
  [ "$status" = "healthy" ] && break
  sleep 3
done
say "target health: ${status:-unknown}"

# --- 1. seed (not measured) --------------------------------------------------------------
if [ "$SCALE" != "dev" ]; then
  say "expanding $SCALE dataset"
  (cd .. && node scripts/prepare-dataset.mjs --scale "$SCALE")
fi

say "loading dataset ($SCALE) — not measured"
(cd .. && node scripts/load-dataset.mjs --scale "$SCALE" --url http://localhost:9925)

# --- snapshot, so trials start from identical state ---------------------------------------
say "snapshotting loaded state for trial restore"
$COMPOSE stop harper >/dev/null
# NO `-v harper-data:/data` here: that names an UNSCOPED docker volume, while the service
# uses the compose-project-scoped `harper-ecommerce-bench_harper-data`. The explicit mount
# replaced the service's own, so the snapshot archived an empty volume and the restore
# restored it — leaving the target's mutated state to survive between trials, which is the
# exact thing the snapshot exists to prevent.
$COMPOSE run --rm --no-deps -v "$PWD/.snapshots:/snap" harper \
  bash -c "tar -C /data -czf /snap/${SCALE}.tar.gz ." >/dev/null
$COMPOSE up -d harper

for trial in $(seq 1 "$TRIALS"); do
  if [ "$trial" -gt 1 ]; then
    say "restoring snapshot for trial $trial"
    $COMPOSE stop harper >/dev/null
    $COMPOSE run --rm --no-deps -v "$PWD/.snapshots:/snap" harper \
      bash -c "rm -rf /data/* && tar -C /data -xzf /snap/${SCALE}.tar.gz" >/dev/null
    $COMPOSE up -d harper
    sleep 10
  fi

  # --- 2. cold start ----------------------------------------------------------------------
  say "trial $trial — cold start"
  $COMPOSE restart harper >/dev/null
  cold_start=$(node -e 'console.log(Date.now())')
  until $COMPOSE exec -T harper node -e \
      "fetch('http://localhost:9926/product/product-000000?tier=standard&region=us-east').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))" 2>/dev/null; do
    sleep 1
  done
  cold_ms=$(node -e "console.log(Date.now() - $cold_start)")
  say "trial $trial — cold start to first response: ${cold_ms}ms"

  # --- 3 + 4. warm-up and measure, from a container OUTSIDE the target's budget -----------
  say "trial $trial — ladder $RATES"
  $COMPOSE run --rm bench node bench/run.mjs \
    --url http://harper:9926 --ops http://harper:9925 \
    --dataset "$( [ "$SCALE" = dev ] && echo /work/dataset/dev || echo /work/.work/dataset/$SCALE )" \
    --rates "$RATES" --duration "$DURATION" --out /results \
    --cold-ms "$cold_ms"
done

say "results are in the bench-results volume:"
echo "  docker compose -f containers/compose.yaml run --rm bench ls -la /results"
