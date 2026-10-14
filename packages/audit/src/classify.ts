/**
 * Denial classification (AUD-02, AUD-11, AUD-12). Structured signals win over
 * text; a stderr fragment alone never upgrades a record to an authoritative
 * backend denial — those records classify as `unknown` with the diagnostic
 * noted in the basis.
 * @module @hourglass/sandbox-audit
 */

import type { DenialClass } from './types.ts'

/**
 * Normalized view of the final tool result, produced by the plugin from the
 * real `ToolExecutionResult`. Keeping this interface small lets tests feed
 * synthetic results without constructing the full DSH type.
 */
export interface OutcomeSignals {
  readonly isError: boolean
  readonly errorCode?: string
  readonly errorMessage?: string
  /**
   * Structured sandbox facts when the consumer actually published them on the
   * result (bash-sandbox/pwsh-sandbox do; fs tools do not). Absent means the
   * layer is unavailable for this call — never guessed.
   */
  readonly sandbox?: {
    readonly denied?: boolean
    readonly runnerFailed?: boolean
    readonly enforcement?: 'full' | 'partial'
  }
}

/** Escalation rejection marker from dsh-sandbox's `approveEscalation` copy. */
const ESCALATION_REJECTION_MARKER = 'rejected escalating'

/**
 * Classify how a call ended. Evaluation order is deliberate:
 * 1. structured error codes (unavailable / aborted)
 * 2. consumer-published `result.sandbox` facts — a backend denial is a fact
 *    even when the tool wraps the non-zero exit as a successful result
 *    (that is the bash-sandbox contract: exit code rides in the value)
 * 3. success without denial facts → allowed
 * 4. the fs-fence policy error code
 * 5. the escalation approval marker
 * 6. otherwise an ordinary failure — a stderr fragment alone never upgrades
 */
export function classifyOutcome(signals: OutcomeSignals): { kind: DenialClass; basis: string } {
  const code = signals.errorCode
  if (code === 'SANDBOX_UNAVAILABLE') {
    return { kind: 'runner-failure', basis: 'error.info.code = SANDBOX_UNAVAILABLE' }
  }
  if (code === 'ABORTED' || code === 'ABORTED_BEFORE_DISPATCH') {
    return { kind: 'cancelled', basis: `error.info.code = ${code}` }
  }
  if (signals.sandbox?.runnerFailed === true) {
    return { kind: 'runner-failure', basis: 'result.sandbox.runnerFailed = true' }
  }
  if (signals.sandbox?.denied === true) {
    return { kind: 'sandbox-denial', basis: 'result.sandbox.denied = true' }
  }
  if (!signals.isError) return { kind: 'allowed', basis: 'result is success' }
  if (code === 'FS_SANDBOX_DENIED') {
    return { kind: 'policy-deny', basis: 'error.info.code = FS_SANDBOX_DENIED (fs fence)' }
  }
  if (signals.errorMessage?.includes(ESCALATION_REJECTION_MARKER) === true) {
    return { kind: 'approval-deny', basis: 'escalation rejection marker in error message' }
  }
  // No structured denial signal. A backend-dialect fragment in the message is
  // diagnostic only; it must not become an authoritative classification.
  return { kind: 'ordinary-failure', basis: 'error without structured denial signal' }
}

/**
 * Extract `OutcomeSignals.sandbox` from one candidate container (the tool's
 * canonical `value` — where bash-sandbox consumers stamp it — or `meta`).
 * Only a container that actually carries the consumer's `sandbox` shape
 * yields facts; everything else returns `undefined` (the layer is
 * unavailable).
 */
export function extractSandboxFacts(
  container: unknown,
): OutcomeSignals['sandbox'] | undefined {
  if (container === null || typeof container !== 'object') return undefined
  const candidate = (container as Record<string, unknown>)['sandbox']
  if (candidate === null || typeof candidate !== 'object') return undefined
  const facts = candidate as Record<string, unknown>
  const denied = typeof facts['denied'] === 'boolean' ? facts['denied'] : undefined
  const runnerFailed = typeof facts['runnerFailed'] === 'boolean' ? facts['runnerFailed'] : undefined
  const enforcement = facts['enforcement'] === 'full' || facts['enforcement'] === 'partial'
    ? facts['enforcement']
    : undefined
  if (denied === undefined && runnerFailed === undefined && enforcement === undefined) return undefined
  return { denied, runnerFailed, enforcement }
}
