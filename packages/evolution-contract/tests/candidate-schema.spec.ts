import { describe, expect, it } from 'vitest'
import { validateCandidateManifest } from '../src/index.ts'
import { baseManifest } from './helpers.ts'

describe('validateCandidateManifest (EVO-CAND contract semantics)', () => {
  it('accepts a fully valid MVP candidate', () => {
    const result = validateCandidateManifest(baseManifest())
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.value?.assetKind).toBe('dsh_skill')
  })

  it('accepts a prompt_fragment candidate', () => {
    const result = validateCandidateManifest(baseManifest({ assetKind: 'prompt_fragment' }))
    expect(result.ok).toBe(true)
  })

  it('rejects a non-object candidate', () => {
    expect(validateCandidateManifest('not an object').errors).toEqual(['not-an-object'])
    expect(validateCandidateManifest(null).errors).toEqual(['not-an-object'])
  })

  it('rejects unknown extra fields (EVO-CAND-01)', () => {
    const result = validateCandidateManifest(baseManifest({ extra: 'surprise' }))
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('unexpected-field:extra')
  })

  it('rejects an unsupported asset kind (EVO-CAND-01/05)', () => {
    const result = validateCandidateManifest(baseManifest({ assetKind: 'host_plugin' }))
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('unsupported-asset-kind')
  })

  it('rejects non-E0 risk tiers regardless of labeling (EVO-CAND-05)', () => {
    const result = validateCandidateManifest(baseManifest({ riskTier: 'E2' }))
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('risk-tier-not-in-mvp-scope')
  })

  it('rejects capability escalation requests (EVO-CAND-05)', () => {
    const result = validateCandidateManifest(baseManifest({
      requestedCapabilities: ['task-input-read', 'network-egress', 'plugin-install'],
    }))
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('capability-escalation:network-egress')
    expect(result.errors).toContain('capability-escalation:plugin-install')
  })

  it('rejects malformed hashes with a field-qualified code (EVO-CAND-01)', () => {
    const result = validateCandidateManifest(baseManifest({ payloadSha256: 'deadbeef' }))
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('malformed-hash:payloadSha256')
  })

  it('rejects a wrong schema version', () => {
    const result = validateCandidateManifest(baseManifest({ schemaVersion: 'hourglass-evolution-candidate/0' }))
    expect(result.errors).toContain('schema-version-mismatch')
  })

  it('rejects scopes beyond the isolated store', () => {
    const result = validateCandidateManifest(baseManifest({ scope: 'production-profile' }))
    expect(result.errors).toContain('scope-not-supported')
  })

  it('rejects unsupported mutation kinds and invalid decisions', () => {
    expect(validateCandidateManifest(baseManifest({ mutationKind: 'delete' })).errors).toContain('unsupported-mutation-kind')
    expect(validateCandidateManifest(baseManifest({ decision: 'maybe' })).errors).toContain('invalid-decision')
  })

  it('short-circuits on missing required fields without semantic checks', () => {
    const partial = baseManifest() as Record<string, unknown>
    delete partial.createdBy
    const result = validateCandidateManifest(partial)
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('missing-field:createdBy')
  })

  it('rejects a bad benchmarkVersion and unparseable createdAt', () => {
    expect(validateCandidateManifest(baseManifest({ benchmarkVersion: 0 })).errors).toContain('malformed-field:benchmarkVersion')
    expect(validateCandidateManifest(baseManifest({ createdAt: 'yesterday' })).errors).toContain('malformed-field:createdAt')
  })

  it('rejects blank required string fields (malformed-field)', () => {
    const result = validateCandidateManifest(baseManifest({ createdBy: '   ' }))
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('malformed-field:createdBy')
  })

  it('rejects a non-array requestedCapabilities', () => {
    const result = validateCandidateManifest(baseManifest({ requestedCapabilities: 'task-input-read' }))
    expect(result.errors).toContain('malformed-field:requestedCapabilities')
  })

  it('rejects non-string capability entries', () => {
    const result = validateCandidateManifest(baseManifest({ requestedCapabilities: [123 as never] }))
    expect(result.errors).toContain('malformed-field:requestedCapabilities')
    expect(result.errors).not.toContain('capability-escalation:123')
  })

  it('rejects malformed decisionReasonCodes', () => {
    expect(validateCandidateManifest(baseManifest({ decisionReasonCodes: 'x' })).errors).toContain('malformed-field:decisionReasonCodes')
    expect(validateCandidateManifest(baseManifest({ decisionReasonCodes: [1 as never] })).errors).toContain('malformed-field:decisionReasonCodes')
  })
})
