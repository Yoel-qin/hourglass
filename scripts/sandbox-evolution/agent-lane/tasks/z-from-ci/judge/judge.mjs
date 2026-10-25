// Hidden judge for task z-from-ci. Real regression assertions carried over
// from the original fix: the interval bound must be computed at the CALLER'S
// confidence level (standard two-sided normal quantiles), and confidence
// outside (0,1) must throw. Protocol: node judge.mjs <workspaceDir>;
// the last stdout line is `JUDGE-RESULT: {json}` and the exit code mirrors ok.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const workspace = process.argv[2]
const checks = []

function record(name, ok, detail) {
  checks.push({ name, ok, detail })
}

async function main() {
  const mod = await import(pathToFileURL(join(workspace, 'ci-gate.mjs')).href)

  // Standard two-sided quantiles — the levels the real regression test pinned.
  const levels = [
    { confidence: 0.90, z: 1.6448536269514722 },
    { confidence: 0.95, z: 1.959963984540054 },
    { confidence: 0.99, z: 2.5758293035489004 },
  ]
  const differences = [1, 1, 0, 0, 1, 0, 1, 1]
  const mean = differences.reduce((sum, value) => sum + value, 0) / differences.length
  const variance = differences.reduce((sum, value) => sum + (value - mean) ** 2, 0) / differences.length
  const standardError = Math.sqrt(variance / differences.length)

  for (const level of levels) {
    let detail = ''
    try {
      const got = mod.ciLowerBoundPct(differences, level.confidence)
      const expected = (mean - level.z * standardError) * 100
      const ok = typeof got === 'number' && Math.abs(got - expected) < 5e-7
      detail = ok ? `bound@${level.confidence}=${got.toFixed(6)}` : `expected ${expected.toFixed(6)}, got ${String(got)}`
      record(`bound-at-confidence-${level.confidence}`, ok, detail)
    } catch (error) {
      record(`bound-at-confidence-${level.confidence}`, false, `threw: ${String(error?.message ?? error)}`)
    }
  }

  // The bound must actually move with the level — a gate that ignores the
  // confidence argument is the defect being judged.
  try {
    const low = mod.ciLowerBoundPct(differences, 0.90)
    const high = mod.ciLowerBoundPct(differences, 0.99)
    const moved = typeof low === 'number' && typeof high === 'number' && high < low
    record('bound-varies-with-confidence', moved, `z0.90-bound=${String(low)} z0.99-bound=${String(high)}`)
  } catch (error) {
    record('bound-varies-with-confidence', false, `threw: ${String(error?.message ?? error)}`)
  }

  let rejected = true
  const badDetail = []
  for (const bad of [0, 1, -0.5, 1.5, Number.NaN]) {
    try {
      mod.ciLowerBoundPct(differences, bad)
      rejected = false
      badDetail.push(`${String(bad)} accepted`)
    } catch {
      badDetail.push(`${String(bad)} rejected`)
    }
  }
  record('rejects-confidence-outside-open-interval', rejected, badDetail.join(', '))
}

try {
  await main()
} catch (error) {
  record('judge-ran', false, String(error?.stack ?? error))
}

const ok = checks.length > 0 && checks.every(check => check.ok)
console.log(`JUDGE-RESULT: ${JSON.stringify({ ok, checks })}`)
process.exit(ok ? 0 : 1)
