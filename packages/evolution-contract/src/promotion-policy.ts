/**
 * Promotion policy (v3.1 plan §6): the only production path is exporting a
 * hash-bound validation pack for human approval and manual application.
 * A pack may be exported exclusively from a full `pass` whose decision
 * digest binds candidate, parent, benchmark, policy, capability and
 * versions-lock identities; any later drift must break verification.
 */

import { canonicalJson, isSha256, sha256Hex } from './hashes.ts'
import type { AssetKind, Decision, ExecutionCounts } from './types.ts'

export interface DecisionBindings {
  readonly candidateId: string
  readonly artifactSha256: string
  readonly parentRevision: string
  readonly trialId: string
  readonly benchmarkManifestSha256: string
  readonly versionsLockSha256: string
  readonly evaluatorVersion: string
  readonly policyHash: string
  readonly capabilityManifestHash: string
}

const BINDING_SHA_FIELDS: readonly (keyof DecisionBindings)[] = [
  'artifactSha256',
  'benchmarkManifestSha256',
  'versionsLockSha256',
  'policyHash',
  'capabilityManifestHash',
]

const BINDING_REQUIRED_FIELDS: readonly (keyof DecisionBindings)[] = [
  'candidateId',
  'artifactSha256',
  'parentRevision',
  'trialId',
  'benchmarkManifestSha256',
  'versionsLockSha256',
  'evaluatorVersion',
  'policyHash',
  'capabilityManifestHash',
]

/** The digest binds the decision to every identity it was judged against. */
export function decisionDigest(bindings: DecisionBindings): string {
  return sha256Hex(canonicalJson(bindings))
}

export interface ExportCheckInput {
  readonly decision: Decision
  readonly bindings: Partial<DecisionBindings>
}

export interface ExportCheckResult {
  readonly allowed: boolean
  readonly reasons: readonly string[]
}

export function canExportValidationPack(input: ExportCheckInput): ExportCheckResult {
  const reasons: string[] = []
  if (input.decision !== 'pass') {
    reasons.push(`decision-not-pass:${input.decision}`)
  }
  for (const field of BINDING_REQUIRED_FIELDS) {
    const value = input.bindings[field]
    if (value === undefined || value === '') {
      reasons.push(`missing-binding:${field}`)
    }
  }
  for (const field of BINDING_SHA_FIELDS) {
    const value = input.bindings[field]
    if (value !== undefined && value !== '' && !isSha256(value)) {
      reasons.push(`malformed-hash:${field}`)
    }
  }
  return { allowed: reasons.length === 0, reasons }
}

export interface ValidationPack {
  readonly schemaVersion: 'hourglass-evolution-pack/1'
  readonly bindings: DecisionBindings & { readonly decisionDigest: string }
  readonly decision: Decision
  readonly reasonCodes: readonly string[]
  readonly executionCounts: ExecutionCounts
  /** Filled only by the human approval step; null at export time. */
  readonly approval: { readonly approvedBy: string; readonly approvedAt: string; readonly scope: string } | null
  readonly apply: {
    readonly assetKind: AssetKind
    readonly parentRevision: string
    readonly artifactSha256: string
    readonly steps: readonly string[]
  }
  readonly rollback: {
    readonly parentRevision: string
    readonly steps: readonly string[]
  }
}

export interface BuildPackInput {
  readonly decision: Decision
  readonly reasonCodes: readonly string[]
  readonly bindings: DecisionBindings
  readonly executionCounts: ExecutionCounts
  readonly assetKind: AssetKind
  readonly applySteps: readonly string[]
  readonly rollbackSteps: readonly string[]
}

export function buildValidationPack(input: BuildPackInput): ValidationPack {
  const check = canExportValidationPack({ decision: input.decision, bindings: input.bindings })
  if (!check.allowed) {
    throw new Error(`cannot export validation pack: ${check.reasons.join(', ')}`)
  }
  return {
    schemaVersion: 'hourglass-evolution-pack/1',
    bindings: { ...input.bindings, decisionDigest: decisionDigest(input.bindings) },
    decision: input.decision,
    reasonCodes: [...input.reasonCodes],
    executionCounts: input.executionCounts,
    approval: null,
    apply: {
      assetKind: input.assetKind,
      parentRevision: input.bindings.parentRevision,
      artifactSha256: input.bindings.artifactSha256,
      steps: [...input.applySteps],
    },
    rollback: {
      parentRevision: input.bindings.parentRevision,
      steps: [...input.rollbackSteps],
    },
  }
}

export interface PackVerifyResult {
  readonly ok: boolean
  readonly reasons: readonly string[]
}

/** Recompute the digest over the pack's bindings; any drift fails. */
export function verifyValidationPack(pack: ValidationPack): PackVerifyResult {
  const reasons: string[] = []
  const { decisionDigest: _recorded, ...bindings } = pack.bindings
  if (decisionDigest(bindings as DecisionBindings) !== _recorded) {
    reasons.push('decision-digest-mismatch')
  }
  if (pack.decision !== 'pass') {
    reasons.push(`decision-not-pass:${pack.decision}`)
  }
  if (pack.approval === null) {
    reasons.push('awaiting-human-approval')
  }
  return { ok: reasons.length === 0, reasons }
}
