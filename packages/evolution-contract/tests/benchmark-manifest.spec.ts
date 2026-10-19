import { describe, expect, it } from 'vitest'
import {
  computeManifestSha256,
  validateBenchmarkManifest,
  verifyManifestSha256,
} from '../src/index.ts'
import type { BenchmarkManifest } from '../src/index.ts'
import { baseBenchmark } from './helpers.ts'

function asManifest(raw: Record<string, unknown>): BenchmarkManifest {
  return raw as unknown as BenchmarkManifest
}

describe('benchmark manifest validation (v3.1 §4.2)', () => {
  it('accepts a valid manifest', () => {
    const result = validateBenchmarkManifest(baseBenchmark())
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('rejects a case declared both public and hidden', () => {
    const result = validateBenchmarkManifest(baseBenchmark({ publicCaseIds: ['F-PUB-01', 'F-HID-01'] }))
    expect(result.errors).toContain('case-both-public-and-hidden:F-HID-01')
  })

  it('rejects undeclared or unclassified cases', () => {
    expect(validateBenchmarkManifest(baseBenchmark({ caseIds: ['F-PUB-01', 'F-HID-01', 'S-SEC-01', 'F-ORPHAN'] })).errors)
      .toContain('missing-input-hash:F-ORPHAN')
    const noClass = baseBenchmark({ securityCaseIds: [] })
    expect(validateBenchmarkManifest(noClass).errors).toContain('unclassified-case:S-SEC-01')
  })

  it('rejects orphan input hashes and malformed values', () => {
    const manifest = baseBenchmark() as Record<string, unknown>
    const hashes = manifest.inputSha256 as Record<string, string>
    hashes['F-GHOST'] = '4'.repeat(64)
    expect(validateBenchmarkManifest(manifest).errors).toContain('orphan-input-hash:F-GHOST')
    expect(validateBenchmarkManifest(baseBenchmark({ version: 0 })).errors).toContain('malformed-field:version')
    expect(validateBenchmarkManifest('nope').errors).toEqual(['not-an-object'])
  })
})

describe('manifest hash locking', () => {
  it('hashes canonical JSON: key insertion order cannot change the digest', () => {
    const first = asManifest(baseBenchmark())
    const reordered = JSON.parse(JSON.stringify({
      lockedAt: first.lockedAt,
      dshCommit: first.dshCommit,
      scorerVersion: first.scorerVersion,
      assertionVersion: first.assertionVersion,
      inputSha256: first.inputSha256,
      securityCaseIds: first.securityCaseIds,
      hiddenCaseIds: first.hiddenCaseIds,
      publicCaseIds: first.publicCaseIds,
      caseIds: first.caseIds,
      version: first.version,
      benchmarkId: first.benchmarkId,
      schemaVersion: first.schemaVersion,
    })) as BenchmarkManifest
    expect(computeManifestSha256(first)).toBe(computeManifestSha256(reordered))
  })

  it('any content change breaks verification (EVO-BENCH-06/12)', () => {
    const manifest = asManifest(baseBenchmark())
    const sha = computeManifestSha256(manifest)
    expect(verifyManifestSha256(manifest, sha).ok).toBe(true)
    const tampered = asManifest(baseBenchmark({ assertionVersion: 'assert-v2' }))
    const result = verifyManifestSha256(tampered, sha)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/^manifest-hash-mismatch:/)
  })
})
