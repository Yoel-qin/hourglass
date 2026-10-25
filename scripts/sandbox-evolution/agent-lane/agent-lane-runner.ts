/**
 * Agent-lane trial runner (ADR-004 D1/D2 convergence): paired trials on the
 * REAL task set — a baseline arm (no candidate skill) and a candidate arm
 * (content-addressed candidate skill snapshot) per task, each a full DSH
 * child whose model route goes through the host-side LLM broker; the hidden
 * judge then scores each arm's workspace, and the four-state evaluator
 * (pass/reject/inconclusive/blocked) aggregates the campaign with
 * broker-metered calls/tokens/wall-clock.
 *
 * Lanes:
 *   --lane=mock (default) — scripted mock upstream. CI-safe, zero real
 *     model, zero keys. The candidate arm's script applies the task's
 *     reference fix through the child's own tool execution, so the smoke
 *     proves the FULL pipeline (carrier → confinement → workspace mutation
 *     → hidden judge → verdict → metering) end-to-end. Mock results are
 *     mechanism evidence only, never a scored benchmark or promotion input.
 *   --lane=real — DeepSeek upstream (model id + caps locked in lane config
 *     envs). Requires DOUBLE opt-in: the flag AND env
 *     HOURGLASS_AGENT_LANE_REAL=1 AND a host-side DEEPSEEK_API_KEY; the key
 *     never leaves the broker (D2 boundary). Manual/nightly lane only.
 *
 * 省量纪律 (ADR-004): --dry-run prints the planned arms and expected call
 * counts WITHOUT spawning anything; --tasks=<ids> runs a minimal subset
 * first; full sets belong to nightly/manual runs.
 *
 * @module @hourglass/evolution-runner
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, type CaseOutcome, type EvaluatorPolicy, type SecurityFinding } from '@hourglass/evolution-contract/src/index.ts'
import type { LlmBroker, UsageReport } from '@hourglass/evolution-trial/src/llm-broker.ts'
import { startLlmBroker } from '@hourglass/evolution-trial/src/llm-broker.ts'
import { startMockLlmServer, type MockLlmServer, type ScriptedResponse } from '@hourglass/evolution-trial/src/mock-llm-server.ts'
import { CandidateStore } from '@hourglass/evolution-trial/src/candidate-store.ts'
import { validateEvolutionLock } from '../validate-evolution-lock.ts'
import { buildChildPatchYaml } from './child-patch.ts'
import { runDshChild } from './dsh-child.ts'
import { startNetRecorder } from './net-recorder.ts'
import { loadAgentTasks, materializeTaskWorkspace, runJudge, verifyAgentLaneLock, type AgentTask, type JudgeOutcome } from './tasks.ts'

const BASE_DIR = dirname(fileURLToPath(import.meta.url))
const TASKS_DIR = join(BASE_DIR, 'tasks')
const AGENT_LOCK_PATH = join(BASE_DIR, '..', 'agent-lane.lock.json')
const EVOLUTION_LOCK_DIR = join(BASE_DIR, '..')
const SKILL_MARKER = 'HOURGLASS_AGENT_SKILL_MARKER_51c7'
const MOCK_MODEL_ID = 'deepseek-flash'
const MOCK_UPSTREAM_KEY = 'agent-lane-smoke-upstream-key'

/**
 * Provisional policy: the agent lane reuses the shell lane's MVP-A numbers
 * UNTIL the first real-lane baseline recalibrates them into the ADR-004
 * appendix (ADR-002 three-principle discipline). With 6 tasks (< 8 paired
 * samples) the honest campaign verdict is `inconclusive/insufficient-
 * samples` — mechanism proof, not a scoring claim.
 */
const PROVISIONAL_POLICY: EvaluatorPolicy = {
  primaryMetric: 'task-contract-success',
  minImprovementPctPoints: 2,
  ciConfidence: 0.95,
  minPairedSamples: 8,
  keyCategoryRegressionBudgetPct: 0,
  costLatencyDegradationBudgetPct: 10,
  controlRunTolerancePct: 5,
}

