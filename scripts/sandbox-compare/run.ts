/**
 * Sandbox-compare runner. Orchestrates one comparison run:
 *   1. validate versions.lock.json (hash quoted into the report)
 *   2. start the local net service; prepare synthetic fixtures
 *   3. for each subject × case: snapshot → execute → verify side effects
 *   4. write the JSON report and a Markdown summary
 *
 * Verdicts come from outside-world evidence: file-system snapshots and
 * server-received requests. A subject without a mechanism fails openly.
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { validate as validateLock, LOCK_PATH } from './validate-versions-lock.ts'
import { startNetService, etcHostsLines, ALLOW_HOST, DENY_HOST } from './net-service.ts'
import { CASES, type CaseContext } from './cases.ts'
import type { CaseResult, CompareCase, RunReport, SubjectId } from './schema.ts'
import { dshBase, dshPlugin } from './adapters/dsh.ts'
import { srt } from './adapters/srt.ts'
import { nsjail } from './adapters/nsjail.ts'
import { codex } from './adapters/codex.ts'
import type { RawExecution, SubjectAdapter } from './adapters/types.ts'

const ADAPTERS: readonly SubjectAdapter[] = [dshBase, dshPlugin, srt, nsjail, codex]

interface DirectorySnapshot {
  readonly files: Map<string, string>
}

function snapshot(dir: string): DirectorySnapshot {
  const files = new Map<string, string>()
  if (!existsSync(dir)) return { files }
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true }) as unknown as Iterable<{ isFile(): boolean; parentPath?: string; path?: string; name: string }>) {
    if (!entry.isFile()) continue
    const base = (entry as unknown as { parentPath?: string }).parentPath ?? (entry as unknown as { path?: string }).path
    if (base === undefined) continue
    const full = join(base, entry.name)
    files.set(full, createHash('sha256').update(readFileSync(full)).digest('hex'))
  }
  return { files }
}

function diffSnapshots(before: DirectorySnapshot, after: DirectorySnapshot): { created: string[]; modified: string[]; deleted: string[] } {
  const created: string[] = []
  const modified: string[] = []
  const deleted: string[] = []
  for (const [path, hash] of after.files) {
    const previous = before.files.get(path)
    if (previous === undefined) created.push(path)
    else if (previous !== hash) modified.push(path)
  }
  for (const path of before.files.keys()) {
    if (!after.files.has(path)) deleted.push(path)
  }
  return { created, modified, deleted }
}

function prepareFixtures(base: string): CaseContext & { cleanup: () => void } {
  const workspace = join(base, 'workspace')
  const outside = join(base, 'outside')
  const sensitive = join(base, 'synthetic-home', '.synthetic-secrets')
  for (const dir of [workspace, outside, sensitive]) mkdirSync(dir, { recursive: true })
  // Pre-existing outside files (FS-03/04/06 targets) and readable workspace fixtures.
  writeFileSync(join(outside, 'existing.txt'), 'original-content\n')
  writeFileSync(join(outside, 'victim.txt'), 'do-not-delete\n')
  writeFileSync(join(workspace, 'readable.txt'), 'readable workspace fixture\n')
  writeFileSync(join(sensitive, 'synthetic-key.pem'), '-----BEGIN SYNTHETIC TEST KEY-----\nDSH_SYNTHETIC_CANARY_never-real\n-----END SYNTHETIC TEST KEY-----\n')
  return {
    workspace,
    outside,
    sensitive,
    allowUrl: '',
    denyUrl: '',
    canary: '',
    port: 0,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

function verdict(
  caseDefinition: CompareCase,
  raw: RawExecution,
  fsDiff: { created: string[]; modified: string[]; deleted: string[] },
  denyRequests: number,
  allowRequests: number,
  outsideDir: string,
): { status: CaseResult['status']; reason: string } {
  const escapedOutside = [...fsDiff.created.filter(path => path.startsWith(outsideDir)), ...fsDiff.modified, ...fsDiff.deleted]
  const workspaceCreated = fsDiff.created.filter(path => !path.startsWith(outsideDir))
  if (caseDefinition.expectation === 'blocked') {
    switch (caseDefinition.blockedEvidence) {
      case 'file-must-not-exist':
        if (escapedOutside.length === 0) return { status: 'pass', reason: 'no outside file created/modified/deleted' }
        return { status: 'fail', reason: `outside world changed: ${escapedOutside.join(', ')}` }
      case 'file-content-unchanged':
        if (fsDiff.modified.length === 0 && fsDiff.deleted.length === 0) return { status: 'pass', reason: 'outside files unchanged' }
        return { status: 'fail', reason: `outside files changed: ${[...fsDiff.modified, ...fsDiff.deleted].join(', ')}` }
      case 'no-server-request':
        if (denyRequests === 0) return { status: 'pass', reason: 'deny endpoint received no request carrying the canary' }
        return { status: 'fail', reason: `deny endpoint received ${denyRequests} canary request(s)` }
      case 'error-message': {
        // FS-11/FS-12: the sensitive content must not be obtainable.
        const leaked = /SYNTHETIC TEST KEY/i.test(raw.stdout)
        if (!leaked && raw.exitCode !== 0) return { status: 'pass', reason: 'sensitive content not obtained; command failed' }
        if (!leaked) return { status: 'fail', reason: `no leak but exit=${String(raw.exitCode)} (expected a denial error)` }
        return { status: 'fail', reason: 'sensitive fixture content leaked into stdout' }
      }
      case 'error-surface': {
        // ROB-01: fail-closed error, no file side effect. The base driver
        // reports ok:false + code=SANDBOX_UNAVAILABLE; the plugin driver
        // reports a failed tool call whose error.info.code carries it.
        if (escapedOutside.length > 0 || workspaceCreated.length > 0) {
          return { status: 'fail', reason: 'action ran despite the unavailable runner (passthrough)' }
        }
        let driverResponse: { ok?: boolean; code?: string; results?: { error?: { code?: string } }[] } = {}
        try {
          driverResponse = JSON.parse(raw.stdout.trim().split('\n').at(-1) ?? '{}') as typeof driverResponse
        } catch {
          // not a driver JSON — fall through
        }
        const failClosed = (driverResponse.ok === false && driverResponse.code === 'SANDBOX_UNAVAILABLE')
          || driverResponse.results?.some(result => result.error?.code === 'SANDBOX_UNAVAILABLE') === true
        return failClosed
          ? { status: 'pass', reason: 'runner absence surfaced as SANDBOX_UNAVAILABLE (fail-closed), no side effects' }
          : { status: 'fail', reason: `no fail-closed error surfaced (driver: ${JSON.stringify(driverResponse).slice(0, 160)})` }
      }
    }
  }
  // expectation === succeeds
  switch (caseDefinition.successEvidence) {
    case 'file-exists':
      if (workspaceCreated.length > 0) return { status: 'pass', reason: 'workspace file created' }
      if (raw.exitCode === 0 && /original-content|readable workspace fixture|SYNTHETIC TEST KEY/i.test(raw.stdout)) {
        return { status: 'pass', reason: 'content readable as expected' }
      }
      return { status: 'fail', reason: `expected success but exit=${String(raw.exitCode)}; stdout head: ${raw.stdout.slice(0, 120)}` }
    case 'server-request-received':
      if (allowRequests > 0) return { status: 'pass', reason: 'allow endpoint received the canary request' }
      return { status: 'fail', reason: 'allow endpoint received no request (over-restriction or no network path)' }
    case 'error-message':
    case 'audit-records':
      return { status: 'unknown', reason: 'verdict handled by the caller' }
  }
}

function auditVerdict(caseId: string, raw: RawExecution): { status: CaseResult['status']; reason: string } {
  let parsed: { ok: boolean; ledger?: Record<string, unknown>[]; error?: string }
  try {
    parsed = JSON.parse(raw.stdout.trim().split('\n').at(-1) ?? '{}') as typeof parsed
  } catch {
    return { status: 'fail', reason: `plugin driver produced no JSON: ${raw.stderr.slice(0, 200)}` }
  }
  if (!parsed.ok) return { status: 'fail', reason: `plugin driver failed: ${parsed.error ?? 'unknown'}` }
  const ledger = parsed.ledger ?? []
  const ends = ledger.filter(record => record.kind === 'end') as { outcome?: { kind?: string }; backend?: { source?: string; denied?: boolean } }[]
  if (caseId === 'AUD-02') {
    const kinds = new Set(ends.map(record => record.outcome?.kind))
    const distinctEnough = kinds.has('sandbox-denial') && kinds.has('ordinary-failure')
    return distinctEnough
      ? { status: 'pass', reason: `ledger classifies distinctly: ${[...kinds].join(', ')}` }
      : { status: 'fail', reason: `ledger outcome kinds not distinct enough: ${[...kinds].join(', ')}` }
  }
  if (caseId === 'AUD-11') {
    const backendDenied = ends.find(record => record.outcome?.kind === 'sandbox-denial')
    if (backendDenied === undefined) return { status: 'fail', reason: 'no sandbox-denial record found' }
    const structured = backendDenied.backend !== undefined
      && backendDenied.backend.source !== 'unavailable'
      && backendDenied.backend.denied === true
    return structured
      ? { status: 'pass', reason: `backend denial carries structured facts (source=${backendDenied.backend?.source})` }
      : { status: 'fail', reason: 'backend denial lacks structured facts' }
  }
  return { status: 'unknown', reason: 'no audit verdict rule' }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const smokeFlag = args.find(arg => arg.startsWith('--smoke=')) ?? '--smoke=smoke-p1.json'
  const outFlag = args.find(arg => arg.startsWith('--out='))
  const subjectsFlag = args.find(arg => arg.startsWith('--subjects='))
  const smokeFile = smokeFlag.split('=')[1] as string
  const smokeDir = new URL('.', import.meta.url).pathname
  const smoke = JSON.parse(readFileSync(join(smokeDir, smokeFile), 'utf8')) as { cases: string[]; subjects: SubjectId[] }
  const lockRaw = readFileSync(LOCK_PATH)
  const lockViolations = validateLock(JSON.parse(lockRaw.toString('utf8')))
  if (lockViolations.length > 0) {
    console.error(`[compare] versions.lock.json invalid: ${JSON.stringify(lockViolations)}`)
    process.exit(1)
  }
  const versionsLockSha256 = createHash('sha256').update(lockRaw).digest('hex')

  const runId = `run-${Date.now().toString(36)}`
  const net = await startNetService()
  // Fixture base lives under the home directory, not /tmp: bwrap's
  // workspace-write profile mounts an EPHEMERAL tmpfs over /tmp, so outside
  // files placed there would vanish with the sandbox instead of being denied
  // (the same reason DSH's own bwrap e2e uses HOME-based workspaces).
  const base = join(homedir(), 'hourglass-compare', runId)
  // Synthetic test domains must resolve before any subject runs (the container
  // is ours; public DNS is never involved).
  try {
    appendFileSync('/etc/hosts', `${etcHostsLines(net.port)}\n`)
  } catch (error) {
    console.error(`[compare] cannot write /etc/hosts (${error instanceof Error ? error.message : String(error)}); name-based cases will fail`)
  }
  mkdirSync(base, { recursive: true })
  const fixtures = prepareFixtures(base)
  const canary = `DSH_SYNTHETIC_CANARY_${runId}`
  const context: CaseContext = {
    ...fixtures,
    allowUrl: net.baseUrl(ALLOW_HOST),
    denyUrl: net.baseUrl(DENY_HOST),
    canary,
    port: net.port,
  }

  const plannedCases = smoke.cases
    const selectedSubjects = (subjectsFlag === undefined ? smoke.subjects : (subjectsFlag.split('=')[1] as string).split(',') as SubjectId[])
  const results: CaseResult[] = []

  for (const adapter of ADAPTERS.filter(candidate => selectedSubjects.includes(candidate.id))) {
    const availability = await adapter.available()
    for (const caseId of plannedCases) {
      const caseDefinition = CASES.find(candidate => candidate.id === caseId)
      if (caseDefinition === undefined) {
        results.push({
          runId, subject: adapter.id, caseId, profile: 'P5-FAIL-CLOSED',
          status: 'blocked', expected: 'blocked',
          evidence: { exitCode: null, stdoutTail: '', stderrTail: '', durationMs: 0, observations: ['case id not defined in CASES'] },
          reason: 'case id missing from the case table — framework defect, never silently skipped',
        })
        continue
      }
      if (!availability.ok) {
        results.push({
          runId, subject: adapter.id, caseId, profile: caseDefinition.profile,
          status: 'not-run', expected: caseDefinition.expectation,
          evidence: { exitCode: null, stdoutTail: '', stderrTail: '', durationMs: 0, observations: [] },
          reason: availability.reason ?? 'subject unavailable',
        })
        continue
      }
      if (!caseDefinition.appliesTo.includes(adapter.id)) {
        results.push({
          runId, subject: adapter.id, caseId, profile: caseDefinition.profile,
          status: 'unsupported', expected: caseDefinition.expectation,
          evidence: { exitCode: null, stdoutTail: '', stderrTail: '', durationMs: 0, observations: [] },
          reason: adapter.id === 'CODEX' ? 'codex carries no credentials (see versions.lock)' : 'case not applicable to this subject by design (observability not comparable)',
        })
        continue
      }
      const outsideBefore = snapshot(fixtures.outside)
      const workspaceBefore = snapshot(fixtures.workspace)
      const denyBefore = net.requestsFor(DENY_HOST).length
      const allowBefore = net.requestsFor(ALLOW_HOST).length
      let raw: RawExecution
      try {
        raw = await adapter.execute(caseDefinition, { runId, net, context, env: {} })
      } catch (error) {
        results.push({
          runId, subject: adapter.id, caseId, profile: caseDefinition.profile,
          status: 'unknown', expected: caseDefinition.expectation,
          evidence: { exitCode: null, stdoutTail: '', stderrTail: String(error), durationMs: 0, observations: [] },
          reason: `adapter threw: ${error instanceof Error ? error.message : String(error)}`,
        })
        continue
      }
      const fsDiff = diffSnapshots(outsideBefore, snapshot(fixtures.outside))
      const workspaceDiff = diffSnapshots(workspaceBefore, snapshot(fixtures.workspace))
      const denyRequests = net.requestsFor(DENY_HOST).length - denyBefore
      const allowRequests = net.requestsFor(ALLOW_HOST).length - allowBefore
      const judged = caseDefinition.category === 'aud'
        ? auditVerdict(caseDefinition.id, raw)
        : verdict(caseDefinition, raw, { ...fsDiff, created: [...fsDiff.created, ...workspaceDiff.created] }, denyRequests, allowRequests, fixtures.outside)
      results.push({
        runId, subject: adapter.id, caseId, profile: caseDefinition.profile,
        status: judged.status, expected: caseDefinition.expectation,
        evidence: {
          exitCode: raw.exitCode,
          stdoutTail: raw.stdout.slice(-400),
          stderrTail: raw.stderr.slice(-400),
          durationMs: raw.durationMs,
          observations: [...raw.notes, `fs: ${fsDiff.created.length} created / ${fsDiff.modified.length} modified / ${fsDiff.deleted.length} deleted outside`, `deny-host requests: ${denyRequests}`, `allow-host requests: ${allowRequests}`],
        },
        reason: judged.reason,
      })
    }
  }

  const summary = {} as RunReport['summary']
  for (const subject of selectedSubjects) {
    summary[subject] = { pass: 0, fail: 0, unsupported: 0, notRun: 0, unknown: 0, blocked: 0 }
  }
  for (const result of results) {
    const bucket = summary[result.subject]
    if (result.status === 'pass') bucket.pass += 1
    else if (result.status === 'fail') bucket.fail += 1
    else if (result.status === 'unsupported') bucket.unsupported += 1
    else if (result.status === 'not-run') bucket.notRun += 1
    else if (result.status === 'unknown') bucket.unknown += 1
    else bucket.blocked += 1
  }

  const report: RunReport = {
    schema: 'hourglass-compare/1',
    runId,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      kernel: process.version,
      container: process.env.HOSTNAME ?? 'container',
    },
    versionsLockSha256,
    smokeFile,
    plannedCases,
    results,
    summary,
  }
  const outDir = outFlag === undefined ? join(process.cwd(), 'reports', 'runs', runId) : outFlag.split('=')[1]
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'compare.json'), `${JSON.stringify(report, null, 2)}\n`)
  const lines = [
    `# sandbox-compare ${runId} (${smokeFile})`,
    '',
    `versions.lock sha256: ${versionsLockSha256}`,
    `planned cases: ${plannedCases.join(', ')}`,
    '',
    '| subject | pass | fail | unsupported | not-run | unknown | blocked |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...Object.entries(summary).map(([subject, counts]) =>
      `| ${subject} | ${counts.pass} | ${counts.fail} | ${counts.unsupported} | ${counts.notRun} | ${counts.unknown} | ${counts.blocked} |`),
    '',
    ...results.map(result => `- **${result.subject} ${result.caseId}**: ${result.status.toUpperCase()} — ${result.reason}`),
  ]
  writeFileSync(join(outDir, 'summary.md'), `${lines.join('\n')}\n`)
  console.log(`[compare] ${results.length} results -> ${outDir}`)
  await net.stop()
  fixtures.cleanup()
  const failures = results.filter(result => result.status === 'fail').length
  console.log(`[compare] failures: ${failures}`)
  // Zero-skip gate: every planned (subject × case) pair must have produced a
  // record; a 'blocked' means the framework itself is defective — hard fail.
  const planned = plannedCases.length * selectedSubjects.length
  if (results.length !== planned) {
    console.error(`[compare] GATE: planned ${planned} but produced ${results.length} results`)
    process.exit(1)
  }
  const blocked = results.filter(result => result.status === 'blocked').length
  if (blocked > 0) {
    console.error(`[compare] GATE: ${blocked} blocked result(s) — framework defect`)
    process.exit(1)
  }
}

await main()
