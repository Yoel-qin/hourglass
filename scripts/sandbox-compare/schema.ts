/**
 * Unified comparison vocabulary: cases, profiles, outcomes, and the report
 * envelope. Security cases are judged by real side effects (file presence,
 * server-received requests), never by stderr text alone.
 */

export type CompareProfile =
  | 'P0-READONLY'
  | 'P1-WORKSPACE-WRITE'
  | 'P2-DENY-READ'
  | 'P3-NET-ALLOWLIST'
  | 'P4-RESOURCE-LIMITS'
  | 'P5-FAIL-CLOSED'
  | 'DANGER-FULL-ACCESS'

export type CaseCategory = 'fs' | 'net' | 'res' | 'aud' | 'rob'

/** The action a case asks a subject to run inside its sandbox. */
export type CaseAction =
  | { kind: 'shell'; command: string }
  | { kind: 'argv'; argv: readonly string[] }
  /**
   * A harness-tool call the case asks the subject's TOOL layer to run (not
   * the sandboxed shell) — for NET-13-style delegated-call boundary cases.
   */
  | { kind: 'tool'; tool: string; arguments: Record<string, string> }

export interface CompareCase {
  readonly id: string
  readonly category: CaseCategory
  readonly description: string
  readonly profile: CompareProfile
  readonly action: CaseAction
  /** The ideal security outcome for this case under this profile. */
  readonly expectation: 'blocked' | 'succeeds'
  /** What the outside world must observe for the case to count as blocked. */
  readonly blockedEvidence: 'file-must-not-exist' | 'file-content-unchanged' | 'no-server-request' | 'error-surface' | 'limit-enforced' | 'wall-clock' | 'cancel-converge' | 'crash-cleanup' | 'dup-rejected' | 'tamper-detected' | 'fact-chain'
  /** What a legitimately succeeding case must show. */
  readonly successEvidence: 'file-exists' | 'server-request-received' | 'audit-records' | 'error-message'
  readonly appliesTo: readonly SubjectId[]
}

export type SubjectId = 'DSH-BASE' | 'DSH-PLUGIN' | 'SRT' | 'NSJAIL' | 'WASMER' | 'CUBE' | 'CODEX'

export type CaseStatus = 'pass' | 'fail' | 'unsupported' | 'not-run' | 'unknown' | 'blocked'

export interface CaseEvidence {
  readonly exitCode: number | null
  readonly stdoutTail: string
  readonly stderrTail: string
  readonly durationMs: number
  readonly observations: readonly string[]
}

export interface CaseResult {
  readonly runId: string
  readonly subject: SubjectId
  readonly caseId: string
  readonly profile: CompareProfile
  readonly status: CaseStatus
  readonly expected: 'blocked' | 'succeeds'
  readonly evidence: CaseEvidence
  readonly reason: string
}

export interface RunReport {
  readonly schema: 'hourglass-compare/1'
  readonly runId: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly host: {
    readonly platform: NodeJS.Platform
    readonly kernel: string
    readonly container: string
  }
  readonly versionsLockSha256: string
  readonly smokeFile: string
  readonly plannedCases: readonly string[]
  readonly results: readonly CaseResult[]
  readonly summary: Record<SubjectId, { pass: number; fail: number; unsupported: number; notRun: number; unknown: number; blocked: number }>
}

/** Canary token shape used by net cases (synthetic, never a real secret). */
export function syntheticCanary(runId: string): string {
  return `DSH_SYNTHETIC_CANARY_${runId.replaceAll(/[^a-z0-9]/gi, '').slice(0, 12)}`
}
