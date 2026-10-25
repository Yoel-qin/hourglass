/**
 * Aggregate agent-lane sample reports into calibration data (ADR-004
 * appendix inputs): per task × arm success/calls/tokens/duration
 * distributions across runs, plus per-run PAIRED deltas (candidate −
 * baseline) — the paired design is what controls run-to-run environment
 * noise. Pure node, zero deps; run:
 *   node --experimental-strip-types aggregate-samples.ts {sampleRoot}
 * where {sampleRoot} holds agent-lane-sample-N directories (each with report.json).
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface ArmEntry {
  readonly arm: string
  readonly stopReason: string
  readonly durationMs: number
  readonly brokerCalls: number
  readonly brokerTokens: number
  readonly judge: { readonly ok: boolean }
}

interface SampleReport {
  readonly lane: string
  readonly at: string
  readonly ok: boolean
  readonly tasks: readonly { id: string; category: string; baseline: ArmEntry; candidate: ArmEntry; blocked: boolean }[]
  readonly metering: { readonly calls: number; readonly totalTokens: number; readonly usageUnknownCalls: number }
}

interface TaskStats {
  readonly id: string
  readonly category: string
  readonly runs: number
  readonly baselineSuccess: number
  readonly candidateSuccess: number
  readonly baselineTokens: readonly number[]
  readonly candidateTokens: readonly number[]
  readonly baselineCalls: readonly number[]
  readonly candidateCalls: readonly number[]
  readonly pairedTokenDelta: readonly number[]
  readonly pairedCallDelta: readonly number[]
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[index]!
}

function fmt(values: readonly number[]): string {
  if (values.length === 0) return '-'
  const sorted = [...values].sort((a, b) => a - b)
  return `n=${String(sorted.length)} mean=${mean(sorted).toFixed(0)} min=${String(sorted[0])} p50=${String(quantile(sorted, 0.5))} max=${String(sorted[sorted.length - 1])}`
}

function main(): number {
  const root = process.argv[2] ?? 'reports/runs'
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('agent-lane-sample-'))
    .map(entry => join(root, entry.name))
    .sort()
  const reports: { run: string; report: SampleReport }[] = []
  for (const dir of dirs) {
    const path = join(dir, 'report.json')
    if (!existsSync(path)) continue
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as SampleReport
    if (parsed.lane !== 'real') continue
    reports.push({ run: dir.split(/[\\/]/).pop() ?? dir, report: parsed })
  }
  if (reports.length === 0) {
    console.error(`[aggregate] no real-lane sample reports under ${root}`)
    return 1
  }

  const byTask = new Map<string, { category: string; runs: number; baselineSuccess: number; candidateSuccess: number; baselineTokens: number[]; candidateTokens: number[]; baselineCalls: number[]; candidateCalls: number[]; pairedTokenDelta: number[]; pairedCallDelta: number[] }>()
  for (const { report } of reports) {
    for (const task of report.tasks) {
      let entry = byTask.get(task.id)
      if (entry === undefined) {
        entry = { category: task.category, runs: 0, baselineSuccess: 0, candidateSuccess: 0, baselineTokens: [], candidateTokens: [], baselineCalls: [], candidateCalls: [], pairedTokenDelta: [], pairedCallDelta: [] }
        byTask.set(task.id, entry)
      }
      entry.runs += 1
      if (task.baseline.judge.ok) entry.baselineSuccess += 1
      if (task.candidate.judge.ok) entry.candidateSuccess += 1
      entry.baselineTokens.push(task.baseline.brokerTokens)
      entry.candidateTokens.push(task.candidate.brokerTokens)
      entry.baselineCalls.push(task.baseline.brokerCalls)
      entry.candidateCalls.push(task.candidate.brokerCalls)
      entry.pairedTokenDelta.push(task.candidate.brokerTokens - task.baseline.brokerTokens)
      entry.pairedCallDelta.push(task.candidate.brokerCalls - task.baseline.brokerCalls)
    }
  }

  const tasks: TaskStats[] = [...byTask.entries()].map(([id, entry]) => ({ id, category: entry.category, ...entry }))
  const allPairedTokens: number[] = tasks.flatMap(task => task.pairedTokenDelta)
  const aggregate = {
    schema: 'hourglass-agent-lane-samples/1',
    at: new Date().toISOString(),
    runs: reports.map(entry => ({ run: entry.run, ok: entry.report.ok, tasks: entry.report.tasks.length, calls: entry.report.metering.calls, tokens: entry.report.metering.totalTokens, usageUnknown: entry.report.metering.usageUnknownCalls })),
    perTask: tasks.map(task => ({
      id: task.id,
      category: task.category,
      runs: task.runs,
      baselineSuccess: `${String(task.baselineSuccess)}/${String(task.runs)}`,
      candidateSuccess: `${String(task.candidateSuccess)}/${String(task.runs)}`,
      baselineTokens: fmt(task.baselineTokens),
      candidateTokens: fmt(task.candidateTokens),
      baselineCalls: fmt(task.baselineCalls),
      candidateCalls: fmt(task.candidateCalls),
      pairedTokenDelta: fmt(task.pairedTokenDelta),
      pairedCallDelta: fmt(task.pairedCallDelta),
    })),
    overall: {
      pairedTokenDeltaMean: mean(allPairedTokens),
      pairedTokenDeltaTotal: allPairedTokens.reduce((sum, value) => sum + value, 0),
      totalRuns: reports.length,
    },
  }
  const outPath = join(root, 'agent-lane-samples-aggregate.json')
  writeFileSync(outPath, `${JSON.stringify(aggregate, null, 2)}\n`, 'utf8')

  console.log(`[aggregate] runs=${String(reports.length)} (real lane)`)
  for (const task of aggregate.perTask) {
    console.log(`[aggregate] ${task.id}: base ${task.baselineSuccess} / cand ${task.candidateSuccess}`)
    console.log(`[aggregate]   tokens base ${task.baselineTokens}`)
    console.log(`[aggregate]   tokens cand ${task.candidateTokens}`)
    console.log(`[aggregate]   paired token delta ${task.pairedTokenDelta}`)
  }
  console.log(`[aggregate] overall paired token delta mean=${aggregate.overall.pairedTokenDeltaMean.toFixed(0)} total=${String(aggregate.overall.pairedTokenDeltaTotal)}`)
  console.log(`[aggregate] written ${outPath}`)
  return 0
}

main()
