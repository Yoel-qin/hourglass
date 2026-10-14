/**
 * Replay engine and decision differ. `replay` maps fixtures through the pure
 * model; `diffDecisions` classifies every change between two replays so a
 * policy PR can be reviewed by its decision diff, not by reading config
 * (POL-01..POL-05).
 * @module @hourglass/policy-ci
 */

import { decide } from './model.ts'
import type { DecisionDiff, DecisionDiffEntry, PolicyFixture, PolicyWorld, ReplayDecision } from './types.ts'

/** Replay fixtures against one world. Order of input fixtures is preserved. */
export function replay(fixtures: readonly PolicyFixture[], world: PolicyWorld): readonly ReplayDecision[] {
  return fixtures.map(fixture => decide(fixture, world))
}

function changeKind(before: ReplayDecision, after: ReplayDecision): DecisionDiffEntry['change'] | undefined {
  if (before.status === 'decided' && after.status === 'decided') {
    if (before.decision === after.decision) {
      return before.reason === after.reason ? undefined : { kind: 'reason-only' }
    }
    if (before.decision === 'allow' && after.decision === 'deny') return { kind: 'allow-to-deny' }
    if (before.decision === 'deny' && after.decision === 'allow') return { kind: 'deny-to-allow' }
    return { kind: 'to-unknown' }
  }
  if (before.status === 'not-replayable' && after.status === 'decided') return { kind: 'not-replayable-to-decided' }
  if (after.status === 'not-replayable') return { kind: 'to-not-replayable' }
  return undefined
}

/**
 * Diff two replays of the same fixture list. Cases are joined by `caseId`;
 * a case present in only one side counts as changed with its missing side
 * synthesized as not-replayable.
 */
export function diffDecisions(
  fixtures: readonly PolicyFixture[],
  before: readonly ReplayDecision[],
  after: readonly ReplayDecision[],
): DecisionDiff {
  const beforeByCase = new Map(before.map(decision => [decision.caseId, decision]))
  const afterByCase = new Map(after.map(decision => [decision.caseId, decision]))
  const caseIds = new Set<string>([...beforeByCase.keys(), ...afterByCase.keys()])
  const changed: DecisionDiffEntry[] = []
  let unchanged = 0
  for (const caseId of caseIds) {
    const beforeDecision = beforeByCase.get(caseId)
    const afterDecision = afterByCase.get(caseId)
    const left: ReplayDecision = beforeDecision ?? { caseId, status: 'not-replayable', reason: 'absent from before replay' }
    const right: ReplayDecision = afterDecision ?? { caseId, status: 'not-replayable', reason: 'absent from after replay' }
    const change = changeKind(left, right)
    if (change === undefined) {
      unchanged += 1
    } else {
      changed.push({ caseId, change, before: left, after: right })
    }
  }
  return {
    schema: 'hourglass-policy-diff/1',
    generatedAt: new Date().toISOString(),
    totalCases: caseIds.size,
    changed,
    unchanged,
  }
}

/** Convenience: replay old world and new world, then diff (the PR workflow). */
export function replayDiff(
  fixtures: readonly PolicyFixture[],
  beforeWorld: PolicyWorld,
  afterWorld: PolicyWorld,
): DecisionDiff {
  return diffDecisions(fixtures, replay(fixtures, beforeWorld), replay(fixtures, afterWorld))
}
