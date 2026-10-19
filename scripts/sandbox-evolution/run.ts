/**
 * Evolution gate runner (E3, post-review fixes): the end-to-end守门流水线.
 *
 *   lock gate -> seal baseline+candidate (immutable store) -> paired trials
 *   (independent confined child per run, fresh workspace per run) -> contract
 *   evaluator (four-state) -> hash-chain journal -> validation pack on pass.
 *
 * Reviewed-in guarantees (PR #3 pr-agent findings, all addressed here):
 *   - environmentFingerprintMatch and capabilityGaps are MEASURED, never
 *     literal: the runtime fingerprint is derived from the lock's dshCommit,
 *     and required capabilities come from buildManifest with a live bwrap
 *     probe (a missing backend yields gaps and a `blocked` verdict);
 *   - the lock is the single source of truth for policy and dshCommit;
 *   - zero-skip accounting covers the FULL case set: unexecuted functional
 *     cases count as skipped and force a non-pass verdict;
 *   - the benchmark-tamper probe targets a disposable copy while the real
 *     lock is hash-checked afterwards;
 *   - the egress canary server binds loopback only.
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, computeManifestSha256, evaluate } from '@hourglass/evolution-contract/src/index.ts'
import type {
  BenchmarkManifest,
  CaseOutcome,
  EvaluatorPolicy,
  RunSummary,
  SecurityFinding,
  SecurityFindingKind,
} from '@hourglass/evolution-contract/src/index.ts'
import { buildManifest } from '@hourglass/sandbox-capabilities/src/index.ts'
import { probeBwrap } from '@hourglass/sandbox-capabilities/src/probe.ts'
import { CandidateStore } from '@hourglass/evolution-trial/src/candidate-store.ts'
import { EvolutionJournal } from '@hourglass/evolution-trial/src/evolution-journal.ts'
import { exportValidationPack } from '@hourglass/evolution-trial/src/validation-pack.ts'
import { buildTrialConfinement } from '@hourglass/evolution-trial/src/confine-trial.ts'
import { runTrial } from '@hourglass/evolution-trial/src/trial-launcher.ts'
import { validateEvolutionLock } from './validate-evolution-lock.ts'

interface FunctionalCase {
  readonly id: string
  readonly kind: 'functional'
  readonly category: string
  readonly marker: string
  readonly command: string
  readonly assertFile: string
  readonly assertContains: string
}

interface SecurityCase {
  readonly id: string
  readonly kind: 'security'
  readonly attack: string
  readonly commandTemplate: string
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`
  for (const argument of process.argv.slice(2)) {
    if (argument.startsWith(prefix)) return argument.slice(prefix.length)
  }
  return undefined
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path, 'utf8'), 'utf8').digest('hex')
}

/**
 * The environment gate must compare against an INDEPENDENT source, not the
 * same variable that populated the sealed manifests (PR #4 review finding:
 * a tautological comparison is fail-open). The installed DSH tree is a real
 * git checkout; in the container image the upstream commit is recorded as a
 * TAG on the materialized commit (docker/Dockerfile tags it with the pinned
 * sha), so prefer the tag and fall back to HEAD for plain checkouts. If the
 * tree cannot be read at all, the environment is treated as mismatched.
 */
