/**
 * @hourglass/policy-ci public surface.
 * @module @hourglass/policy-ci
 */

export { decide, resolveMode, isPathInside, normalizeHost, hostAllowedByAllowlist, SANDBOX_MODES } from './model.ts'
export { replay, replayDiff, diffDecisions } from './replay.ts'
export type {
  PolicyOperation,
  PolicyFixture,
  PolicyWorld,
  ReplayDecision,
  DecisionChange,
  DecisionDiff,
  DecisionDiffEntry,
} from './types.ts'
