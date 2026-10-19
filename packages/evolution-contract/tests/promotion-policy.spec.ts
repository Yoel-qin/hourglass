import { describe, expect, it } from 'vitest'
import {
  buildValidationPack,
  canExportValidationPack,
  decisionDigest,
  verifyValidationPack,
} from '../src/index.ts'
import type { DecisionBindings } from '../src/index.ts'
import { countsOk } from './helpers.ts'

function baseBindings(overrides: Partial<DecisionBindings> = {}): DecisionBindings {
  return {
    candidateId: 'cand-0000000000000000000000000000000000000000',
    artifactSha256: 'c'.repeat(64),
    parentRevision: 'parent-abc123',
    trialId: 'trial-1',
    benchmarkManifestSha256: 'e'.repeat(64),
    versionsLockSha256: 'd'.repeat(64),
    evaluatorVersion: 'evaluator-1',
    policyHash: 'f'.repeat(64),
    capabilityManifestHash: '9'.repeat(64),
    ...overrides,
  }
}

function buildPack(bindings: DecisionBindings = baseBindings()) {
  return buildValidationPack({
    decision: 'pass',
    reasonCodes: ['strict-improvement-met'],
    bindings,
    executionCounts: countsOk(8),
    assetKind: 'dsh_skill',
    applySteps: ['compare target file hash against parentRevision before applying'],
    rollbackSteps: ['restore the exact parent content recorded in the pack'],
  })
}

describe('canExportValidationPack (EVO-PROMOTE contract semantics)', () => {
  it('allows export only for a full pass with complete bindings', () => {
    expect(canExportValidationPack({ decision: 'pass', bindings: baseBindings() })).toEqual({ allowed: true, reasons: [] })
  })

  it('refuses non-pass decisions (EVO-PROMOTE-02)', () => {
    for (const decision of ['reject', 'inconclusive', 'blocked'] as const) {
      const result = canExportValidationPack({ decision, bindings: baseBindings() })
      expect(result.allowed).toBe(false)
      expect(result.reasons).toContain(`decision-not-pass:${decision}`)
    }
  })

  it('refuses missing or malformed bindings (EVO-PROMOTE-02/08)', () => {
    const missing = canExportValidationPack({ decision: 'pass', bindings: { ...baseBindings(), trialId: undefined } })
    expect(missing.reasons).toContain('missing-binding:trialId')
    const malformed = canExportValidationPack({ decision: 'pass', bindings: baseBindings({ artifactSha256: 'beef' }) })
    expect(malformed.reasons).toContain('malformed-hash:artifactSha256')
  })
})

describe('decision digest binding', () => {
  it('changes whenever any bound identity changes', () => {
    const base = decisionDigest(baseBindings())
    expect(decisionDigest(baseBindings({ artifactSha256: '0'.repeat(64) }))).not.toBe(base)
    expect(decisionDigest(baseBindings({ parentRevision: 'parent-other' }))).not.toBe(base)
    expect(decisionDigest(baseBindings({ policyHash: '1'.repeat(64) }))).not.toBe(base)
    expect(decisionDigest(baseBindings({ versionsLockSha256: '2'.repeat(64) }))).not.toBe(base)
  })

  it('is canonical: binding key order does not matter', () => {
    const bindings = baseBindings()
    const reordered = JSON.parse(JSON.stringify({
      policyHash: bindings.policyHash,
      capabilityManifestHash: bindings.capabilityManifestHash,
      evaluatorVersion: bindings.evaluatorVersion,
      versionsLockSha256: bindings.versionsLockSha256,
      benchmarkManifestSha256: bindings.benchmarkManifestSha256,
      trialId: bindings.trialId,
      parentRevision: bindings.parentRevision,
      artifactSha256: bindings.artifactSha256,
      candidateId: bindings.candidateId,
    })) as DecisionBindings
    expect(decisionDigest(bindings)).toBe(decisionDigest(reordered))
  })
})

describe('validation pack integrity (EVO-PROMOTE-01/08)', () => {
  it('builds a pack whose verification fails until approval is recorded', () => {
    const pack = buildPack()
    expect(pack.approval).toBeNull()
    const before = verifyValidationPack(pack)
    expect(before.ok).toBe(false)
    expect(before.reasons).toContain('awaiting-human-approval')

    const approved = { ...pack, approval: { approvedBy: 'reviewer', approvedAt: '2026-10-19T00:00:00.000Z', scope: 'manual-apply' } }
    expect(verifyValidationPack(approved).ok).toBe(true)
  })

  it('detects binding tampering after export (EVO-PROMOTE-08)', () => {
    const pack = buildPack()
    const approved = { ...pack, approval: { approvedBy: 'reviewer', approvedAt: '2026-10-19T00:00:00.000Z', scope: 'manual-apply' } }
    const tampered = {
      ...approved,
      bindings: { ...approved.bindings, artifactSha256: '0'.repeat(64) },
    }
    const result = verifyValidationPack(tampered)
    expect(result.ok).toBe(false)
    expect(result.reasons).toContain('decision-digest-mismatch')
  })

  it('refuses to build a pack from a non-pass decision', () => {
    expect(() => buildPack(baseBindings({ trialId: undefined }))).toThrow(/cannot export validation pack/)
  })
})
