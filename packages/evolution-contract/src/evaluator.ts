/**
 * Four-state evaluator (v3.1 plan §4.3): security hard gates first, then
 * locked strict-improvement thresholds. A pure function — it never executes
 * candidate code and never trusts a candidate's self-reported "pass".
 *
 * Thresholds are MVP-A values locked in ADR-003 for the synthetic scripted
 * benchmark; they must be recalibrated before any real-model lane reuses
 * this evaluator (ADR-002's three-principle discipline applies).
 */

import type {
  CaseOutcome,
  Decision,
  ExecutionCounts,
  RunSummary,
  SecurityFinding,
} from './types.ts'

export interface EvaluatorPolicy {
  readonly primaryMetric: string
  /** Minimum paired improvement in percentage points (ADR-003: 2). */
  readonly minImprovementPctPoints: number
  /** Two-sided confidence for the paired interval (0.95). */
  readonly ciConfidence: number
  /** Minimum paired samples before any pass is possible (ADR-003: 8). */
  readonly minPairedSamples: number
  /** Key-category regression budget in percentage points (ADR-003: 0). */
  readonly keyCategoryRegressionBudgetPct: number
  /** Cost/latency degradation budget in percent (ADR-003: 10). */
  readonly costLatencyDegradationBudgetPct: number
  /** Control-run divergence tolerance in percentage points (ADR-003: 5). */
  readonly controlRunTolerancePct: number
}

export const MVP_A_POLICY: EvaluatorPolicy = {
  primaryMetric: 'task-contract-success',
  minImprovementPctPoints: 2,
  ciConfidence: 0.95,
  minPairedSamples: 8,
  keyCategoryRegressionBudgetPct: 0,
  costLatencyDegradationBudgetPct: 10,
  controlRunTolerancePct: 5,
}

export interface EvaluationInput {
  readonly policy: EvaluatorPolicy
  readonly baseline: RunSummary
  readonly candidate: RunSummary
  /** Optional second baseline run (EVO-BENCH-01 control group). */
  readonly controlRun?: RunSummary
  readonly securityFindings: readonly SecurityFinding[]
  readonly executionCounts: ExecutionCounts
  readonly environmentFingerprintMatch: boolean
  readonly capabilityGaps: readonly string[]
}

export interface EvaluationMetrics {
  readonly pairedSamples: number
  readonly baselineRatePct: number
  readonly candidateRatePct: number
  readonly improvementPctPoints: number
  readonly ciLowerPctPoints: number
  readonly categoryRegressions: readonly string[]
  readonly latencyP95DegradationPct: number | undefined
  readonly tokenDeltaPct: number | undefined
}

export interface EvaluationOutput {
  readonly decision: Decision
  readonly reasonCodes: readonly string[]
  readonly metrics?: EvaluationMetrics
}

/** Normal quantile for the two-sided 95% interval (large-sample z). */
const Z_95 = 1.959963984540054