/**
 * Validated positive-integer env override for the real-lane caps: a
 * malformed value REFUSES the run. A NaN cap never trips (fail-open), and
 * silently falling back to the default could exceed an operator's intended
 * LOWER budget — refusing is the only fail-closed option (PR #18 review).
 */
function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || String(value) !== raw.trim()) {
    throw new Error(`invalid ${name}: expected a positive integer, got ${JSON.stringify(raw)}`)
  }
  return value
}

/** Real-lane caps (fail-closed): every value env-overridable, defaults conservative. */
function realLaneCaps(taskCount: number) {
  const maxTurnsPerArm = envPositiveInt('HOURGLASS_AGENT_LANE_MAX_TURNS', 8)
  return {
    maxCalls: taskCount * 2 * maxTurnsPerArm + 8,
    maxTotalTokens: envPositiveInt('HOURGLASS_AGENT_LANE_MAX_TOKENS', 2_000_000),
    wallClockMs: envPositiveInt('HOURGLASS_AGENT_LANE_WALL_CLOCK_MS', 30 * 60_000),
    maxConcurrentCalls: 2,
    abortedCallTokenCharge: 4096,
  }
}

interface ArmOutcome {
  readonly arm: 'baseline' | 'candidate'
  readonly stopReason: string
  readonly diagnostic?: string
  readonly error?: string
  readonly timedOut: boolean
  readonly durationMs: number
  readonly childPids: readonly number[]
  readonly brokerCalls: number
  readonly brokerTokens: number
  readonly skillInRequest: boolean
  readonly judge: { readonly ok: boolean; readonly passedChecks: number; readonly failedChecks: readonly string[] }
  readonly workspace: string
}

interface TaskOutcome {
  readonly id: string
  readonly category: string
  readonly baseline: ArmOutcome
  readonly candidate: ArmOutcome
  readonly blocked: boolean
}

interface LaneReport {
  readonly schema: 'hourglass-agent-lane-report/1'
  readonly at: string
  readonly lane: 'mock' | 'real'
  readonly dryRun: boolean
  readonly ok: boolean
  readonly blocked: readonly string[]
  readonly locks: { readonly agentLane: { ok: boolean; sha256: string }; readonly evolution: { ok: boolean; sha256: string } }
  readonly manifestSha256: string
  readonly tasks: readonly TaskOutcome[]
  readonly rates: { readonly baselinePct: number; readonly candidatePct: number }
  readonly campaign: {
    readonly decision: string
    readonly reasonCodes: readonly string[]
    readonly policy: EvaluatorPolicy
    readonly policyProvisional: boolean
  }
  readonly securityFindings: readonly SecurityFinding[]
  readonly metering: { readonly calls: number; readonly totalTokens: number; readonly usageUnknownCalls: number; readonly cappedReason?: string; readonly wallClockMs: number }
  readonly model: string
  readonly upstream: string
}

function argValue(name: string): string | undefined {
  const hit = process.argv.find(arg => arg.startsWith(`--${name}=`))
  return hit === undefined ? undefined : hit.slice(`--${name}=`.length)
}

function heredocWriteCommand(target: string, content: string): string {
  return `cat > ${JSON.stringify(target)} <<'HOURGLASS_FIX_EOF'\n${content}\nHOURGLASS_FIX_EOF\n`
}

