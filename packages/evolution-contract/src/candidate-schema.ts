/**
 * Candidate manifest validation (EVO-CAND semantics at the contract layer).
 *
 * Validation is a pure function: unknown fields, unsupported asset kinds,
 * capability escalations and malformed hashes are rejected with stable
 * machine-readable reason codes — the trial pipeline never gets to interpret
 * a candidate that failed these checks. Validation is explicit field-by-field
 * checking (no schema library): the package stays dependency-free and every
 * rejection reason is under our control. The schemastery Config surface is
 * used later at the plugin boundary (@hourglass/evolution-trial), matching
 * how policy-ci is a pure lib while audit owns the plugin Config.
 */

import { isSha256 } from './hashes.ts'
import type { AssetKind, CandidateManifest, Decision, MutationKind, RiskTier } from './types.ts'

export const CANDIDATE_SCHEMA_VERSION = 'hourglass-evolution-candidate/1'

export const ASSET_KINDS: readonly AssetKind[] = ['dsh_skill', 'prompt_fragment']

export const MUTATION_KINDS: readonly MutationKind[] = ['create', 'update']

/**
 * The only capabilities an MVP candidate may request. Anything else is an
 * escalation: a `SKILL.md` asking for network or install rights must be
 * refused here, not re-labeled (EVO-CAND-05).
 */
export const MVP_REQUESTABLE_CAPABILITIES: readonly string[] = [
  'task-input-read',
  'trial-workspace-write',
  'result-channel-write',
]

const REQUIRED_KEYS: readonly string[] = [
  'schemaVersion',
  'candidateId',
  'proposalId',
  'parentRevision',
  'assetKind',
  'mutationKind',
  'scope',
  'payloadSha256',
  'artifactSha256',
  'versionsLockSha256',
  'requestedCapabilities',
  'riskTier',
  'createdBy',
  'createdAt',
  'sourceNote',
  'benchmarkId',
  'benchmarkVersion',
  'benchmarkManifestSha256',
  'environmentFingerprint',
]

const OPTIONAL_KEYS: readonly string[] = ['trialId', 'decision', 'decisionReasonCodes', 'promotionState']

const SHA_FIELDS: readonly string[] = ['payloadSha256', 'artifactSha256', 'versionsLockSha256', 'benchmarkManifestSha256']

const DECISIONS: readonly Decision[] = ['pass', 'reject', 'inconclusive', 'blocked']

export interface ValidationResult {
  readonly ok: boolean
  readonly errors: readonly string[]
  readonly value?: CandidateManifest
}

export function validateCandidateManifest(raw: unknown): ValidationResult {
  const errors: string[] = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['not-an-object'] }
  }
  const record = raw as Record<string, unknown>

  for (const key of Object.keys(record)) {
    if (!REQUIRED_KEYS.includes(key) && !OPTIONAL_KEYS.includes(key)) {
      errors.push(`unexpected-field:${key}`)
    }
  }
  for (const key of REQUIRED_KEYS) {
    if (record[key] === undefined) {
      errors.push(`missing-field:${key}`)
    }
  }
  if (errors.length > 0) {
    // Shape is wrong: do not run semantic checks against half-parsed data.
    return { ok: false, errors }
  }

  if (record.schemaVersion !== CANDIDATE_SCHEMA_VERSION) {
    errors.push('schema-version-mismatch')
  }
  if (record.assetKind !== undefined && !ASSET_KINDS.includes(record.assetKind as AssetKind)) {
    errors.push('unsupported-asset-kind')
  }
  if (record.mutationKind !== undefined && !MUTATION_KINDS.includes(record.mutationKind as MutationKind)) {
    errors.push('unsupported-mutation-kind')
  }
  if (record.scope !== 'isolated-store') {
    errors.push('scope-not-supported')
  }
  // E2/E3 tiers can never enter the MVP flow, however they are labeled.
  if (record.riskTier !== 'E0') {
    errors.push('risk-tier-not-in-mvp-scope')
  }
  for (const field of SHA_FIELDS) {
    if (record[field] !== undefined && !isSha256(record[field])) {
      errors.push(`malformed-hash:${field}`)
    }
  }
  for (const field of ['candidateId', 'proposalId', 'parentRevision', 'createdBy', 'sourceNote', 'benchmarkId', 'environmentFingerprint'] as const) {
    if (!isNonEmptyString(record[field])) {
      errors.push(`malformed-field:${field}`)
    }
  }
  if (typeof record.benchmarkVersion !== 'number' || !Number.isInteger(record.benchmarkVersion) || record.benchmarkVersion < 1) {
    errors.push('malformed-field:benchmarkVersion')
  }
  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) {
    errors.push('malformed-field:createdAt')
  }
  if (!Array.isArray(record.requestedCapabilities)) {
    errors.push('malformed-field:requestedCapabilities')
  } else {
    for (const capability of record.requestedCapabilities) {
      if (typeof capability !== 'string') {
        errors.push('malformed-field:requestedCapabilities')
        break
      }
      if (!MVP_REQUESTABLE_CAPABILITIES.includes(capability)) {
        errors.push(`capability-escalation:${capability}`)
      }
    }
  }
  if (record.decision !== undefined && !DECISIONS.includes(record.decision as Decision)) {
    errors.push('invalid-decision')
  }
  if (record.decisionReasonCodes !== undefined
    && (!Array.isArray(record.decisionReasonCodes) || record.decisionReasonCodes.some(code => typeof code !== 'string'))) {
    errors.push('malformed-field:decisionReasonCodes')
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }
  return { ok: true, errors: [], value: record as unknown as CandidateManifest }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}
