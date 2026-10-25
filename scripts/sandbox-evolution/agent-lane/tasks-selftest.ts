/**
 * Agent-lane task-set selftest (discrimination validity): a hidden judge is
 * only usable as a trial verdict if it actually discriminates — it must
 * FAIL the frozen buggy fixture and PASS the real reference fix. This gate
 * runs both sides of every task with zero model involvement (judges are
 * standalone node scripts), so it stays PR-gate-safe under the mock-model
 * discipline. Also re-verifies the content-addressed manifest and the
 * agent-lane lock before judging anything (fail closed on drift).
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadAgentTasks,
  makeScratchWorkspace,
  materializeTaskWorkspace,
  runJudge,
  verifyAgentLaneLock,
} from './tasks.ts'
import type { AgentTask, JudgeOutcome } from './tasks.ts'

/** Materialize both sides, judge each against the SAME hidden judge. */
async function judgeTaskSides(task: AgentTask, scratchRoot: string): Promise<{ fixtureJudge: JudgeOutcome; referenceJudge: JudgeOutcome }> {
  const fixtureWs = makeScratchWorkspace(scratchRoot, `${task.id}-fixture`)
  const referenceWs = makeScratchWorkspace(scratchRoot, `${task.id}-reference`)
  try {
    materializeTaskWorkspace(task.fixtureDir, fixtureWs)
    materializeTaskWorkspace(task.referenceDir, referenceWs)
    const fixtureJudge = await runJudge(task.judgePath, fixtureWs)
    const referenceJudge = await runJudge(task.judgePath, referenceWs)
    return { fixtureJudge, referenceJudge }
  } finally {
    rmSync(fixtureWs, { recursive: true, force: true })
    rmSync(referenceWs, { recursive: true, force: true })
  }
}

const BASE_DIR = dirname(fileURLToPath(import.meta.url))
const TASKS_DIR = join(BASE_DIR, 'tasks')
const LOCK_PATH = join(BASE_DIR, '..', 'agent-lane.lock.json')

interface JudgeSummary {
  readonly ok: boolean
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly error?: string
  readonly failedChecks: readonly string[]
  readonly passedChecks: number
}

interface TaskSelftest {
  readonly id: string
  readonly category: string
  readonly fixtureRejected: boolean
  readonly referenceAccepted: boolean
  readonly discriminates: boolean
  readonly fixtureJudge: JudgeSummary
  readonly referenceJudge: JudgeSummary
}

function summarizeJudge(outcome: JudgeOutcome): JudgeSummary {
  return {
    ok: outcome.ok,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    error: outcome.error,
    failedChecks: outcome.checks.filter(check => !check.ok).map(check => check.name),
    passedChecks: outcome.checks.filter(check => check.ok).length,
  }
}

async function main(): Promise<number> {
  const outArg = process.argv.find(arg => arg.startsWith('--out='))
  const outDir = outArg !== undefined ? outArg.slice('--out='.length) : join(BASE_DIR, '..', '..', '..', 'reports', 'runs', 'agent-tasks-selftest-latest')
  mkdirSync(outDir, { recursive: true })

  const lock = verifyAgentLaneLock(LOCK_PATH)
  const loaded = lock.ok ? loadAgentTasks(TASKS_DIR) : undefined

  const results: TaskSelftest[] = []
  if (loaded !== undefined) {
    const scratchRoot = join(outDir, 'scratch')
    mkdirSync(scratchRoot, { recursive: true })
    for (const task of loaded.tasks) {
      const { fixtureJudge, referenceJudge } = await judgeTaskSides(task, scratchRoot)
      const fixtureRejected = !fixtureJudge.ok
      const referenceAccepted = referenceJudge.ok
      results.push({
        id: task.id,
        category: task.category,
        fixtureRejected,
        referenceAccepted,
        discriminates: fixtureRejected && referenceAccepted,
        fixtureJudge: summarizeJudge(fixtureJudge),
        referenceJudge: summarizeJudge(referenceJudge),
      })
    }
    rmSync(scratchRoot, { recursive: true, force: true })
  }

  const report = {
    schema: 'hourglass-agent-tasks-selftest/1',
    at: new Date().toISOString(),
    ok: lock.ok && loaded !== undefined && results.length === (loaded?.tasks.length ?? -1) && results.every(entry => entry.discriminates),
    lock: { ok: lock.ok, errors: lock.errors, sha256: lock.lockSha256 },
    manifest: loaded === undefined ? undefined : { sha256: loaded.manifestSha256, taskCount: loaded.tasks.length, verifiedFileCount: loaded.verifiedFileCount },
    tasks: results,
  }
  writeFileSync(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  console.log(`[agent-tasks] lock=${lock.ok ? 'OK' : 'FAILED'} manifest=${loaded === undefined ? 'FAILED' : `OK (${loaded.tasks.length} tasks, ${loaded.verifiedFileCount} verified files)`}`)
  for (const entry of results) {
    console.log(`[agent-tasks] ${entry.id}: fixtureRejected=${String(entry.fixtureRejected)} referenceAccepted=${String(entry.referenceAccepted)} discriminates=${String(entry.discriminates)}`)
    if (!entry.discriminates) {
      console.log(`[agent-tasks]   fixture judge: ${JSON.stringify(entry.fixtureJudge)}`)
      console.log(`[agent-tasks]   reference judge: ${JSON.stringify(entry.referenceJudge)}`)
    }
  }
  for (const error of lock.errors) {
    console.error(`[agent-tasks] ${error}`)
  }
  console.log(`[agent-tasks] ${report.ok ? 'OK' : 'FAILED'} report=${join(outDir, 'report.json')}`)
  return report.ok ? 0 : 1
}

main().then(code => process.exit(code), error => {
  console.error(`[agent-tasks] selftest crashed: ${String(error?.stack ?? error)}`)
  process.exit(1)
})
