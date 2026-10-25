// Long-loop drill CLI, minimal extraction: runs DRILL_CYCLES lifecycle
// cycles, then prints the nightly report line and exits 0. Operators drive
// the cycle count through the environment.
/** Parse a required positive integer env var; fail fast on garbage. */
function positiveIntEnv(name, fallback) {
  const raw = process.env[name] ?? fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < 1 || String(value) !== raw.trim()) {
    throw new Error(`invalid ${name}: expected a positive integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

const CYCLES = positiveIntEnv('DRILL_CYCLES', '50')

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
