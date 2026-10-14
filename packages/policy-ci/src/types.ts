/**
 * Policy-replay vocabulary for @hourglass/policy-ci.
 *
 * Fixtures are synthetic, frozen, and reviewed — never recorded sessions,
 * user material, or anything ambient (POL-07). The replay is a pure function
 * of (fixture, world): same inputs, byte-identical output (POL-01).
 * @module @hourglass/policy-ci
 */

import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

/** One operation a fixture asks the policy model to judge. */
export type PolicyOperation =
  | { readonly kind: 'fs-write'; readonly path: string }
  | { readonly kind: 'fs-read'; readonly path: string }
  | { readonly kind: 'fs-delete'; readonly path: string }
  | { readonly kind: 'fs-rename'; readonly from: string; readonly to: string }
  | { readonly kind: 'net-request'; readonly host: string; readonly port?: number }
  | { readonly kind: 'spawn' }

/**
 * One synthetic call under test. Paths and hosts are synthetic constants
 * (never real user data); `sandboxModeEvents` replays the session fold input.
 */
export interface PolicyFixture {
  readonly caseId: string
  readonly description: string
  readonly sandboxModeEvents?: readonly SandboxMode[]
  readonly approvedMode?: SandboxMode
  readonly tool: string
  readonly operation: PolicyOperation
}

/**
 * The deployed policy a replay runs against: the configured mode plus the
 * optional extended rule sets hourglass models. `denyRead` and `netAllowlist`
 * are hourglass P2 extensions; an absent list means the extension is off and
 * the DSH base semantics decide.
 */
export interface PolicyWorld {
  readonly configuredMode: SandboxMode
  readonly workspaceRoot: string
  readonly denyRead?: readonly string[]
  /** Empty array means deny-all; `'unrestricted'` (default) means no extension applies. */
  readonly netAllowlist?: readonly string[] | 'unrestricted'
}

/** Outcome of replaying one fixture. */
export type ReplayDecision =
  | { readonly caseId: string; readonly status: 'decided'; readonly decision: 'allow' | 'deny'; readonly mode: SandboxMode; readonly reason: string }
  | { readonly caseId: string; readonly status: 'not-replayable'; readonly reason: string }

/** Classification of one changed case between two replays (POL-02). */
export type DecisionChange =
  | { readonly kind: 'allow-to-deny' }
  | { readonly kind: 'deny-to-allow' }
  | { readonly kind: 'to-unknown' }
  | { readonly kind: 'to-not-replayable' }
  | { readonly kind: 'reason-only' }
  | { readonly kind: 'not-replayable-to-decided' }

export interface DecisionDiffEntry {
  readonly caseId: string
  readonly change: DecisionChange
  readonly before: ReplayDecision
  readonly after: ReplayDecision
}

export interface DecisionDiff {
  readonly schema: 'hourglass-policy-diff/1'
  readonly generatedAt: string
  readonly totalCases: number
  readonly changed: readonly DecisionDiffEntry[]
  readonly unchanged: number
}
