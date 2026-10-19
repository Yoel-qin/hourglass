import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { exportValidationPack, loadPack, packPathFor, verifyValidationPack } from '../src/validation-pack.ts'
import { sha256Hex } from '@hourglass/evolution-contract/src/index.ts'
import type { DecisionBindings } from '@hourglass/evolution-contract/src/index.ts'

const root = mkdtempSync(join(tmpdir(), 'evo-pack-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function bindings(overrides: Partial<DecisionBindings> = {}): DecisionBindings {
  return {
    candidateId: 'cand-00000000000000000000000000000000',
    artifactSha256: 'c'.repeat(64),
    parentRevision: 'parent-abc123',
    trialId: 'trial-1',
    benchmarkManifestSha256: 'e'.repeat(64),
    versionsLockSha256: 'd'.repeat(64),
    evaluatorVersion: 'evaluator-1',
    policyHash: sha256Hex('mvp-a-policy'),
    capabilityManifestHash: '9'.repeat(64),
    ...overrides,
  }
}

function exportInput(overrides: Record<string, unknown> = {}) {
  return {
    decision: 'pass',
    reasonCodes: ['strict-improvement-met'],
    bindings: bindings(),
    executionCounts: { expected: 8, executed: 8, skipped: 0, blocked: 0 },
    assetKind: 'dsh_skill',
    applySteps: ['verify parent hash before applying'],
    rollbackSteps: ['restore the exact parent content'],
    outDir: root,
    ...overrides,
  }
}

describe('validation-pack export (EVO-PROMOTE-01)', () => {
  it('exports a pack only from a full pass', () => {
    const { pack, packPath } = exportValidationPack(exportInput())
    expect(pack.decision).toBe('pass')
    expect(pack.approval).toBeNull()
    expect(existsSync(packPath)).toBe(true)
    expect(packPath).toBe(packPathFor(root, pack.bindings.decisionDigest))
    expect(() => exportValidationPack(exportInput({ decision: 'reject' }))).toThrow(/cannot export validation pack/)
  })

  it('re-export of the same decision is idempotent and byte-identical', () => {
    const first = exportValidationPack(exportInput())
    const second = exportValidationPack(exportInput())
    expect(second.packPath).toBe(first.packPath)
    expect(JSON.stringify(second.pack)).toBe(JSON.stringify(first.pack))
  })

  it('verification fails until human approval is recorded, then passes', () => {
    const { packPath } = exportValidationPack(exportInput({ bindings: bindings({ trialId: 'trial-approve' }) }))
    const pack = loadPack(packPath)
    expect(verifyValidationPack(pack).reasons).toContain('awaiting-human-approval')
    const approved = { ...pack, approval: { approvedBy: 'reviewer', approvedAt: '2026-10-19T00:00:00.000Z', scope: 'manual-apply' } }
    expect(verifyValidationPack(approved).ok).toBe(true)
  })

  it('different bindings produce different pack files (no silent reuse)', () => {
    const a = exportValidationPack(exportInput({ bindings: bindings({ trialId: 'trial-a' }) }))
    const b = exportValidationPack(exportInput({ bindings: bindings({ trialId: 'trial-b' }) }))
    expect(a.packPath).not.toBe(b.packPath)
  })
})
