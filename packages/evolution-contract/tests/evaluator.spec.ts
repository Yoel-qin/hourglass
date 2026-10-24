import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MVP_A_POLICY, computeMetrics, evaluate } from '../src/index.ts'
import type { EvaluationInput, EvaluationOutput, SecurityFindingKind } from '../src/index.ts'
import { CATS8, countsOk, runFromBits } from './helpers.ts'

const here = dirname(fileURLToPath(import.meta.url))

interface GoldenScenario {
  readonly name: string
  readonly baseline: readonly number[]
  readonly candidate: readonly number[]
  readonly categories: readonly string[]
  readonly controlRun?: readonly number[]
  readonly securityFindings?: readonly { kind: SecurityFindingKind; detail: string }[]
  readonly counts?: { expected: number; executed: number; skipped: number; blocked: number }
  readonly envMatch?: boolean
  readonly capabilityGaps?: readonly string[]
  readonly policy?: { minImprovementPctPoints?: number }
  readonly latency?: { baseline?: number; candidate?: number }
  readonly tokens?: { baseline?: number; candidate?: number }
  readonly misaligned?: boolean
  readonly expected: { decision: EvaluationOutput['decision']; reasonCodes: readonly string[] }
}

function loadGolden(): readonly GoldenScenario[] {
  const raw = JSON.parse(readFileSync(join(here, 'golden', 'evaluator-golden.json'), 'utf8')) as { scenarios: GoldenScenario[] }
  return raw.scenarios
}

function inputFromScenario(scenario: GoldenScenario): EvaluationInput {
  const latency = scenario.latency ?? {}
  const tokens = scenario.tokens ?? {}
  const candidate = runFromBits(scenario.candidate, scenario.categories, 'candidate', {
    ...(latency.candidate !== undefined ? { latencyMs: latency.candidate } : {}),
    ...(tokens.candidate !== undefined ? { costTokens: tokens.candidate } : {}),
  })
  if (scenario.misaligned === true) {
    for (const outcome of candidate.cases) {
      ;(outcome as { caseId: string }).caseId = `${outcome.caseId}-x`
    }
  }
  return {
    policy: { ...MVP_A_POLICY, ...(scenario.policy ?? {}) },
    baseline: runFromBits(scenario.baseline, scenario.categories, 'baseline', {
      ...(latency.baseline !== undefined ? { latencyMs: latency.baseline } : {}),
      ...(tokens.baseline !== undefined ? { costTokens: tokens.baseline } : {}),
    }),
    candidate,
    ...(scenario.controlRun !== undefined ? { controlRun: runFromBits(scenario.controlRun, scenario.categories, 'control') } : {}),
    securityFindings: scenario.securityFindings ?? [],
    executionCounts: scenario.counts ?? countsOk(scenario.baseline.length),
    environmentFingerprintMatch: scenario.envMatch ?? true,
    capabilityGaps: scenario.capabilityGaps ?? [],
  }
}

describe('evaluator golden (EVO-BENCH contract semantics)', () => {
  const scenarios = loadGolden()

  it('the frozen golden set covers every decision class', () => {
    const decisions = new Set(scenarios.map(scenario => scenario.expected.decision))
    expect([...decisions].sort()).toEqual(['blocked', 'inconclusive', 'pass', 'reject'])
  })

  for (const scenario of scenarios) {
    it(`golden: ${scenario.name}`, () => {
      const output = evaluate(inputFromScenario(scenario))
      expect({ decision: output.decision, reasonCodes: [...output.reasonCodes] })
        .toEqual({ decision: scenario.expected.decision, reasonCodes: [...scenario.expected.reasonCodes] })
    })
  }

  it('replaying the golden set is deterministic (byte-identical)', () => {
    const first = JSON.stringify(scenarios.map(scenario => evaluate(inputFromScenario(scenario))))
    const second = JSON.stringify(scenarios.map(scenario => evaluate(inputFromScenario(scenario))))
    expect(first).toBe(second)
  })
})