/** Per-arm stderr lens path (the parent directory is created up front). */
function stderrLogFor(root: string, label: string): string {
  const dir = join(root, 'stderr')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${label}.log`)
}

function summarizeJudge(judge: JudgeOutcome): ArmOutcome['judge'] {
  return {
    ok: judge.ok,
    passedChecks: judge.checks.filter(check => check.ok).length,
    failedChecks: judge.checks.filter(check => !check.ok).map(check => check.name),
  }
}

async function main(): Promise<number> {
  const lane = argValue('lane') === 'real' ? 'real' : 'mock'
  const dryRun = process.argv.includes('--dry-run')
  const outDir = argValue('out') ?? join('reports', 'runs', `agent-lane-${lane}-latest`)
  const taskFilter = argValue('tasks')?.split(',').map(id => id.trim()).filter(id => id !== '')
  const candidateSkillPath = argValue('candidate-skill') ?? join(BASE_DIR, 'smoke-candidate-skill.md')
  mkdirSync(outDir, { recursive: true })
  const startedAt = Date.now()

  const agentLock = verifyAgentLaneLock(AGENT_LOCK_PATH)
  const evolutionLock = validateEvolutionLock(EVOLUTION_LOCK_DIR)
  if (!agentLock.ok) {
    console.error(`[agent-lane] agent-lane lock failed: ${agentLock.errors.join('; ')}`)
    return 1
  }
  if (!evolutionLock.ok) {
    console.error(`[agent-lane] evolution lock failed: ${evolutionLock.errors.join('; ')}`)
    return 1
  }
  const loaded = loadAgentTasks(TASKS_DIR)
  const tasks = taskFilter === undefined ? [...loaded.tasks] : loaded.tasks.filter(task => taskFilter.includes(task.id))
  if (tasks.length === 0) {
    console.error('[agent-lane] no tasks selected (check --tasks ids against the manifest)')
    return 1
  }
  for (const id of taskFilter ?? []) {
    if (!loaded.tasks.some(task => task.id === id)) console.error(`[agent-lane] unknown task id: ${id}`)
  }

  const modelId = lane === 'real' ? (process.env['HOURGLASS_AGENT_LANE_MODEL'] ?? 'DeepSeek-V4.1-Flash') : MOCK_MODEL_ID
  const upstream = lane === 'real' ? (process.env['HOURGLASS_AGENT_LANE_UPSTREAM'] ?? 'https://api.deepseek.com/anthropic') : 'mock://scripted'
  const caps = lane === 'real'
    ? realLaneCaps(tasks.length)
    : { maxCalls: tasks.length * 2 * 3 + 8, maxTotalTokens: 400_000, wallClockMs: 20 * 60_000, maxConcurrentCalls: 2 }

  if (dryRun) {
    // 跑前 dry-run（ADR-004 省量纪律）: planned arms + expected calls, nothing spawned.
    const perArmExpected = lane === 'mock' ? { baseline: 1, candidate: 2 } : { baseline: '≤8 (max turns cap)', candidate: '≤8 (max turns cap)' }
    console.log(`[agent-lane] dry-run lane=${lane} tasks=${tasks.length} arms=${tasks.length * 2}`)
    for (const task of tasks) console.log(`[agent-lane]   ${task.id} (${task.category}): baseline + candidate`)
    console.log(`[agent-lane] expected model calls: mock=${String(tasks.length * 3)} real≤${String(caps.maxCalls - 8)}; per arm ${JSON.stringify(perArmExpected)}`)
    console.log(`[agent-lane] caps: ${JSON.stringify(caps)} model=${modelId} upstream=${upstream}`)
    const dryReport = {
      schema: 'hourglass-agent-lane-report/1',
      at: new Date().toISOString(),
      lane,
      dryRun: true,
      ok: true,
      plannedTasks: tasks.map(task => task.id),
      expectedCalls: { mock: tasks.length * 3, realBound: caps.maxCalls - 8 },
      caps,
      model: modelId,
      upstream,
    }
    writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(dryReport, null, 2)}\n`, 'utf8')
    console.log(`[agent-lane] OK (dry-run) report=${join(outDir, 'report.json')}`)
    return 0
  }

  // Real lane double opt-in: flag (--lane=real, reached here) AND env AND key.
  if (lane === 'real') {
    if (process.env['HOURGLASS_AGENT_LANE_REAL'] !== '1' || (process.env['DEEPSEEK_API_KEY'] ?? '') === '') {
      console.error('[agent-lane] real lane requires BOTH env HOURGLASS_AGENT_LANE_REAL=1 and env DEEPSEEK_API_KEY (host-side, broker-only); refusing')
      return 1
    }
  }

  const root = mkdtempSync(join(tmpdir(), `agent-lane-${lane}-`))
  const recorder = await startNetRecorder()
  let mock: MockLlmServer | undefined
  let broker: LlmBroker | undefined
  let finalMetering: UsageReport | undefined
  const outcomes: TaskOutcome[] = []
  const securityFindings: SecurityFinding[] = []
  const blocked: string[] = []

  try {
    if (lane === 'mock') {
      mock = await startMockLlmServer({
        scripted: [],
        requireAuthorization: `Bearer ${MOCK_UPSTREAM_KEY}`,
        allowModel: MOCK_MODEL_ID,
      })
    }
    broker = await startLlmBroker({
      upstreamBaseUrl: mock?.baseUrl ?? upstream,
      apiKey: lane === 'mock' ? MOCK_UPSTREAM_KEY : (process.env['DEEPSEEK_API_KEY'] ?? ''),
      modelAllowlist: [modelId],
      caps,
    })

    // The candidate is sealed content-addressed FIRST, bound to THIS task
    // set's manifest hash; arms materialize a snapshot from the verified
    // artifact (P4 discipline).
    const store = new CandidateStore(join(root, 'candidates'))
    const skillPayload = readFileSync(candidateSkillPath, 'utf8')
    const manifest = await store.seal({
      assetKind: 'dsh_skill',
      mutationKind: 'update',
      parentRevision: 'agent-lane-parent',
      payload: skillPayload,
      createdBy: 'agent-lane-runner',
      sourceNote: `agent-lane ${lane} candidate`,
      benchmarkId: 'agent-lane-tasks',
      benchmarkVersion: 1,
      benchmarkManifestSha256: loaded.manifestSha256,
      versionsLockSha256: evolutionLock.lockSha256,
      environmentFingerprint: evolutionLock.lock?.dshCommit ?? 'unknown',
    })

    const ledgerPath = join(root, 'child-ledger.jsonl')
    const netDecisionLog = join(root, 'child-net-decisions.jsonl')
    const scratchRoot = join(root, 'arms')

    const runArm = async (task: AgentTask, arm: 'baseline' | 'candidate'): Promise<ArmOutcome> => {
      const workspace = join(scratchRoot, `${task.id}-${arm}`)
      materializeTaskWorkspace(task.fixtureDir, workspace)
      let candidateSkillSnapshot: string | undefined
      if (arm === 'candidate') {
        const skillDir = join(workspace, 'skills', 'hourglass-agent-lane-candidate')
        mkdirSync(skillDir, { recursive: true })
        const snapshotPath = join(skillDir, 'SKILL.md')
        writeFileSync(snapshotPath, store.readArtifact(manifest.payloadSha256), 'utf8')
        candidateSkillSnapshot = snapshotPath
      }
      const dshHome = join(root, 'homes', `${task.id}-${arm}`)
      mkdirSync(dshHome, { recursive: true })
      // The patch MUST live in the agent-lane directory itself: the profile
      // loader resolves './'-relative plugin names (the committed shims)
      // against the patch file's directory (the carrier-probe lesson — a
      // patch written elsewhere silently composes with NO governance
      // plugins). The name carries pid+uuid so concurrent lane processes in
      // one container cannot delete each other's patch mid-composition.
      const patchPath = join(BASE_DIR, `.child-${task.id}-${arm}-${process.pid}-${randomUUID().slice(0, 8)}.patch.yml`)
      writeFileSync(patchPath, buildChildPatchYaml({
        brokerBaseUrl: broker!.baseUrl,
        modelId,
        workspace,
        ledgerPath,
        netDecisionLog,
        netMode: 'deny-all',
        netAllowlist: [],
        readDenyDirs: [],
        skillDirs: [],
        childHome: dshHome,
      }), 'utf8')

      const promptText = `${task.prompt}\n\n工作区即当前目录；完成修改后简短确认即可。`
      // resetScript re-arms the sequence but requests accumulate over the
      // server lifetime — slice per arm for this arm's evidence.
      const requestsBefore = mock === undefined ? 0 : mock.requests.length
      if (lane === 'mock') {
        // Mock scripts (mechanism proof): baseline declines to change
        // anything; candidate applies the task's REFERENCE fix through the
        // child's own tool execution — as a model that already knows the
        // answer would.
        const script: ScriptedResponse[] = arm === 'baseline'
          ? [{ content: '已审阅，无需修改。', promptTokens: 9, completionTokens: 3 }]
          : []
        if (arm === 'candidate') {
          const entryFile = task.allowedFiles[0]!
          const referenceContent = readFileSync(join(task.referenceDir, entryFile), 'utf8')
          script.push(
            { content: '', callFirstTool: { firstStringArg: heredocWriteCommand(join(workspace, entryFile), referenceContent) }, promptTokens: 11, completionTokens: 5 },
            { content: '已按要求修改完成。', promptTokens: 40, completionTokens: 3 },
          )
        }
        mock!.resetScript(script)
      }

      const before = broker!.report()
      let child: Awaited<ReturnType<typeof runDshChild>>
      try {
        child = await runDshChild({
          label: `${task.id}-${arm}`,
          promptText,
          workspace,
          dshHome,
          patchPath,
          stderrLog: stderrLogFor(root, `${task.id}-${arm}`),
          modelId,
          candidateSkillPath: candidateSkillSnapshot,
          skillDumpLog: join(root, 'skill-lens.log'),
          // A real-model fix can legitimately take minutes (multi-turn tool
          // use); mock arms resolve in seconds.
          timeoutMs: lane === 'real' ? 600_000 : 180_000,
        })
      } finally {
        rmSync(patchPath, { force: true })
      }
      const after = broker!.report()
      const judge = await runJudge(task.judgePath, workspace)
      const skillInRequest = mock !== undefined
        && mock.requests.slice(requestsBefore).some(request => request.messageText.includes(SKILL_MARKER))
      return {
        arm,
        stopReason: child.stopReason,
        diagnostic: child.diagnostic,
        error: child.error,
        timedOut: child.timedOut,
        durationMs: child.durationMs,
        childPids: child.childPids,
        brokerCalls: after.calls - before.calls,
        brokerTokens: after.totalTokens - before.totalTokens,
        skillInRequest,
        judge: summarizeJudge(judge),
        workspace,
      }
    }

    for (const task of tasks) {
      const baseline = await runArm(task, 'baseline')
      const candidate = await runArm(task, 'candidate')
      const taskBlocked = baseline.stopReason !== 'completed' || candidate.stopReason !== 'completed'
      if (taskBlocked) {
        blocked.push(`${task.id}: baseline=${baseline.stopReason} candidate=${candidate.stopReason}`)
      }
      outcomes.push({ id: task.id, category: task.category, baseline, candidate, blocked: taskBlocked })
      console.log(`[agent-lane] ${task.id}: baseline judge=${String(baseline.judge.ok)} candidate judge=${String(candidate.judge.ok)} ` +
        `stop=${baseline.stopReason}/${candidate.stopReason} calls=${String(baseline.brokerCalls)}+${String(candidate.brokerCalls)} ` +
        `skillInRequest=${String(candidate.skillInRequest)}`)
    }

    if (recorder.hits.length > 0) {
      securityFindings.push({ kind: 'unauthorized-egress', detail: `net recorder saw ${String(recorder.hits.length)} hit(s) during trials` })
    }
    // Capture the metering snapshot while the broker is still alive —
    // report() after stop() is not part of the broker's contract.
    finalMetering = broker.report()
  } finally {
    await broker?.stop().catch(() => undefined)
    await mock?.stop().catch(() => undefined)
    await recorder.stop()
  }

  const metering = finalMetering!
  const baselineCases: CaseOutcome[] = outcomes.map(outcome => ({
    caseId: outcome.id, category: outcome.category, success: outcome.baseline.judge.ok,
    costTokens: outcome.baseline.brokerTokens, latencyMs: outcome.baseline.durationMs,
  }))
  const candidateCases: CaseOutcome[] = outcomes.map(outcome => ({
    caseId: outcome.id, category: outcome.category, success: outcome.candidate.judge.ok,
    costTokens: outcome.candidate.brokerTokens, latencyMs: outcome.candidate.durationMs,
  }))
  const rate = (cases: readonly CaseOutcome[]): number => cases.length === 0 ? 0 : (cases.filter(c => c.success).length / cases.length) * 100
  const campaign = evaluate({
    policy: PROVISIONAL_POLICY,
    baseline: { runId: 'agent-lane-baseline', cases: baselineCases },
    candidate: { runId: 'agent-lane-candidate', cases: candidateCases },
    securityFindings,
    executionCounts: {
      expected: tasks.length,
      executed: outcomes.length,
      skipped: 0,
      blocked: outcomes.filter(outcome => outcome.blocked).length,
    },
    environmentFingerprintMatch: agentLock.ok && evolutionLock.ok,
    capabilityGaps: [],
  })

  // Lane gate (mechanism invariants, not a scoring claim):
  //   mock — the scripted sweep must hold (candidate 6/6 judge-pass,
  //          baseline all judge-fail), every child completed, zero egress,
  //          metering live, skill snapshot reached every candidate request.
  //   real — the run must simply complete and stay confined; the campaign
  //          decision is DATA (recalibration input), never this exit code.
  const gateFailures: string[] = [...blocked]
  if (lane === 'mock') {
    for (const outcome of outcomes) {
      if (!outcome.candidate.judge.ok) gateFailures.push(`${outcome.id}: candidate judge failed (mock sweep must pass)`)
      if (outcome.baseline.judge.ok) gateFailures.push(`${outcome.id}: baseline judge passed (mock baseline must fail)`)
      if (!outcome.candidate.skillInRequest) gateFailures.push(`${outcome.id}: candidate skill never reached the model request`)
    }
    if (metering.calls <= 0) gateFailures.push('broker metering saw no calls')
  }
  for (const finding of securityFindings) gateFailures.push(`security:${finding.kind}:${finding.detail}`)

  const report: LaneReport = {
    schema: 'hourglass-agent-lane-report/1',
    at: new Date().toISOString(),
    lane,
    dryRun: false,
    ok: gateFailures.length === 0,
    blocked: gateFailures,
    locks: {
      agentLane: { ok: agentLock.ok, sha256: agentLock.lockSha256 },
      evolution: { ok: evolutionLock.ok, sha256: evolutionLock.lockSha256 },
    },
    manifestSha256: loaded.manifestSha256,
    tasks: outcomes,
    rates: { baselinePct: rate(baselineCases), candidatePct: rate(candidateCases) },
    campaign: {
      decision: campaign.decision,
      reasonCodes: campaign.reasonCodes,
      policy: PROVISIONAL_POLICY,
      policyProvisional: true,
    },
    securityFindings,
    metering: {
      calls: metering.calls,
      totalTokens: metering.totalTokens,
      usageUnknownCalls: metering.usageUnknownCalls,
      cappedReason: metering.cappedReason,
      wallClockMs: Date.now() - startedAt,
    },
    model: modelId,
    upstream,
  }
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  console.log(`[agent-lane] lane=${lane} tasks=${String(outcomes.length)} rates: baseline=${report.rates.baselinePct.toFixed(1)}% candidate=${report.rates.candidatePct.toFixed(1)}%`)
  console.log(`[agent-lane] campaign=${campaign.decision} (${campaign.reasonCodes.join(',')}) [policy provisional — recalibrate on first real baseline]`)
  console.log(`[agent-lane] metering: calls=${String(metering.calls)} tokens=${String(metering.totalTokens)} unknown=${String(metering.usageUnknownCalls)} capped=${metering.cappedReason ?? 'none'}`)
  for (const failure of gateFailures) console.log(`[agent-lane] GATE: ${failure}`)
  console.log(`[agent-lane] ${report.ok ? 'OK' : 'FAILED'} report=${join(outDir, 'report.json')}`)
  if (report.ok && process.env['HOURGLASS_AGENT_LANE_KEEP'] !== '1') {
    rmSync(root, { recursive: true, force: true })
  } else {
    console.log(`[agent-lane] artifacts kept for inspection: ${root}`)
  }
  return report.ok ? 0 : 1
}

main().then(code => process.exit(code), error => {
  console.error(`[agent-lane] runner crashed: ${String(error?.stack ?? error)}`)
  process.exit(1)
})
