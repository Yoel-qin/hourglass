/**
 * Audit record schema and fact-layer vocabulary for @hourglass/sandbox-audit.
 *
 * One tool call yields two correlated records — `begin` (policy-decision layer,
 * written at `tools/pre-execute`) and `end` (outcome + backend layer, written at
 * `tools/result`) — joined by `callId`. The OS-observation layer is a reserved
 * fact source: hourglass never fabricates kernel events, so P1 records it as
 * `unavailable` unless a real observer is attached.
 * @module @hourglass/sandbox-audit
 */

import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

/** Schema tag stamped on every record; a reader rejects records with any other tag. */
export const AUDIT_SCHEMA_VERSION = 1

/** Stable string literal identifying the record shape across releases. */
export type AuditSchemaTag = 'hourglass-audit/1'

/** The three evidence layers of the fact-correlation contract. */
export type FactLayer =
  | 'policy_decision'
  | 'backend_result'
  | 'os_observation'

/**
 * Where a recorded fact came from. `unavailable` is honest absence: no signal
 * of that layer existed on the observed events, and absence is never upgraded
 * to a guessed value.
 */
export type FactSource =
  | 'tools/pre-execute'
  | 'sandboxPolicy.resolve'
  | 'tools/result/value.sandbox'
  | 'tools/result/meta.sandbox'
  | 'tools/result/error.info'
  | 'unavailable'

/** Structured denial taxonomy (AUD-02/AUD-11). */
export type DenialClass =
  | 'allowed'
  | 'policy-deny'
  | 'approval-deny'
  | 'sandbox-denial'
  | 'runner-failure'
  | 'ordinary-failure'
  | 'cancelled'
  | 'unknown'

/** How the resolved sandbox mode was obtained for the call. */
export type PolicyResolutionSource = 'approved' | 'session' | 'configured' | 'unavailable'

/** Policy-layer snapshot taken before the call runs. */
export interface AuditPolicySnapshot {
  readonly mode: SandboxMode
  readonly resolvedFrom: PolicyResolutionSource
}

/**
 * Backend-layer facts as reported by a consumer. Only fields actually present
 * on the observed result are recorded; `source` names the extraction point so
 * a reader can tell a bash-sandbox report from an unavailable one.
 */
export interface AuditBackendFacts {
  readonly enforcement?: 'full' | 'partial'
  readonly denied?: boolean
  readonly runnerFailed?: boolean
  readonly source: FactSource
}

/** OS-observation-layer placeholder; P1 never claims kernel ground truth. */
export interface AuditOsObservation {
  readonly status: 'unavailable'
}

/** Redacted, size-bounded summary of the call arguments (AUD-04). */
export interface AuditArgumentsSummary {
  readonly keys: readonly string[]
  readonly redacted: true
  readonly preview: string
}

/** Structured error identity copied from the final result, when one exists. */
export interface AuditErrorFacts {
  readonly name: string
  readonly code?: string
  readonly reason?: string
}

/** Pre-dispatch record: what the policy said before the call ran. */
export interface AuditBeginRecord {
  readonly schema: AuditSchemaTag
  readonly kind: 'begin'
  readonly runId: string
  readonly seq: number
  readonly timestamp: string
  readonly sessionId?: string
  readonly callId: string
  readonly rootCallId?: string
  readonly tool: string
  readonly layer: 'policy_decision'
  readonly policy: AuditPolicySnapshot
  readonly argumentsSummary: AuditArgumentsSummary
}

/** Final record: how the call ended and what each layer actually reported. */
export interface AuditEndRecord {
  readonly schema: AuditSchemaTag
  readonly kind: 'end'
  readonly runId: string
  readonly seq: number
  readonly timestamp: string
  readonly sessionId?: string
  readonly callId: string
  readonly rootCallId?: string
  readonly tool: string
  readonly layer: 'backend_result'
  readonly outcome: {
    readonly kind: DenialClass
    /** The concrete signal the classification was derived from. */
    readonly basis: string
  }
  readonly backend: AuditBackendFacts
  readonly osObservation: AuditOsObservation
  readonly durationMs?: number
  readonly error?: AuditErrorFacts
}

export type AuditRecord = AuditBeginRecord | AuditEndRecord

/** Query filter accepted by the ledger and the human query command. */
export interface AuditQuery {
  readonly sessionId?: string
  readonly callId?: string
  readonly tool?: string
  readonly kind?: 'begin' | 'end'
  readonly outcomeKind?: DenialClass
  readonly since?: string
  readonly until?: string
  readonly limit?: number
  readonly offset?: number
}

/** User-facing query result: the page plus the total match count. */
export interface AuditQueryResult {
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly records: readonly AuditRecord[]
}
