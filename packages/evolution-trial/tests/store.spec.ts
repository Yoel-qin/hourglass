import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CandidateStore } from '../src/candidate-store.ts'
import type { SealRequest } from '../src/candidate-store.ts'

const root = mkdtempSync(join(tmpdir(), 'evo-store-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function sealRequest(payload: string, overrides: Partial<SealRequest> = {}): SealRequest {
  return {
    assetKind: 'dsh_skill',
    mutationKind: 'update',
    parentRevision: 'parent-abc123',
    payload,
    createdBy: 'synthetic-proposer',
    sourceNote: 'synthetic skill mutation',
    benchmarkId: 'evo-bench-mvp-a',
    benchmarkVersion: 1,
    benchmarkManifestSha256: 'e'.repeat(64),
    environmentFingerprint: 'dsh=d743267;lane=bwrap-container',
    versionsLockSha256: 'a'.repeat(64),
    ...overrides,
  }
}

describe('CandidateStore (EVO-CAND contract semantics)', () => {
  it('seals a candidate immutably and verifies its artifact', async () => {
    const store = new CandidateStore(join(root, 'a'))
    const manifest = await store.seal(sealRequest('# skill v2\n'))
    expect(manifest.candidateId).toMatch(/^cand-[0-9a-f]{32}$/u)
    expect(manifest.payloadSha256).toBe(manifest.artifactSha256)
    expect(store.verifyArtifact(manifest.candidateId).ok).toBe(true)
    expect(store.readArtifact(manifest.payloadSha256)).toBe('# skill v2\n')
  })

  it('deduplicates identical content fingerprints (EVO-CAND-04)', async () => {
    const store = new CandidateStore(join(root, 'b'))
    const first = await store.seal(sealRequest('same payload'))
    const second = await store.seal(sealRequest('same payload'))
    expect(second.candidateId).toBe(first.candidateId)
    expect(store.manifestPath(first.candidateId)).toBe(store.manifestPath(second.candidateId))
  })

  it('different payload or parent produces a different candidate', async () => {
    const store = new CandidateStore(join(root, 'c'))
    const base = await store.seal(sealRequest('payload-x'))
    const otherPayload = await store.seal(sealRequest('payload-y'))
    const otherParent = await store.seal(sealRequest('payload-x', { parentRevision: 'parent-def456' }))
    expect(otherPayload.candidateId).not.toBe(base.candidateId)
    expect(otherParent.candidateId).not.toBe(base.candidateId)
  })

  it('detects artifact tampering after seal (EVO-CAND-02/08)', async () => {
    const store = new CandidateStore(join(root, 'd'))
    const manifest = await store.seal(sealRequest('original content'))
    const artifactPath = store.artifactPath(manifest.payloadSha256)
    writeFileSync(artifactPath, 'tampered content', 'utf8')
    const verification = store.verifyArtifact(manifest.candidateId)
    expect(verification.ok).toBe(false)
    expect(verification.reason).toMatch(/^artifact-hash-mismatch:/)
  })

  it('refuses unknown candidates and non-E0 assets', async () => {
    const store = new CandidateStore(join(root, 'e'))
    expect(() => store.load('cand-doesnotexist')).toThrow(/unknown-candidate/)
    await expect(store.seal(sealRequest('x', { assetKind: 'host_plugin' as never }))).rejects.toThrow(/seal refused:.*unsupported-asset-kind/u)
  })

  it('stores manifests that round-trip through the contract validator', async () => {
    const store = new CandidateStore(join(root, 'f'))
    const manifest = await store.seal(sealRequest('round trip'))
    const raw: unknown = JSON.parse(readFileSync(store.manifestPath(manifest.candidateId), 'utf8'))
    expect(raw).toEqual(manifest)
  })
})
