/**
 * Subject adapter contract. An adapter translates the unified profile/action
 * semantics into its subject's configuration, runs the action, and returns
 * raw execution facts. Verdicts are computed by the runner from outside-world
 * evidence, never from the subject's own output alone.
 */

import type { CompareCase, CaseResult, SubjectId } from '../schema.ts'
import type { CaseContext } from '../cases.ts'
import type { NetService } from '../net-service.ts'

export interface RunEnv {
  readonly runId: string
  readonly net: NetService
  readonly context: CaseContext
  readonly env: NodeJS.ProcessEnv
}

export interface RawExecution {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  /** Adapter-level notes that belong in the evidence trail. */
  readonly notes: readonly string[]
}

export interface SubjectAdapter {
  readonly id: SubjectId
  /** Probe whether the subject is runnable here; failures must carry a reason. */
  available(): Promise<{ ok: boolean; reason?: string }>
  /** Execute one case's action under the mapped profile. */
  execute(caseDefinition: CompareCase, env: RunEnv): Promise<RawExecution>
  /** Optional adapter-specific verdict input (e.g. audit ledger contents). */
  readonly supportsAudit?: boolean
}

export type { CaseResult }
