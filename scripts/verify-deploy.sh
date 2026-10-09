#!/usr/bin/env bash
# Simulate exactly what `deploy_component` does to this repo, and assert that nothing
# dev-only reaches the node.
#
# Harper packs a component with `npm pack --ignore-scripts`, extracts it to
# components/<project>, then runs `npm install --force --omit=dev --no-audit --no-fund`
# with the component root as cwd. This reproduces that, offline from any Harper instance.
#
# Run it after adding ANY dependency. Optional peer dependencies make dev tooling leak onto
# the node without appearing anywhere in a manifest — see docs/structure.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Tools that must never be installed on a node. Extend as the repo grows.
# @playwright/* is listed even though nothing currently pulls it: it arrived once as an
# OPTIONAL PEER dependency of a web framework, which no manifest makes visible.
FORBIDDEN=(@playwright/test playwright playwright-core harper typescript)

echo "==> packing $REPO_ROOT"
cd "$WORK"
TARBALL="$(npm pack --json --ignore-scripts "$REPO_ROOT" | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].filename))')"

mkdir -p node
tar -xzf "$TARBALL" -C node --strip-components=1

echo "==> installing as Harper does"
cd node
npm install --force --omit=dev --no-audit --no-fund >/dev/null 2>&1

status=0
for pkg in "${FORBIDDEN[@]}"; do
  if [ -e "node_modules/$pkg" ]; then
    echo "FAIL: '$pkg' reached the node. Run: npm ls $pkg --omit=dev" >&2
    status=1
  fi
done

# The application itself must still resolve. P0 has no external runtime dependencies —
# the only thing that must land is the spec workspace.
for pkg in @ecommerce-store/spec; do
  if [ ! -e "node_modules/$pkg" ]; then
    echo "FAIL: runtime dependency '$pkg' is MISSING from the node" >&2
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  echo "OK: nothing dev-only reached the node"
fi
exit "$status"