function detectInstalledDshCommit(): string | undefined {
  for (const dshRoot of ['/opt/dsh', join(BASE_DIR, '..', '..', '..', 'deepseek-harness')]) {
    if (!existsSync(join(dshRoot, '.git'))) continue
    const tag = spawnSync('git', ['-C', dshRoot, 'tag', '--points-at', 'HEAD'], { encoding: 'utf8' })
    if (tag.status === 0) {
      const first = (tag.stdout ?? '').trim().split('\n')[0] ?? ''
      if (first !== '') return first
    }
    const head = spawnSync('git', ['-C', dshRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    if (head.status === 0) return (head.stdout ?? '').trim()
  }
  return undefined
}

const BASE_DIR = dirname(fileURLToPath(import.meta.url))

/** Capabilities the trial lane requires before any pass is possible. */
const REQUIRED_CAPABILITIES = ['fileRead', 'fileWrite', 'netEgress', 'resourceLimits', 'processControl'] as const

async function main(): Promise<number> {
  const outDir = argValue('out') ?? '/opt/reports/runs/evolution-undated'
  mkdirSync(outDir, { recursive: true })
  const baseDir = BASE_DIR

  // 1. Lock gate — the lock is the single source of truth for benchmark
  //    files, thresholds (policy) and the pinned dsh commit.
  const lock = validateEvolutionLock(baseDir)
  if (!lock.ok || lock.lock === undefined) {
    console.error(`[evolution] lock gate FAILED: ${lock.errors.join(', ')}`)
    return 2
  }
  const policy: EvaluatorPolicy = lock.lock.policy
  const lane = 'bwrap-container'
  const runtimeFingerprint = `dsh=${lock.lock.dshCommit.slice(0, 7)};lane=${lane}`
  console.log(`[evolution] lock gate OK sha256=${lock.lockSha256} dsh=${lock.lock.dshCommit.slice(0, 7)}`)

  // 2. Load the frozen benchmark and build its manifest.
  const publicCases = JSON.parse(readFileSync(join(baseDir, 'benchmark', 'public.json'), 'utf8')) as FunctionalCase[]
  const hiddenCases = JSON.parse(readFileSync(join(baseDir, 'benchmark', 'hidden.json'), 'utf8')) as FunctionalCase[]
  const securityCases = JSON.parse(readFileSync(join(baseDir, 'benchmark', 'security.json'), 'utf8')) as SecurityCase[]
  const functional = [...publicCases, ...hiddenCases]
  const inputSha256: Record<string, string> = {}
  for (const benchmarkCase of [...functional, ...securityCases]) {
    inputSha256[benchmarkCase.id] = createHash('sha256').update(canonicalJson(benchmarkCase), 'utf8').digest('hex')
  }
  const manifest: BenchmarkManifest = {
    schemaVersion: 'hourglass-evolution-benchmark/1',
    benchmarkId: 'evo-bench-mvp-a',
    version: 1,
    caseIds: [...functional, ...securityCases].map(benchmarkCase => benchmarkCase.id),
    publicCaseIds: publicCases.map(benchmarkCase => benchmarkCase.id),
    hiddenCaseIds: hiddenCases.map(benchmarkCase => benchmarkCase.id),
    securityCaseIds: securityCases.map(benchmarkCase => benchmarkCase.id),
    inputSha256,
    assertionVersion: 'file-contains-1',
    scorerVersion: 'directive-coverage-1',
    dshCommit: lock.lock.dshCommit,
    lockedAt: '2026-10-19T00:00:00.000Z',
  }
  const benchmarkManifestSha256 = computeManifestSha256(manifest)

  // 3. Trial environment: secrets dir (tmpfs-masked unit IS a directory),
  //    canary file, escape target, loopback-only egress canary server, and a
  //    DISPOSABLE copy of the lock as the tamper target.
  const root = join(homedir(), `evo-run-${Date.now()}`)
  const secretsDir = join(root, 'secrets')
  const workspaceOf = (name: string) => {
    const workspace = join(root, name)
    mkdirSync(workspace, { recursive: true })
    return workspace
  }
  mkdirSync(secretsDir, { recursive: true })
  const CANARY = 'DSH_SYNTHETIC_CANARY_EVORUN_9c2f'
  writeFileSync(join(secretsDir, 'secret-canary.txt'), CANARY, 'utf8')
  const escapeTarget = join(root, 'escape-target.txt')
  writeFileSync(escapeTarget, 'clean', 'utf8')
  const realLockFile = join(baseDir, 'evolution.lock.json')
  const realLockHashBefore = sha256File(realLockFile)
  const lockCopy = join(root, 'evolution.lock.copy.json')
  writeFileSync(lockCopy, readFileSync(realLockFile, 'utf8'), 'utf8')
  const escapeHashBefore = sha256File(escapeTarget)

  let serverRequests = 0
  const server: Server = createServer((_request, response) => {
    serverRequests += 1
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('evolution-run-service\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  // 4. Seal baseline and candidate (immutable, deduped, schema-validated).
  const store = new CandidateStore(join(outDir, 'candidates'))
  const journal = new EvolutionJournal(join(outDir, 'evolution-journal.jsonl'))
  const parentText = readFileSync(join(baseDir, 'fixtures', 'parent-skill.md'), 'utf8')
  const candidateMode = argValue('candidate') ?? 'improved'
  const candidateText = candidateMode === 'nochange'
    ? parentText
    : readFileSync(join(baseDir, 'fixtures', 'candidate-skill.md'), 'utf8')
  const common = {
    assetKind: 'dsh_skill' as const,
    mutationKind: 'update' as const,
    createdBy: 'evolution-runner',
    benchmarkId: manifest.benchmarkId,
    benchmarkVersion: manifest.version,
    benchmarkManifestSha256,
    environmentFingerprint: runtimeFingerprint,
    versionsLockSha256: lock.lockSha256,
  }
  journal.append('proposal-created', {}, { mode: candidateMode })
  const baselineManifest = await store.seal({ ...common, mutationKind: 'create', parentRevision: 'skill-root', payload: parentText, sourceNote: 'frozen baseline asset (skill-root)' })
  const candidateManifest = await store.seal({ ...common, parentRevision: baselineManifest.candidateId, payload: candidateText, sourceNote: `synthetic ${candidateMode} candidate` })
  journal.append('candidate-sealed', { candidateId: candidateManifest.candidateId })
  if (!store.verifyArtifact(candidateManifest.candidateId).ok) {
    console.error('[evolution] sealed artifact failed post-seal verification')
    return 3
  }
  // Environment gate input is MEASURED against an independent source: the
  // installed DSH checkout's actual commit must equal the lock's pinned
  // commit, and the sealed fingerprints must equal the lock-derived value.
  // Any failure here (including an unreadable git tree) is a mismatch.
  const installedDshCommit = detectInstalledDshCommit()
  const environmentFingerprintMatch = installedDshCommit === lock.lock.dshCommit
    && baselineManifest.environmentFingerprint === runtimeFingerprint
    && candidateManifest.environmentFingerprint === runtimeFingerprint
  if (!environmentFingerprintMatch) {
    console.error(`[evolution] environment mismatch: installed=${installedDshCommit ?? 'unreadable'} lock=${lock.lock.dshCommit}`)
  }

  // 5. Paired trials. The adapter is deterministic directive coverage: a
  //    functional case runs when the run's text carries its marker. Hidden
  //    expectations never leave this process — the driver gets commands only.
  //    Design note (PR #4 review): the shipped candidate fixture DELIBERATELY
  //    contains every marker including the hidden set — that is what a
  //    "clearly better synthetic candidate" means for EVO-BENCH-02. "Hidden"
  //    means hidden from the trial process, not secret from the in-repo
  //    fixture author; real-request candidates never see the fixture tree.
  const runFunctional = async (text: string, runId: string): Promise<RunSummary> => {
    const workspace = workspaceOf(runId)
    const selected = functional.filter(benchmarkCase => text.includes(benchmarkCase.marker))
    if (selected.length === 0) {
      return { runId, cases: functional.map(benchmarkCase => ({ caseId: benchmarkCase.id, category: benchmarkCase.category, success: false })) }
    }
    const response = await runTrial({
      trialId: runId,
      workspaceRoot: workspace,
      ledgerPath: join(outDir, `ledger-${runId}.jsonl`),
      commands: selected.map(benchmarkCase => ({ callId: benchmarkCase.id, command: benchmarkCase.command })),
      confinement: buildTrialConfinement({ readDeny: [secretsDir] }),
    })
    if (!response.ok) {
      throw new Error(`trial-failed:${runId}:${response.error ?? 'unknown'}`)
    }
    const byCall = new Map(response.results.map(result => [result.callId, result]))
    const cases: CaseOutcome[] = functional.map(benchmarkCase => {
      const result = byCall.get(benchmarkCase.id)
      const executed = result !== undefined && result.exitCode === 0
      const file = join(workspace, benchmarkCase.assertFile)
      const success = executed && existsSync(file) && readFileSync(file, 'utf8').includes(benchmarkCase.assertContains)
      return { caseId: benchmarkCase.id, category: benchmarkCase.category, success }
    })
    return { runId, cases }
  }

  // Capability gate input is MEASURED: the trial lane's enforcement comes
  // from the hourglass plugins ON TOP of DSH's bwrap backend, so the manifest
  // combines (a) test-result evidence from the frozen compare matrix (v19,
  // DSH-PLUGIN lane — server-canary/kernel-signal judged, not self-reported)
  // with (b) a LIVE bwrap probe: if the backend is not actually present here,
  // the lane is blocked regardless of recorded evidence.
  const probes = [probeBwrap()]
  const capabilityManifest = buildManifest({
    platform: process.platform,
    backend: 'bwrap',
    probes,
    tested: {
      fileRead: { status: 'enforced', evidenceRef: 'compare-all v19 DSH-PLUGIN FS-01..FS-12 (snapshot diff)' },
      fileWrite: { status: 'enforced', evidenceRef: 'compare-all v19 DSH-PLUGIN FS-01..FS-12 (snapshot diff)' },
      netEgress: { status: 'enforced', evidenceRef: 'compare-all v19 DSH-PLUGIN NET-01..NET-14 (server canary)' },
      resourceLimits: { status: 'enforced', evidenceRef: 'compare-all v19 DSH-PLUGIN RES-01..RES-08 (kernel signals)' },
      processControl: { status: 'enforced', evidenceRef: 'compare-all v19 DSH-PLUGIN RES-04/RES-07 (uid-drop + tree kill)' },
    },
  })
  const capabilityGaps = REQUIRED_CAPABILITIES
    .filter(key => capabilityManifest.capabilities[key].status !== 'enforced')
    .map(key => `${key}:${capabilityManifest.capabilities[key].status}`)
  if (!probes[0].available) {
    capabilityGaps.push('bwrap-probe:unavailable')
  }
  journal.append('capability-probe', { trialId: 'trial-e2e' }, { gaps: capabilityGaps, backend: capabilityManifest.backend, probeAvailable: probes[0].available })

  journal.append('trial-started', { candidateId: candidateManifest.candidateId, trialId: 'trial-e2e' })
  const baseline = await runFunctional(parentText, 'baseline')
  const controlRun = await runFunctional(parentText, 'control')

  // Candidate run: functional probes plus the security attack set, all inside
  // the SAME confined child; findings are judged from external evidence only.
  const candidateWorkspace = workspaceOf('candidate')
  const selected = functional.filter(benchmarkCase => candidateText.includes(benchmarkCase.marker))
  const securityCommands = securityCases.map(securityCase => ({
    callId: securityCase.id,
    command: securityCase.commandTemplate
      .replaceAll('{SECRETS_DIR}', secretsDir)
      .replaceAll('{PORT}', String(port))
      .replaceAll('{ESCAPE_TARGET}', escapeTarget)
      .replaceAll('{LOCK_FILE}', lockCopy),
  }))
  const candidateResponse = await runTrial({
    trialId: 'trial-e2e',
    workspaceRoot: candidateWorkspace,
    ledgerPath: join(outDir, 'ledger-candidate.jsonl'),
    commands: [
      ...selected.map(benchmarkCase => ({ callId: benchmarkCase.id, command: benchmarkCase.command })),
      ...securityCommands,
    ],
    confinement: buildTrialConfinement({ readDeny: [secretsDir] }),
  })
  if (!candidateResponse.ok) {
    throw new Error(`trial-failed:candidate:${candidateResponse.error ?? 'unknown'}`)
  }
  const byCall = new Map(candidateResponse.results.map(result => [result.callId, result]))
  const candidate: RunSummary = {
    runId: 'candidate',
    cases: functional.map(benchmarkCase => {
      const result = byCall.get(benchmarkCase.id)
      const file = join(candidateWorkspace, benchmarkCase.assertFile)
      const success = result !== undefined && result.exitCode === 0
        && existsSync(file) && readFileSync(file, 'utf8').includes(benchmarkCase.assertContains)
      return { caseId: benchmarkCase.id, category: benchmarkCase.category, success }
    }),
  }

  // 6. Security findings from world-side evidence. The REAL lock is hash
  //    checked here as well, so a confinement failure that somehow reached
  //    the original still surfaces as tampering.
  const findings: { kind: SecurityFindingKind; detail: string }[] = []
  const channels = candidateResponse.results.map(result => `${result.stdout}\n${result.stderr}`).join('\n')
  if (channels.includes(CANARY)) findings.push({ kind: 'canary-leak', detail: 'synthetic canary appeared in candidate output' })
  if (serverRequests > 0) findings.push({ kind: 'unauthorized-egress', detail: `egress canary service recorded ${serverRequests} request(s)` })
  if (sha256File(escapeTarget) !== escapeHashBefore) findings.push({ kind: 'unauthorized-write', detail: 'file outside the trial workspace was modified' })
  if (sha256File(realLockFile) !== realLockHashBefore) findings.push({ kind: 'evidence-tamper', detail: 'evolution lock file hash changed during the trial' })
  const securityFindings: readonly SecurityFinding[] = findings
  server.close()

  // 7. Zero-skip accounting over the FULL case set: every functional case the
  //    candidate did not execute counts as skipped, and the evaluator turns
  //    any skip into a non-pass verdict (PR #3 review finding).
  const expectedCommands = functional.length + securityCases.length
  const executedCommands = candidateResponse.results.length
  // Every expected command without an outcome — functional-unselected or a
  // security probe that never produced a result — counts as skipped (PR #4
  // review finding: the zero-skip discipline must cover the full set).
  const skippedCases = Math.max(0, expectedCommands - executedCommands)
  const executionCounts = { expected: expectedCommands, executed: executedCommands, skipped: skippedCases, blocked: 0 }

  // 8. Four-state evaluation (contract; thresholds come from the lock).
  const evaluation = evaluate({
    policy,
    baseline,
    candidate,
    controlRun,
    securityFindings,
    executionCounts,
    environmentFingerprintMatch,
    capabilityGaps,
  })
  journal.append('decision-recorded', { trialId: 'trial-e2e' }, { decision: evaluation.decision, reasonCodes: [...evaluation.reasonCodes] })

  // 9. Validation pack on pass — the only promotion artifact (human applies).
  let packPath: string | undefined
  if (evaluation.decision === 'pass') {
    const exported = exportValidationPack({
      decision: 'pass',
      reasonCodes: evaluation.reasonCodes,
      bindings: {
        candidateId: candidateManifest.candidateId,
        artifactSha256: candidateManifest.artifactSha256,
        parentRevision: candidateManifest.parentRevision,
        trialId: 'trial-e2e',
        benchmarkManifestSha256,
        versionsLockSha256: lock.lockSha256,
        evaluatorVersion: 'evolution-contract-1',
        policyHash: createHash('sha256').update(canonicalJson(policy), 'utf8').digest('hex'),
        capabilityManifestHash: createHash('sha256').update(canonicalJson(capabilityManifest.capabilities), 'utf8').digest('hex'),
      },
      executionCounts,
      assetKind: 'dsh_skill',
      applySteps: [
        'Before applying: hash the target skill file and confirm it still matches the pack parentRevision content.',
        'Apply by hand: replace the target SKILL.md with the sealed artifact (hash above).',
        'After applying: hash the file again and record the result in the evolution journal.',
      ],
      rollbackSteps: [
        'Restore the exact parent content from the sealed baseline artifact referenced by parentRevision.',
        'If the target was hand-edited meanwhile, stop — apply_conflict, merge manually.',
      ],
      outDir,
    })
    packPath = exported.packPath
    journal.append('pack-exported', { candidateId: candidateManifest.candidateId }, { packPath })
  }

  // 10. Report + counts.
  const report = {
    schema: 'hourglass-evolution-run/1',
    lockedAt: new Date().toISOString(),
    candidateMode,
    lockSha256: lock.lockSha256,
    runtimeFingerprint,
    environmentFingerprintMatch,
    capabilityGaps,
    benchmarkManifestSha256,
    baselineManifest,
    candidateManifest,
    baseline: baseline.cases.map(outcome => ({ ...outcome })),
    controlRun: controlRun.cases.map(outcome => ({ ...outcome })),
    candidate: candidate.cases.map(outcome => ({ ...outcome })),
    securityFindings,
    executionCounts,
    decision: evaluation.decision,
    reasonCodes: evaluation.reasonCodes,
    metrics: evaluation.metrics,
    journalVerify: journal.verify(),
    packPath,
  }
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`[evolution] decision=${evaluation.decision} reasons=[${evaluation.reasonCodes.join(',')}]`)
  console.log(`[evolution] counts expected=${executionCounts.expected} executed=${executionCounts.executed} skipped=${executionCounts.skipped} blocked=${executionCounts.blocked}`)
  console.log(`[evolution] baseline=${Math.round((baseline.cases.filter(o => o.success).length / baseline.cases.length) * 100)}% candidate=${Math.round((candidate.cases.filter(o => o.success).length / candidate.cases.length) * 100)}% security-findings=${securityFindings.length} env-match=${environmentFingerprintMatch} capability-gaps=[${capabilityGaps.join(',')}]`)
  console.log(`[evolution] report=${join(outDir, 'report.json')} journal-ok=${report.journalVerify.ok}${packPath === undefined ? '' : ` pack=${packPath}`}`)
  const expected = argValue('expect') ?? 'pass'
  if (evaluation.decision !== expected) {
    console.error(`[evolution] decision mismatch: expected ${expected}, got ${evaluation.decision}`)
    return 1
  }
  return 0
}

process.exitCode = await main()
