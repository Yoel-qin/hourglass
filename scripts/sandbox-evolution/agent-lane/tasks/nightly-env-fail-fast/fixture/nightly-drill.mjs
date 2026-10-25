// Long-loop drill CLI, minimal extraction: runs DRILL_CYCLES lifecycle
// cycles, then prints the nightly report line and exits 0. Operators drive
// the cycle count through the environment.
const CYCLES = Number.parseInt(process.env['DRILL_CYCLES'] ?? '50', 10)

function runCycle(cycle) {
  // one lifecycle cycle of work (fixture placeholder)
  return cycle
}

function main() {
  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    runCycle(cycle)
  }
  console.log(JSON.stringify({ phase: 'nightly', cycles: CYCLES, ok: true }))
  process.exit(0)
}

main()