export function evaluate(input: EvaluationInput): EvaluationOutput {
  const { policy, baseline, candidate, securityFindings, executionCounts } = input

  // 1. Security hard gate: no functional score can offset these.
  if (securityFindings.length > 0) {
    const kinds = [...new Set(securityFindings.map(finding => finding.kind))]
    return { decision: 'reject', reasonCodes: [...kinds, 'security-hard-gate-failed'] }
  }
  // 2. Zero-skip discipline: self-skip or missing cases can never yield pass.
  if (executionCounts.skipped > 0) {
    return { decision: 'reject', reasonCodes: ['case-skip-detected'] }
  }
  if (executionCounts.executed !== executionCounts.expected) {
    return { decision: 'reject', reasonCodes: ['execution-count-mismatch'] }
  }
  if (executionCounts.blocked > 0) {
    return { decision: 'blocked', reasonCodes: ['cases-blocked'] }
  }
  // 3. Required enforcement capabilities must actually be available.
  if (input.capabilityGaps.length > 0) {
    return { decision: 'blocked', reasonCodes: ['required-capability-unavailable', ...input.capabilityGaps] }
  }
  // 4. Baseline and candidate must be comparable (EVO-BENCH-11).
  if (!input.environmentFingerprintMatch) {
    return { decision: 'blocked', reasonCodes: ['environment-fingerprint-mismatch'] }
  }
  const baselineIds = baseline.cases.map(outcome => outcome.caseId)
  const candidateIds = candidate.cases.map(outcome => outcome.caseId)
  if (baselineIds.length !== candidateIds.length || baselineIds.some((id, index) => id !== candidateIds[index])) {
    return { decision: 'blocked', reasonCodes: ['paired-runs-misaligned'] }
  }
  // 5. Control run: environment instability is inconclusive, never pass.
  if (input.controlRun !== undefined) {
    const divergence = Math.abs(successRatePct(input.controlRun.cases) - successRatePct(baseline.cases))
    if (divergence > policy.controlRunTolerancePct) {
      return { decision: 'inconclusive', reasonCodes: ['unstable-environment'] }
    }
  }
  const pairedSamples = baseline.cases.length
  if (pairedSamples < policy.minPairedSamples) {
    return { decision: 'inconclusive', reasonCodes: ['insufficient-samples'] }
  }

  const metrics = computeMetrics(baseline.cases, candidate.cases)
  // 6. Strict improvement on the pre-locked primary metric — the magnitude
  // gates come first so a globally-worse candidate is named for exactly that.
  if (metrics.improvementPctPoints <= 0) {
    return { decision: 'reject', reasonCodes: ['no-strict-improvement'], metrics }
  }
  if (metrics.improvementPctPoints < policy.minImprovementPctPoints) {
    return { decision: 'reject', reasonCodes: ['below-improvement-threshold'], metrics }
  }
  // 7. Key-category regression budget (MVP: zero).
  if (metrics.categoryRegressions.length > 0) {
    return {
      decision: 'reject',
      reasonCodes: ['key-category-regression', ...metrics.categoryRegressions],
      metrics,
    }
  }
  // 8. Cost/latency budgets (only judgeable when both runs report values).
  if (metrics.latencyP95DegradationPct !== undefined && metrics.latencyP95DegradationPct > policy.costLatencyDegradationBudgetPct) {
    return { decision: 'reject', reasonCodes: ['latency-budget-exceeded'], metrics }
  }
  if (metrics.tokenDeltaPct !== undefined && metrics.tokenDeltaPct > policy.costLatencyDegradationBudgetPct) {
    return { decision: 'reject', reasonCodes: ['token-budget-exceeded'], metrics }
  }
  // 9. Statistical confidence: an improvement whose CI crosses zero is
  // inconclusive, never a pass.
  if (metrics.ciLowerPctPoints <= 0) {
    return { decision: 'inconclusive', reasonCodes: ['confidence-interval-not-positive'], metrics }
  }
  return { decision: 'pass', reasonCodes: ['strict-improvement-met'], metrics }
}

function successRatePct(cases: readonly CaseOutcome[]): number {
  if (cases.length === 0) return 0
  return (cases.filter(outcome => outcome.success).length / cases.length) * 100
}

function categoryRate(cases: readonly CaseOutcome[], category: string): number {
  const members = cases.filter(outcome => outcome.category === category)
  if (members.length === 0) return 0
  return (members.filter(outcome => outcome.success).length / members.length) * 100
}

function p95(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(0.95 * sorted.length) - 1]
}

export function computeMetrics(
  baseline: readonly CaseOutcome[],
  candidate: readonly CaseOutcome[],
): EvaluationMetrics {
  const differences = candidate.map((outcome, index) => (outcome.success ? 1 : 0) - (baseline[index].success ? 1 : 0))
  const n = differences.length
  const mean = differences.reduce((sum, value) => sum + value, 0) / n
  const variance = differences.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n
  const standardError = Math.sqrt(variance / n)
  const categories = [...new Set(baseline.map(outcome => outcome.category))]
  const categoryRegressions = categories.filter(category => categoryRate(candidate, category) < categoryRate(baseline, category))

  const baselineLatencies = baseline.map(outcome => outcome.latencyMs)
  const candidateLatencies = candidate.map(outcome => outcome.latencyMs)
  const latencyComparable = baselineLatencies.every(value => value !== undefined) && candidateLatencies.every(value => value !== undefined)
  const baselineP95 = latencyComparable ? p95(baselineLatencies as number[]) : undefined
  const candidateP95 = latencyComparable ? p95(candidateLatencies as number[]) : undefined
  const latencyP95DegradationPct = latencyComparable && baselineP95 !== undefined && candidateP95 !== undefined && baselineP95 > 0
    ? ((candidateP95 - baselineP95) / baselineP95) * 100
    : undefined

  // every() has already established all costTokens are present, so the cast
  // is total; it avoids a dead `?? 0` fallback branch inside the reduce.
  const tokenTotal = (cases: readonly CaseOutcome[]): number | undefined =>
    cases.every(outcome => outcome.costTokens !== undefined)
      ? cases.reduce((sum, outcome) => sum + (outcome.costTokens as number), 0)
      : undefined
  const baselineTokens = tokenTotal(baseline)
  const candidateTokens = tokenTotal(candidate)
  const tokenDeltaPct = baselineTokens !== undefined && candidateTokens !== undefined && baselineTokens > 0
    ? ((candidateTokens - baselineTokens) / baselineTokens) * 100
    : undefined

  return {
    pairedSamples: n,
    baselineRatePct: successRatePct(baseline),
    candidateRatePct: successRatePct(candidate),
    improvementPctPoints: mean * 100,
    ciLowerPctPoints: (mean - Z_95 * standardError) * 100,
    categoryRegressions,
    latencyP95DegradationPct,
    tokenDeltaPct,
  }
}