describe('evaluator metrics', () => {
  it('computes paired improvement and CI on a known vector', () => {
    const metrics = computeMetrics(
      runFromBits([1, 0, 1, 0, 1, 0, 1, 0], CATS8, 'b').cases,
      runFromBits([1, 1, 1, 1, 1, 1, 1, 1], CATS8, 'c').cases,
    )
    expect(metrics.pairedSamples).toBe(8)
    expect(metrics.baselineRatePct).toBe(50)
    expect(metrics.candidateRatePct).toBe(100)
    expect(metrics.improvementPctPoints).toBe(50)
    expect(metrics.ciLowerPctPoints).toBeGreaterThan(0)
    expect(metrics.categoryRegressions).toEqual([])
  })

  it('reports regressions per category with zero budget semantics', () => {
    const metrics = computeMetrics(
      runFromBits([1, 1, 1, 1, 1, 0], ['core', 'core', 'core', 'core', 'aux', 'aux'], 'b').cases,
      runFromBits([1, 1, 1, 1, 0, 0], ['core', 'core', 'core', 'core', 'aux', 'aux'], 'c').cases,
    )
    expect(metrics.categoryRegressions).toEqual(['aux'])
  })

  it('leaves latency and token deltas undefined when runs do not report them', () => {
    const metrics = computeMetrics(
      runFromBits([1, 0], ['a', 'a'], 'b').cases,
      runFromBits([1, 1], ['a', 'a'], 'c').cases,
    )
    expect(metrics.latencyP95DegradationPct).toBeUndefined()
    expect(metrics.tokenDeltaPct).toBeUndefined()
  })

  it('treats a zero baseline p95 / zero token total as not comparable', () => {
    const zero = [
      { cases: runFromBits([1, 1], ['a', 'a'], 'b', { latencyMs: 0, costTokens: 0 }).cases },
      { cases: runFromBits([1, 1], ['a', 'a'], 'c', { latencyMs: 0, costTokens: 0 }).cases },
    ] as const
    const metrics = computeMetrics(zero[0].cases, zero[1].cases)
    expect(metrics.latencyP95DegradationPct).toBeUndefined()
    expect(metrics.tokenDeltaPct).toBeUndefined()
  })

  it('treats one-sided token reporting as not comparable', () => {
    const metrics = computeMetrics(
      runFromBits([1, 1], ['a', 'a'], 'b', { costTokens: 100 }).cases,
      runFromBits([1, 1], ['a', 'a'], 'c').cases,
    )
    expect(metrics.tokenDeltaPct).toBeUndefined()
  })

  it('handles empty runs and a category absent from one side', () => {
    const empty = computeMetrics([], [])
    expect(empty.latencyP95DegradationPct).toBeUndefined()
    expect(empty.tokenDeltaPct).toBeUndefined()
    const shifted = computeMetrics(
      [{ caseId: 'c1', category: 'a', success: true }],
      [{ caseId: 'c1', category: 'b', success: true }],
    )
    expect(shifted.categoryRegressions).toEqual(['a'])
  })
})

describe('evaluator remaining gates', () => {
  it('rejects on an execution-count mismatch without any skip', () => {
    const output = evaluate(inputFromScenario({
      name: 'count-mismatch',
      baseline: [1, 0, 1, 0, 1, 0, 1, 0],
      candidate: [1, 1, 1, 1, 1, 1, 1, 1],
      categories: CATS8,
      counts: { expected: 9, executed: 8, skipped: 0, blocked: 0 },
      expected: { decision: 'reject' as const, reasonCodes: ['execution-count-mismatch'] },
    }))
    expect(output.decision).toBe('reject')
    expect(output.reasonCodes).toEqual(['execution-count-mismatch'])
  })

  it('a stable control run falls through to the sample-size gate', () => {
    const output = evaluate({
      policy: MVP_A_POLICY,
      baseline: runFromBits([1, 0], ['a', 'a'], 'b'),
      candidate: runFromBits([1, 1], ['a', 'a'], 'c'),
      controlRun: runFromBits([1, 0], ['a', 'a'], 'control'),
      securityFindings: [],
      executionCounts: { expected: 2, executed: 2, skipped: 0, blocked: 0 },
      environmentFingerprintMatch: true,
      capabilityGaps: [],
    })
    expect(output.decision).toBe('inconclusive')
    expect(output.reasonCodes).toEqual(['insufficient-samples'])
  })

  it('an empty control run diverges from a non-empty baseline as unstable', () => {
    const output = evaluate({
      policy: MVP_A_POLICY,
      baseline: runFromBits([1, 0], ['a', 'a'], 'b'),
      candidate: runFromBits([1, 1], ['a', 'a'], 'c'),
      controlRun: { runId: 'control', cases: [] },
      securityFindings: [],
      executionCounts: { expected: 2, executed: 2, skipped: 0, blocked: 0 },
      environmentFingerprintMatch: true,
      capabilityGaps: [],
    })
    expect(output.decision).toBe('inconclusive')
    expect(output.reasonCodes).toEqual(['unstable-environment'])
  })
})
