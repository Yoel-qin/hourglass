/**
 * PERF baseline sampler (plan §6): runs one short command N times per
 * subject and reports median/p95/min/max plus relative overhead against the
 * bare process. Raw samples are kept in the output JSON; thresholds are NOT
 * hard-coded verdicts — the plan requires baselines before limits.
 *
 *   node --experimental-strip-types perf.ts --runs=30 --out=/opt/reports/runs/perf-x
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { validate as validateLock, LOCK_PATH } from './validate-versions-lock.ts'
import { dshBase, dshPlugin } from './adapters/dsh.ts'
import { srt } from './adapters/srt.ts'
import { nsjail } from './adapters/nsjail.ts'
import { wasmer } from './adapters/wasmer.ts'
import type { RawExecution, SubjectAdapter } from './adapters/types.ts'
import type { CaseContext } from './cases.ts'

const here = dirname(fileURLToPath(import.meta.url))

function percentile(sorted: readonly number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)] as number
}

function stats(samples: readonly number[]): { min: number; median: number; p95: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    min: sorted[0] as number,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] as number,
  }
}

async function sample(adapter: SubjectAdapter, context: CaseContext, runs: number): Promise<number[]> {
  const samples: number[] = []
  const caseDefinition = {
    id: 'PERF-01',
    category: 'fs' as const,
    description: 'short command latency',
    profile: 'P1-WORKSPACE-WRITE',
    expectation: 'succeeds' as const,
    action: { kind: 'shell' as const, command: 'printf {CANARY} > {WORKSPACE}/perf.txt && cat {WORKSPACE}/perf.txt >/dev/null' },
    blockedEvidence: 'file-must-not-exist' as const,
    successEvidence: 'file-exists' as const,
    appliesTo: [] as never[],
  }
  const env = { runId: 'perf', net: { requestsFor: () => [], requests: [], stop: async () => undefined, port: 0, baseUrl: () => '' } as never, context, env: {} as NodeJS.ProcessEnv }
  for (let index = 0; index < runs; index += 1) {
    const raw: RawExecution = await adapter.execute(caseDefinition, env)
    samples.push(raw.durationMs)
  }
  return samples
}

/** Bare-process reference: the same shell statement without any sandbox. */
function bareSamples(context: CaseContext, runs: number): number[] {
  const samples: number[] = []
  const command = `printf x > ${context.workspace}/perf.txt && cat ${context.workspace}/perf.txt >/dev/null`
  for (let index = 0; index < runs; index += 1) {
    const started = Date.now()
    spawnSync('bash', ['-c', command], { timeout: 15_000 })
    samples.push(Date.now() - started)
  }
  return samples
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const runsFlag = args.find(argument => argument.startsWith('--runs='))
  const outFlag = args.find(argument => argument.startsWith('--out='))
  const runs = Number(runsFlag?.split('=')[1] ?? 30)
  const outDir = outFlag?.split('=')[1] ?? join(process.cwd(), 'reports', 'runs', `perf-${Date.now().toString(36)}`)
  mkdirSync(outDir, { recursive: true })

  const lockRaw = readFileSync(LOCK_PATH)
  const violations = validateLock(JSON.parse(lockRaw.toString('utf8')))
  if (violations.length > 0) {
    console.error(`[perf] versions.lock.json invalid: ${JSON.stringify(violations)}`)
    process.exit(1)
  }

  const context: CaseContext = {
    workspace: '/root/perf-ws',
    outside: '/root/perf-out',
    sensitive: '/root/perf-sens',
    allowUrl: 'http://invalid',
    denyUrl: 'http://invalid',
    canary: 'PERF',
    port: 0,
  }
  for (const dir of [context.workspace, context.outside, context.sensitive]) {
    spawnSync('mkdir', ['-p', dir])
  }

  const subjects: Record<string, SubjectAdapter> = {
    'DSH-BASE': dshBase,
    'DSH-PLUGIN': dshPlugin,
    SRT: srt,
    NSJAIL: nsjail,
    WASMER: wasmer,
  }
  const report: Record<string, unknown> = {
    schema: 'hourglass-perf/1',
    startedAt: new Date().toISOString(),
    runs,
    versionsLockSha256: createHash('sha256').update(lockRaw).digest('hex'),
    bare: {} as Record<string, unknown>,
    subjects: {} as Record<string, unknown>,
  }

  const bare = bareSamples(context, runs)
  const bareStats = stats(bare)
  report.bare = { stats: bareStats, samples: bare }
  console.log(`bare: median=${bareStats.median}ms p95=${bareStats.p95}ms`)

  for (const [name, adapter] of Object.entries(subjects)) {
    const availability = await adapter.available()
    if (!availability.ok) {
      ;(report.subjects as Record<string, unknown>)[name] = { notRun: availability.reason }
      console.log(`${name}: not-run (${availability.reason?.slice(0, 80)})`)
      continue
    }
    const samples = await sample(adapter, context, runs)
    const subjectStats = stats(samples)
    ;(report.subjects as Record<string, unknown>)[name] = {
      stats: subjectStats,
      samples,
      overheadMedianMs: subjectStats.median - bareStats.median,
      relativeMedian: Number((subjectStats.median / Math.max(1, bareStats.median)).toFixed(2)),
    }
    console.log(`${name}: median=${subjectStats.median}ms p95=${subjectStats.p95}ms overhead=${subjectStats.median - bareStats.median}ms x${(subjectStats.median / Math.max(1, bareStats.median)).toFixed(2)}`)
  }

  const outPath = join(outDir, 'perf.json')
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`[perf] -> ${outPath}`)
  void here
}

await main()
