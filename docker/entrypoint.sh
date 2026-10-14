#!/usr/bin/env bash
# hourglass test container entrypoint.
# Usage:
#   hourglass-entrypoint unit      — run hourglass package unit tests (incl. REAL-composition loader)
#   hourglass-entrypoint compare   — run the sandbox comparison matrix
#   hourglass-entrypoint gates     — run hourglass gates (versions-lock, policy golden)
#   hourglass-entrypoint run-all   — everything, in order
#   hourglass-entrypoint bash      — interactive shell (default)
#
# hourglass sources are consumed directly (vitest / node --experimental-strip-types);
# no tsc pre-build is required and none is performed.
set -euo pipefail

DSH=/opt/dsh
HG_SCRIPTS=/opt/hourglass/scripts
REPORTS=/opt/reports
mkdir -p "$REPORTS/runs"

log() { printf '\n[hourglass] %s\n' "$*" >&2; }

do_gates() {
  log "versions-lock gate"
  node --experimental-strip-types "$HG_SCRIPTS/sandbox-compare/validate-versions-lock.ts" 2>&1 | tee "$REPORTS/runs/gate-versions-lock.txt"
}

do_unit() {
  log "running hourglass unit tests (packages/hourglass)"
  cd "$DSH"
  set +e
  NO_COLOR=1 pnpm exec vitest run packages/hourglass --config vitest.config.ts 2>&1 | tee "$REPORTS/runs/unit-latest.txt"
  local status=${PIPESTATUS[0]}
  set -e
  grep -qE 'Test Files[[:space:]]+[0-9]+ passed' "$REPORTS/runs/unit-latest.txt" \
    || { echo '[hourglass] unit gate failed: no passing test files summary' >&2; exit 1; }
  return "$status"
}

do_compare() {
  log "running sandbox comparison matrix"
  local out
  out="$REPORTS/runs/compare-$(date -u +%Y%m%dT%H%M%SZ)"
  cd "$DSH"
  node --experimental-strip-types "$HG_SCRIPTS/sandbox-compare/run.ts" --out="$out" 2>&1 | tee "$out.log"
}

do_perf() {
  log "running PERF baseline sampler"
  local out
  out="$REPORTS/runs/perf-$(date -u +%Y%m%dT%H%M%SZ)"
  cd "$DSH"
  node --experimental-strip-types "$HG_SCRIPTS/sandbox-compare/perf.ts" --runs="${PERF_RUNS:-30}" --out="$out" 2>&1 | tee "$out.log"
}

case "${1:-bash}" in
  gates)   do_gates ;;
  unit)    do_unit ;;
  compare) do_compare ;;
  perf)    do_perf ;;
  run-all) do_gates; do_unit; do_compare; do_perf ;;
  bash)    exec bash ;;
  *)       exec "$@" ;;
esac
