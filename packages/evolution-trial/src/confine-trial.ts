/**
 * Default trial confinement profile (ADR-003 D4): values reuse ADR-002's
 * quota semantics — limits chosen so attack actions necessarily exceed them
 * while ordinary trial commands never hit them, with headroom below the
 * launcher watchdog. Trials are ALWAYS confined: there is no unrestricted
 * or danger mode on this path.
 */

export interface TrialRsrcBudget {
  readonly nproc?: number
  readonly asBytes?: number
  readonly cpuSeconds?: number
  readonly fsizeBytes?: number
  readonly nofile?: number
}

/** ADR-002 table values; any change requires an ADR-003 update. */
export const TRIAL_RSRC_DEFAULTS: Readonly<TrialRsrcBudget> = {
  nproc: 8,
  asBytes: 100 * 1024 * 1024,
  cpuSeconds: 10,
  fsizeBytes: 64 * 1024,
  nofile: 32,
}

export interface TrialConfinement {
  readonly net: { readonly mode: 'deny-all' } | { readonly mode: 'allowlist'; readonly allowlist: readonly string[] }
  readonly readDeny: readonly string[]
  readonly rsrc: Readonly<TrialRsrcBudget>
  readonly watchdogMs: number
}

export function buildTrialConfinement(overrides: Partial<TrialConfinement> = {}): TrialConfinement {
  return {
    net: overrides.net ?? { mode: 'deny-all' },
    readDeny: overrides.readDeny ?? [],
    rsrc: overrides.rsrc ?? TRIAL_RSRC_DEFAULTS,
    watchdogMs: overrides.watchdogMs ?? 90_000,
  }
}
