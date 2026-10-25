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

do_compare_all() {
  log "running the FULL comparison matrix (43 cases x 5 subjects incl. WASMER)"
  local out
  out="$REPORTS/runs/compare-all-$(date -u +%Y%m%dT%H%M%SZ)"
  cd "$DSH"
  node --experimental-strip-types "$HG_SCRIPTS/sandbox-compare/run.ts" --smoke=all --out="$out" 2>&1 | tee "$out.log"
}

do_compare_cube() {
  log "running the CUBE lane (expected outcome: evidence-backed not-run records)"
  local out
  out="$REPORTS/runs/compare-cube-$(date -u +%Y%m%dT%H%M%SZ)"
  cd "$DSH"
  node --experimental-strip-types "$HG_SCRIPTS/sandbox-compare/run.ts" --smoke=all --subjects=CUBE --out="$out" 2>&1 | tee "$out.log"
}

do_perf() {
  log "running PERF baseline sampler"
  local out
  out="$REPORTS/runs/perf-$(date -u +%Y%m%dT%H%M%SZ)"
  cd "$DSH"
  node --experimental-strip-types "$HG_SCRIPTS/sandbox-compare/perf.ts" --runs="${PERF_RUNS:-30}" --out="$out" 2>&1 | tee "$out.log"
}

do_rob04() {
  log "running ROB-04 lifecycle loop (${ROB04_CYCLES:-1000} cycles)"
  cd "$DSH"
  node --experimental-strip-types /opt/dsh/packages/hourglass/lifecycle/index.ts \
    --cycles="${ROB04_CYCLES:-1000}" --out="$REPORTS/runs/rob04-latest.json" 2>&1 | tee "$REPORTS/runs/rob04-latest.txt"
}

do_evolution_smoke() {
  log "running evolution gate pipeline (improved candidate must pass)"
  set +e
  node --experimental-strip-types "$DSH/packages/hourglass/evolution-runner/run.ts" \
    --out="$REPORTS/runs/evolution-smoke-latest" 2>&1 | tee "$REPORTS/runs/evolution-smoke-latest.txt"
  local smoke_status=${PIPESTATUS[0]}
  set -e
  [ "$smoke_status" -eq 0 ] || return "$smoke_status"
  log "running evolution gate pipeline (no-change candidate must be rejected)"
  set +e
  node --experimental-strip-types "$DSH/packages/hourglass/evolution-runner/run.ts" \
    --out="$REPORTS/runs/evolution-nochange-latest" --candidate=nochange --expect=reject 2>&1 | tee "$REPORTS/runs/evolution-nochange-latest.txt"
  local nochange_status=${PIPESTATUS[0]}
  set -e
  return "$nochange_status"
}

do_agent_tasks_selftest() {
  log "running agent-lane task-set selftest (real tasks, judge discrimination, zero model)"
  set +e
  node --experimental-strip-types "$DSH/packages/hourglass/evolution-runner/agent-lane/tasks-selftest.ts" \
    --out="$REPORTS/runs/agent-tasks-selftest-latest" 2>&1 | tee "$REPORTS/runs/agent-tasks-selftest-latest.txt"
  local status=${PIPESTATUS[0]}
  set -e
  return "$status"
}

do_agent_carrier_smoke() {
  log "running agent-lane carrier probe (P1-P4 evidence, mock LLM only)"
  set +e
  node --experimental-strip-types "$DSH/packages/hourglass/evolution-runner/agent-lane/carrier-probe.ts"     --out="$REPORTS/runs/agent-carrier-latest" 2>&1 | tee "$REPORTS/runs/agent-carrier-latest.txt"
  local status=${PIPESTATUS[0]}
  set -e
  return "$status"
}

do_evolution_coverage() {
  log "running evolution per-file 100% coverage gate (evolution packages only)"
  local previous_pwd=$PWD
  cd "$DSH"
  set +e
  NO_COLOR=1 pnpm exec vitest run packages/hourglass/evolution-contract packages/hourglass/evolution-trial \
    --config vitest.config.ts --coverage \
    --coverage.include='packages/hourglass/evolution-contract/src/**' \
    --coverage.include='packages/hourglass/evolution-trial/src/**' 2>&1 | tee "$REPORTS/runs/evolution-coverage-latest.txt"
  local status=${PIPESTATUS[0]}
  set -e
  cd "$previous_pwd"
  grep -qE 'Test Files[[:space:]]+[0-9]+ passed' "$REPORTS/runs/evolution-coverage-latest.txt" \
    || { echo '[hourglass] evolution coverage gate failed: no passing test files summary' >&2; exit 1; }
  return "$status"
}

do_evolution_nightly() {
  log "running evolution nightly drill (cycles=${EVOLUTION_NIGHTLY_CYCLES:-50}, journal appends=${EVOLUTION_JOURNAL_APPENDS:-1000}, determinism=${EVOLUTION_DETERMINISM_RUNS:-3})"
  local previous_pwd=$PWD
  local out
  out="$REPORTS/runs/evolution-nightly-$(date -u +%Y%m%dT%H%M%SZ)"
  set +e
  node --experimental-strip-types "$DSH/packages/hourglass/evolution-runner/nightly.ts" --out="$out" 2>&1 | tee "$REPORTS/runs/evolution-nightly-latest.txt"
  local status=${PIPESTATUS[0]}
  set -e
  cd "$previous_pwd"
  return "$status"
}

case "${1:-bash}" in
  gates)        do_gates ;;
  unit)         do_unit ;;
  compare)      do_compare ;;
  compare-all)  do_compare_all ;;
  compare-cube) do_compare_cube ;;
  perf)         do_perf ;;
  rob04)        do_rob04 ;;
  evolution-smoke)    do_evolution_smoke ;;
  evolution-coverage) do_evolution_coverage ;;
  evolution-nightly)  do_evolution_nightly ;;
  agent-tasks-selftest)  do_agent_tasks_selftest ;;
  agent-carrier-smoke) do_agent_carrier_smoke ;;
  run-all)      do_gates; do_unit; do_evolution_smoke; do_evolution_coverage; do_agent_tasks_selftest; do_agent_carrier_smoke; do_compare; do_perf; do_rob04 ;;
  bash)         exec bash ;;
  *)            exec "$@" ;;
esac
