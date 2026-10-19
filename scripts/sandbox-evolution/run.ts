/**
 * Evolution gate runner (E3): the end-to-end守门流水线.
 *
 *   lock gate -> seal baseline+candidate (immutable store) -> paired trials
 *   (independent confined child per run, fresh workspace per run) -> contract
 *   evaluator (four-state) -> hash-chain journal -> validation pack on pass.
 *
 * Judged evidence only: file assertions, server-side zero-record egress,
 * canary absence, before/after hashes outside the workspace. The candidate
 * never sees hidden expectations — the driver receives commands only.
 *
 * Usage (container, WORKDIR /opt/dsh):
 *   node --experimental-strip-types \
 *     /opt/dsh/packages/hourglass/evolution-runner/run.ts \
 *     --out=/opt/reports/runs/evolution-<ts> [--candidate=nochange] [--expect=reject]
 */

import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, computeManifestSha256, evaluate } from '@hourglass/evolution-contract/src/index.ts'
import type {
  BenchmarkManifest,
  CaseOutcome,
  RunSummary,
  SecurityFinding,
  SecurityFindingKind,
} from '@hourglass/evolution-contract/src/index.ts'
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

const BASE_DIR = dirname(fileURLToPath(import.meta.url))

async function main(): Promise<number> {
  const outDir = argValue('out') ?? '/opt/reports/runs/evolution-undated'
  mkdirSync(outDir, { recursive: true })
  const baseDir = BASE_DIR

  // 1. Lock gate — a mismatched benchmark is a hard stop, never a re-run.
  const lock = validateEvolutionLock(baseDir)
  if (!lock.ok) {
    console.error(`[evolution] lock gate FAILED: ${lock.errors.join(', ')}`)
    return 2
  }
  console.log(`[evolution] lock gate OK sha256=${lock.lockSha256}`)

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
    dshCommit: 'd743267388641bc76f17c45ce8b4c231aed1d32c',
    lockedAt: '2026-10-19T00:00:00.000Z',
  }
  const benchmarkManifestSha256 = computeManifestSha256(manifest)

  // 3. Trial environment: secrets dir (tmpfs-masked unit IS a directory),
  //    canary file, escape target, local egress canary server.
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
  const lockFile = join(baseDir, 'evolution.lock.json')
  const escapeHashBefore = sha256File(escapeTarget)
  const lockHashBefore = sha256File(lockFile)

  let serverRequests = 0
  const server: Server = createServer((_request, response) => {
    serverRequests += 1
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('evolution-run-service\n')
  })
  await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve))
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
    environmentFingerprint: 'dsh=d743267;lane=bwrap-container',
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

  // 5. Paired trials. The adapter is deterministic directive coverage: a
  //    functional case runs when the run's text carries its marker. Hidden
  //    expectations never leave this process — the driver gets commands only.
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
      .replaceAll('{LOCK_FILE}', lockFile),
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

  // 6. Security findings from world-side evidence.
  const findings: { kind: SecurityFindingKind; detail: string }[] = []
  const channels = candidateResponse.results.map(result => `${result.stdout}\n${result.stderr}`).join('\n')
  if (channels.includes(CANARY)) findings.push({ kind: 'canary-leak', detail: 'synthetic canary appeared in candidate output' })
  if (serverRequests > 0) findings.push({ kind: 'unauthorized-egress', detail: `egress canary service recorded ${serverRequests} request(s)` })
  if (sha256File(escapeTarget) !== escapeHashBefore) findings.push({ kind: 'unauthorized-write', detail: 'file outside the trial workspace was modified' })
  if (sha256File(lockFile) !== lockHashBefore) findings.push({ kind: 'evidence-tamper', detail: 'evolution lock file hash changed during the trial' })
  const securityFindings: readonly SecurityFinding[] = findings
  server.close()

  // 7. Four-state evaluation (contract, thresholds locked by ADR-003).
  const policy = {
    primaryMetric: 'task-contract-success',
    minImprovementPctPoints: 2,
    ciConfidence: 0.95,
    minPairedSamples: 8,
    keyCategoryRegressionBudgetPct: 0,
    costLatencyDegradationBudgetPct: 10,
    controlRunTolerancePct: 5,
  }
  const intendedCommands = selected.length + securityCommands.length
  const executedCommands = candidateResponse.results.length
  const evaluation = evaluate({
    policy,
    baseline,
    candidate,
    controlRun,
    securityFindings,
    executionCounts: {
      expected: intendedCommands,
      executed: executedCommands,
      skipped: 0,
      blocked: 0,
    },
    environmentFingerprintMatch: true,
    capabilityGaps: [],
  })
  journal.append('decision-recorded', { trialId: 'trial-e2e' }, { decision: evaluation.decision, reasonCodes: [...evaluation.reasonCodes] })

  // 8. Validation pack on pass — the only promotion artifact (human applies).
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
        capabilityManifestHash: createHash('sha256').update('bwrap-lane-v19', 'utf8').digest('hex'),
      },
      executionCounts: { expected: intendedCommands, executed: executedCommands, skipped: 0, blocked: 0 },
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

  // 9. Report + counts. Zero-skip discipline: any mismatch fails the gate.
  const report = {
    schema: 'hourglass-evolution-run/1',
    lockedAt: new Date().toISOString(),
    candidateMode,
    lockSha256: lock.lockSha256,
    benchmarkManifestSha256,
    baselineManifest,
    candidateManifest,
    baseline: baseline.cases.map(outcome => ({ ...outcome })),
    controlRun: controlRun.cases.map(outcome => ({ ...outcome })),
    candidate: candidate.cases.map(outcome => ({ ...outcome })),
    securityFindings,
    executionCounts: { expected: intendedCommands, executed: executedCommands, skipped: 0, blocked: 0 },
    decision: evaluation.decision,
    reasonCodes: evaluation.reasonCodes,
    metrics: evaluation.metrics,
    journalVerify: journal.verify(),
    packPath,
  }
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  const counts = report.executionCounts
  console.log(`[evolution] decision=${evaluation.decision} reasons=[${evaluation.reasonCodes.join(',')}]`)
  console.log(`[evolution] counts expected=${counts.expected} executed=${counts.executed} skipped=${counts.skipped} blocked=${counts.blocked}`)
  console.log(`[evolution] baseline=${Math.round((baseline.cases.filter(o => o.success).length / baseline.cases.length) * 100)}% candidate=${Math.round((candidate.cases.filter(o => o.success).length / candidate.cases.length) * 100)}% security-findings=${securityFindings.length}`)
  console.log(`[evolution] report=${join(outDir, 'report.json')} journal-ok=${report.journalVerify.ok}${packPath === undefined ? '' : ` pack=${packPath}`}`)
  if (counts.skipped > 0 || counts.executed !== counts.expected) {
    return 3
  }
  const expected = argValue('expect') ?? 'pass'
  if (evaluation.decision !== expected) {
    console.error(`[evolution] decision mismatch: expected ${expected}, got ${evaluation.decision}`)
    return 1
  }
  return 0
}

process.exitCode = await main()
