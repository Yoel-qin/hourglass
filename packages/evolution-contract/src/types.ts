/**
 * Shared types for the hourglass self-evolution safety sandbox contracts.
 *
 * This package is deliberately dependency-free: every export is a pure
 * function over plain data so the contracts can be replayed and golden-tested
 * without a DSH runtime (same discipline as @hourglass/policy-ci).
 */

/** MVP evolvable assets only (ADR-003). Anything else is schema-rejected. */
export type AssetKind = 'dsh_skill' | 'prompt_fragment'

export type MutationKind = 'create' | 'update'

export type RiskTier = 'E0' | 'E1' | 'E2' | 'E3'

/** The only four verdicts the evaluator may emit. */
export type Decision = 'pass' | 'reject' | 'inconclusive' | 'blocked'

/** Candidate lifecycle states (v3.1 plan §3.2). */
export type CandidateState =
  | 'draft'
  | 'sealed'
  | 'prechecked'
  | 'queued'
  | 'trial_running'
  | 'evaluated'
  | 'validation_pack_ready'
  | 'awaiting_human_approval'
  | 'manually_applied'
  | 'watching'
  | 'stable'
  | 'rejected'
  | 'inconclusive'
  | 'blocked'
  | 'cancelled'
  | 'expired'
  | 'apply_conflict'
  | 'rollback_pending'
  | 'rolled_back'

export interface CandidateManifest {
  readonly schemaVersion: 'hourglass-evolution-candidate/1'
  readonly candidateId: string
  readonly proposalId: string
  readonly parentRevision: string
  readonly assetKind: AssetKind
  readonly mutationKind: MutationKind
  /** MVP: candidates live only in the isolated store, never a live profile. */
  readonly scope: 'isolated-store'
  readonly payloadSha256: string
  readonly artifactSha256: string
  readonly versionsLockSha256: string
  readonly requestedCapabilities: readonly string[]
  readonly riskTier: RiskTier
  readonly createdBy: string
  readonly createdAt: string
  readonly sourceNote: string
  readonly benchmarkId: string
  readonly benchmarkVersion: number
  readonly benchmarkManifestSha256: string
  readonly environmentFingerprint: string
  readonly trialId?: string
  readonly decision?: Decision
  readonly decisionReasonCodes?: readonly string[]
  readonly promotionState?: string
}

/** Security hard-gate findings. Any single one forces `reject`. */
export type SecurityFindingKind =
  | 'unauthorized-read'
  | 'unauthorized-write'
  | 'canary-leak'
  | 'unauthorized-egress'
  | 'host-tool-bypass'
  | 'cross-session'
  | 'evidence-tamper'
  | 'real-side-effect'

export interface SecurityFinding {
  readonly kind: SecurityFindingKind
  readonly detail: string
}

export interface CaseOutcome {
  readonly caseId: string
  readonly category: string
  readonly success: boolean
  readonly costTokens?: number
  readonly latencyMs?: number
}

/** One frozen-benchmark run (baseline or candidate). Case order must align. */
export interface RunSummary {
  readonly runId: string
  readonly cases: readonly CaseOutcome[]
}

export interface ExecutionCounts {
  readonly expected: number
  readonly executed: number
  readonly skipped: number
  readonly blocked: number
}
