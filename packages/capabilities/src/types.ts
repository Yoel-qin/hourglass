/**
 * Capability-manifest vocabulary for @hourglass/sandbox-capabilities.
 *
 * A capability status is a *reported fact with evidence*, never an intention:
 * `enforced` requires a real enforcement mechanism plus a test that exercised
 * it; configuration desires and README claims are not evidence (AUD-13).
 * @module @hourglass/sandbox-capabilities
 */

/** Sandbox back-ends DSH ships today, plus the "no confinement" case. */
export type SandboxBackendId = 'bwrap' | 'landlock' | 'seatbelt' | 'windows-acl' | 'none'

/** The five split capabilities every manifest must report separately. */
export type CapabilityKey = 'fileRead' | 'fileWrite' | 'netEgress' | 'resourceLimits' | 'processControl'

export type CapabilityStatus = 'enforced' | 'partial' | 'absent' | 'unknown'

/**
 * What backs a status:
 * - `static-config` — read off the backend's actual launch configuration
 * - `probe` — a feature probe ran the backend for real
 * - `backend-report` — a per-call consumer report observed on results
 * - `test-result` — a sandbox-compare case exercised the boundary
 */
export type EvidenceKind = 'static-config' | 'probe' | 'backend-report' | 'test-result'

export interface CapabilityEntry {
  readonly status: CapabilityStatus
  readonly evidence: EvidenceKind
  /** Pointer to the source of truth: DSH source path or compare-report case id. */
  readonly evidenceRef: string
  readonly note: string
}

/** Live probe outcomes for back-ends on this host. */
export interface BackendProbeResult {
  readonly backend: SandboxBackendId
  readonly available: boolean
  readonly detail: string
  readonly checkedAt: string
}

export interface CapabilityManifest {
  readonly schema: 'hourglass-capabilities/1'
  readonly generatedAt: string
  readonly platform: NodeJS.Platform
  /** Back-end the manifest describes; `none` when no confinement applies. */
  readonly backend: SandboxBackendId
  readonly probes: readonly BackendProbeResult[]
  readonly capabilities: Readonly<Record<CapabilityKey, CapabilityEntry>>
}
