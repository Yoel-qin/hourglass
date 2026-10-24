/**
 * Evolution nightly drill (v3.1 §11.2 evolution-nightly, ROB-04 discipline):
 * long-loop lifecycle exercises against the REAL trial lane. Four phases:
 *
 *   1. journal-stress  — N appends, chain verifies clean, tamper still detects
 *   2. trial-lifecycle — N real runTrial cycles (bwrap child each), all ok,
 *                        fd/RSS drift reported (fd hard-bounded)
 *   3. concurrency     — two parallel trials, isolated workspaces, no
 *                        cross-contamination of outputs (EVO-TRIAL-10)
 *   4. determinism     — the full gate pipeline run R times, verdict must be
 *                        identical every time (EVO-BENCH-01 discipline)
 *
 * Exit non-zero on any failure. Cycles are env-tunable so CI can run a
 * reduced smoke variant (EVOLUTION_NIGHTLY_CYCLES / EVOLUTION_JOURNAL_APPENDS
 * / EVOLUTION_DETISM_RUNS).
 *
 * Usage (container, WORKDIR /opt/dsh):
 *   node --experimental-strip-types \
 *     /opt/dsh/packages/hourglass/evolution-runner/nightly.ts --out=<dir>
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EvolutionJournal } from '@hourglass/evolution-trial/src/evolution-journal.ts'
import { buildTrialConfinement, runTrial } from '@hourglass/evolution-trial/src/index.ts'

const BASE_DIR = fileURLToPath(new URL('.', import.meta.url))

/** Parse a required positive integer env var; fail fast on garbage (PR #9). */
function positiveIntEnv(name: string, fallback: string): number {
  const raw = process.env[name] ?? fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < 1 || String(value) !== raw.trim()) {
    throw new Error(`invalid ${name}: expected a positive integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

const CYCLES = positiveIntEnv('EVOLUTION_NIGHTLY_CYCLES', '50')
const JOURNAL_APPENDS = positiveIntEnv('EVOLUTION_JOURNAL_APPENDS', '1000')
const DETERMINISM_RUNS = positiveIntEnv('EVOLUTION_DETERMINISM_RUNS', '3')

interface PhaseResult {
  readonly phase: string
  readonly ok: boolean
  readonly detail: Record<string, unknown>
}

function fdCount(): number {
  try {
    return readdirSync('/proc/self/fd').length
  } catch {
    return -1
  }
}

function argOut(): string {
  const prefix = '--out='
  for (const argument of process.argv.slice(2)) {
    if (argument.startsWith(prefix)) return argument.slice(prefix.length)
  }
  return '/opt/reports/runs/evolution-nightly-latest'
}

function resolveRunner(): string {
  const candidates = [
    process.env['HOURGLASS_EVOLUTION_RUNNER'],
    '/opt/dsh/packages/hourglass/evolution-runner/run.ts',
    join(BASE_DIR, 'run.ts'),
  ].filter((value): value is string => typeof value === 'string' && value !== '')
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`evolution runner not found: ${candidates.join(' | ')}`)
}

/** Phase 1: journal append stress + tamper detection. */
function phaseJournal(outDir: string): PhaseResult {
  const path = join(outDir, 'journal-stress.jsonl')
  rmSync(path, { force: true })
  const journal = new EvolutionJournal(path)
  for (let index = 0; index < JOURNAL_APPENDS; index += 1) {
    journal.append('stress-event', { trialId: `trial-${index}` }, { i: index })
  }
  const events = journal.events()
  const verified = journal.verify().ok
  // Tamper one middle record's payload; the chain must break there.
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  const middle = Math.floor(lines.length / 2)
  const poisoned = JSON.parse(lines[middle] as string) as { detail: { i: number } }
  poisoned.detail.i = -1
  lines[middle] = JSON.stringify(poisoned)
  const tamperedPath = `${path}.tampered`
  writeFileSync(tamperedPath, `${lines.join('\n')}\n`, 'utf8')
  const tamperDetected = !new EvolutionJournal(tamperedPath).verify().ok
  rmSync(tamperedPath, { force: true })
  return {
    phase: 'journal-stress',
    ok: verified && tamperDetected && events.length === JOURNAL_APPENDS,
    detail: { appends: JOURNAL_APPENDS, events: events.length, chainOk: verified, tamperDetected },
  }
}

/** Phase 2: real trial lifecycle loop (independent confined child per cycle). */
async function phaseLifecycle(root: string): Promise<PhaseResult> {
  const workspace = join(root, 'lifecycle-ws')
  const ledger = join(root, 'lifecycle-ledger.jsonl')
  const fdBefore = fdCount()
  const rssBefore = process.memoryUsage().rss
  const durations: number[] = []
  let failures = 0
  let firstFailure: Record<string, unknown> | undefined
  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    const started = Date.now()
    const response = await runTrial({
      trialId: `lifecycle-${cycle}`,
      workspaceRoot: workspace,
      ledgerPath: ledger,
      commands: [{ callId: 'probe', command: `echo cycle-${cycle} > marker.txt` }],
      confinement: buildTrialConfinement(),
    })
    durations.push(Date.now() - started)
    // File inspection is defensive: a failed trial may leave no marker, and
    // one failing cycle must be counted and reported, never crash the drill.
    let markerMatches = false
    try {
      markerMatches = readFileSync(join(workspace, 'marker.txt'), 'utf8').trim() === `cycle-${cycle}`
    } catch {
      markerMatches = false
    }
    const ok = response.ok && response.results.length === 1 && response.results[0]?.exitCode === 0 && markerMatches
    if (!ok) {
      failures += 1
      firstFailure ??= {
        cycle,
        trialOk: response.ok,
        trialError: response.error,
        results: response.results.map(result => ({ callId: result.callId, exitCode: result.exitCode, stderr: result.stderr.slice(0, 200) })),
      }
    }
  }
  const fdAfter = fdCount()
  const rssAfter = process.memoryUsage().rss
  const fdDrift = fdAfter - fdBefore
  // Hard bound: a loop that leaks descriptors would drift far beyond this.
  const fdOk = fdBefore === -1 || fdDrift <= 10
  durations.sort((a, b) => a - b)
  return {
    phase: 'trial-lifecycle',
    ok: failures === 0 && fdOk,
    detail: {
      cycles: CYCLES,
      failures,
      firstFailure: firstFailure === undefined ? undefined : JSON.stringify(firstFailure).slice(0, 400),
      fdBefore,
      fdAfter,
      fdDrift,
      rssDeltaMb: Math.round((rssAfter - rssBefore) / 1024 / 1024),
      medianMs: durations[Math.floor(durations.length / 2)] ?? 0,
      p95Ms: durations[Math.ceil(0.95 * durations.length) - 1] ?? 0,
    },
  }
}

/** Phase 3: concurrent trials with isolated workspaces (EVO-TRIAL-10). */
async function phaseConcurrency(root: string): Promise<PhaseResult> {
  // Fresh sub-root per invocation so a retry can never read a stale marker.
  const attemptRoot = join(root, `concurrent-${Date.now()}`)
  mkdirSync(attemptRoot, { recursive: true })
  const run = async (name: string, marker: string) => runTrial({
    trialId: `concurrent-${name}`,
    workspaceRoot: join(attemptRoot, `concurrent-ws-${name}`),
    ledgerPath: join(attemptRoot, `concurrent-ledger-${name}.jsonl`),
    commands: [{ callId: 'probe', command: `echo ${marker} > marker.txt` }],
    confinement: buildTrialConfinement(),
  })
  const [a, b] = await Promise.all([run('a', 'ALPHA-MARKER'), run('b', 'BETA-MARKER')])
  // Marker reads are defensive like phaseLifecycle's: a missing file must
  // yield ok:false with diagnostics, never crash the drill before its report
  // is written (PR #9 review finding).
  const readMarker = (name: string): string | undefined => {
    try {
      return readFileSync(join(attemptRoot, `concurrent-ws-${name}`, 'marker.txt'), 'utf8').trim()
    } catch {
      return undefined
    }
  }
  const aMarker = readMarker('a')
  const bMarker = readMarker('b')
  const distinctPids = a.driverPid !== b.driverPid
  const ok = a.ok && b.ok
    && a.results[0]?.exitCode === 0 && b.results[0]?.exitCode === 0
    && aMarker === 'ALPHA-MARKER' && bMarker === 'BETA-MARKER'
    && distinctPids
  return {
    phase: 'concurrency',
    ok,
    detail: {
      aOk: a.ok, aError: a.error, bOk: b.ok, bError: b.error,
      aMarker, bMarker, distinctPids,
    },
  }
}

/** Phase 4: full gate pipeline verdict must be deterministic across runs. */
function phaseDeterminism(outDir: string): PhaseResult {
  const runner = resolveRunner()
  const verdicts: string[] = []
  for (let index = 0; index < DETERMINISM_RUNS; index += 1) {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', runner, `--out=${join(outDir, `determinism-${index}`)}`],
      { encoding: 'utf8', timeout: 600_000 },
    )
    // Accept a verdict only from a clean exit: a timed-out or failed run's
    // truncated stdout must not be mined for a stale "decision=" (PR #9).
    if (result.status !== 0) {
      verdicts.push(`run-failed:exit=${result.status}:signal=${String(result.signal)}`)
      continue
    }
    const match = /decision=(\w+)/.exec(result.stdout ?? '')
    verdicts.push(match?.[1] ?? 'no-decision-in-output')
  }
  const distinct = [...new Set(verdicts)]
  return {
    phase: 'determinism',
    ok: distinct.length === 1 && distinct[0] === 'pass',
    detail: { runs: DETERMINISM_RUNS, verdicts },
  }
}

async function main(): Promise<number> {
  const outDir = argOut()
  mkdirSync(outDir, { recursive: true })
  const root = join(homedir(), `evo-nightly-${Date.now()}`)
  mkdirSync(root, { recursive: true })

  const results: PhaseResult[] = []
  results.push(phaseJournal(outDir))
  results.push(await phaseLifecycle(root))
  // One retry for the concurrency phase: it races two real bwrap children,
  // and a loaded CI runner can transiently lose the marker read right after
  // an otherwise-clean trial (observed on GH runners, never locally). The
  // first attempt's detail is preserved as evidence.
  const concurrencyFirst = await phaseConcurrency(root)
  if (concurrencyFirst.ok) {
    results.push(concurrencyFirst)
  } else {
    const concurrencyRetry = await phaseConcurrency(root)
    results.push({ ...concurrencyRetry, detail: { firstAttempt: concurrencyFirst.detail, retry: concurrencyRetry.detail } })
  }
  results.push(phaseDeterminism(outDir))

  rmSync(root, { recursive: true, force: true })
  const report = {
    schema: 'hourglass-evolution-nightly/1',
    at: new Date().toISOString(),
    cycles: CYCLES,
    journalAppends: JOURNAL_APPENDS,
    determinismRuns: DETERMINISM_RUNS,
    results,
    ok: results.every(phase => phase.ok),
  }
  writeFileSync(join(outDir, 'nightly-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  for (const phase of results) {
    console.log(`[nightly] ${phase.ok ? 'PASS' : 'FAIL'} ${phase.phase}: ${JSON.stringify(phase.detail)}`)
  }
  console.log(`[nightly] overall=${report.ok ? 'PASS' : 'FAIL'} report=${join(outDir, 'nightly-report.json')}`)
  return report.ok ? 0 : 1
}

process.exitCode = await main()
