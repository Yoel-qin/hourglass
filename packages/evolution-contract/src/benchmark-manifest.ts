/**
 * Frozen benchmark manifest (v3.1 plan §4.2): versioned, hash-locked, with
 * the public/hidden/security split. The manifest hash covers the canonical
 * JSON, so any edit to cases, hashes or scorer versions is detectable and
 * requires a new benchmark version rather than an in-place rewrite.
 */

import { canonicalJson, isSha256, sha256Hex } from './hashes.ts'

export const BENCHMARK_SCHEMA_VERSION = 'hourglass-evolution-benchmark/1'

export interface BenchmarkManifest {
  readonly schemaVersion: 'hourglass-evolution-benchmark/1'
  readonly benchmarkId: string
  readonly version: number
  readonly caseIds: readonly string[]
  readonly publicCaseIds: readonly string[]
  readonly hiddenCaseIds: readonly string[]
  readonly securityCaseIds: readonly string[]
  readonly inputSha256: Readonly<Record<string, string>>
  readonly assertionVersion: string
  readonly scorerVersion: string
  readonly dshCommit: string
  readonly lockedAt: string
}

export interface ManifestValidationResult {
  readonly ok: boolean
  readonly errors: readonly string[]
}

export function validateBenchmarkManifest(raw: unknown): ManifestValidationResult {
  const errors: string[] = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['not-an-object'] }
  }
  const record = raw as Record<string, unknown>
  if (record.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    errors.push('schema-version-mismatch')
  }
  for (const field of ['benchmarkId', 'assertionVersion', 'scorerVersion', 'dshCommit', 'lockedAt'] as const) {
    if (typeof record[field] !== 'string' || (record[field] as string).trim() === '') {
      errors.push(`malformed-field:${field}`)
    }
  }
  if (typeof record.version !== 'number' || !Number.isInteger(record.version) || record.version < 1) {
    errors.push('malformed-field:version')
  }
  for (const field of ['caseIds', 'publicCaseIds', 'hiddenCaseIds', 'securityCaseIds'] as const) {
    if (!Array.isArray(record[field]) || (record[field] as unknown[]).some(item => typeof item !== 'string')) {
      errors.push(`malformed-field:${field}`)
    }
  }
  if (record.inputSha256 === null || typeof record.inputSha256 !== 'object' || Array.isArray(record.inputSha256)) {
    errors.push('malformed-field:inputSha256')
  } else {
    for (const [caseId, hash] of Object.entries(record.inputSha256 as Record<string, unknown>)) {
      if (!isSha256(hash)) {
        errors.push(`malformed-input-hash:${caseId}`)
      }
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors }
  }

  const caseIds = record.caseIds as string[]
  const publicIds = record.publicCaseIds as string[]
  const hiddenIds = record.hiddenCaseIds as string[]
  const securityIds = record.securityCaseIds as string[]
  const idSet = new Set(caseIds)
  if (idSet.size !== caseIds.length) {
    errors.push('duplicate-case-id')
  }
  for (const id of publicIds) {
    if (!idSet.has(id)) errors.push(`public-case-not-declared:${id}`)
  }
  for (const id of hiddenIds) {
    if (!idSet.has(id)) errors.push(`hidden-case-not-declared:${id}`)
    if (publicIds.includes(id)) errors.push(`case-both-public-and-hidden:${id}`)
  }
  for (const id of securityIds) {
    if (!idSet.has(id)) errors.push(`security-case-not-declared:${id}`)
  }
  // Every declared case must carry an input hash and be classified.
  const hashKeys = new Set(Object.keys(record.inputSha256 as Record<string, unknown>))
  for (const id of caseIds) {
    if (!hashKeys.has(id)) errors.push(`missing-input-hash:${id}`)
    if (!publicIds.includes(id) && !hiddenIds.includes(id) && !securityIds.includes(id)) {
      errors.push(`unclassified-case:${id}`)
    }
  }
  for (const key of hashKeys) {
    if (!idSet.has(key)) errors.push(`orphan-input-hash:${key}`)
  }
  return { ok: errors.length === 0, errors }
}

export function computeManifestSha256(manifest: BenchmarkManifest): string {
  return sha256Hex(canonicalJson(manifest))
}

export interface ManifestHashResult {
  readonly ok: boolean
  readonly reason?: string
}

export function verifyManifestSha256(manifest: BenchmarkManifest, expectedSha256: string): ManifestHashResult {
  const actual = computeManifestSha256(manifest)
  if (actual === expectedSha256) {
    return { ok: true }
  }
  return { ok: false, reason: `manifest-hash-mismatch:expected=${expectedSha256},actual=${actual}` }
}
