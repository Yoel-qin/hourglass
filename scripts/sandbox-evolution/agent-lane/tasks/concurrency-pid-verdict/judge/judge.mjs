// Hidden judge for task concurrency-pid-verdict. Real regression
// assertions carried over from the original fix (two files must change
// together): a missing marker file must surface as a failed phase with
// diagnostics instead of crashing the drill, and identical worker pids must
// fail the isolation verdict even when both markers look perfect.
// Protocol: node judge.mjs <workspaceDir>.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const workspace = process.argv[2]
const checks = []
const record = (name, ok, detail) => checks.push({ name, ok, detail })

const scratch = mkdtempSync(join(tmpdir(), 'judge-conc-'))
try {
  const drill = await import(pathToFileURL(join(workspace, 'drill.mjs')).href)
  const verdict = await import(pathToFileURL(join(workspace, 'verdict.mjs')).href)

  // 1. Defensive read: a missing marker is undefined, never a crash.
  let missing = 'no-throw'
  let missingValue
  try {
    missingValue = drill.readMarker(join(scratch, 'does-not-exist.txt'))
  } catch (error) {
    missing = `threw: ${String(error?.message ?? error)}`
  }
  record('missing-marker-reads-as-undefined', missing === 'no-throw' && missingValue === undefined,
    `outcome=${missing} value=${String(missingValue)}`)

  // 2. A present marker reads its text.
  const present = join(scratch, 'a-marker.txt')
  writeFileSync(present, 'ALPHA-MARKER\n', 'utf8')
  record('present-marker-reads-text', drill.readMarker(present) === 'ALPHA-MARKER',
    `value=${String(drill.readMarker(present))}`)

  const healthy = {
    aOk: true, bOk: true,
    markerA: 'ALPHA-MARKER', markerB: 'BETA-MARKER',
    pidA: 101, pidB: 202,
  }
  const healthyResult = verdict.concurrencyVerdict(healthy)
  record('healthy-run-passes', healthyResult.ok === true && healthyResult.detail.distinctPids === true,
    `verdict=${JSON.stringify(healthyResult)}`)

  // 3. THE regression: identical pids must fail the verdict.
  const samePid = verdict.concurrencyVerdict({ ...healthy, pidB: 101 })
  record('same-pid-fails-isolation', samePid.ok === false,
    `verdict=${JSON.stringify(samePid)}`)

  // 4. A crashed worker (marker undefined, aOk false) is a failed phase
  //    with diagnostics — produced without any crash.
  const crashed = verdict.concurrencyVerdict({
    aOk: false, bOk: true,
    markerA: undefined, markerB: 'BETA-MARKER',
    pidA: 101, pidB: 202,
  })
  record('crashed-worker-fails-with-diagnostics',
    crashed.ok === false && crashed.detail.aOk === false && crashed.detail.markerA === undefined,
    `verdict=${JSON.stringify(crashed)}`)
} catch (error) {
  record('judge-ran', false, String(error?.stack ?? error))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

const ok = checks.length > 0 && checks.every(check => check.ok)
console.log(`JUDGE-RESULT: ${JSON.stringify({ ok, checks })}`)
process.exit(ok ? 0 : 1)
