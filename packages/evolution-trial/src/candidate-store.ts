/**
 * Immutable content-addressed candidate store (v3.1 §3.1/§3.3).
 *
 * Artifacts are sealed under their SHA-256 and written with the no-overwrite
 * flag: a sealed candidate can never be rewritten, only deduplicated. The
 * trial side reads snapshots; it is never handed a writable path into the
 * store. Manifests are validated with @hourglass/evolution-contract before
 * they are accepted, so nothing enters the store that the schema refused.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson, sha256Hex, validateCandidateManifest } from '@hourglass/evolution-contract/src/index.ts'
import type { CandidateManifest } from '@hourglass/evolution-contract/src/index.ts'

export interface SealRequest {
  readonly assetKind: 'dsh_skill' | 'prompt_fragment'
  readonly mutationKind: 'create' | 'update'
  readonly parentRevision: string
  readonly payload: string
  readonly createdBy: string
  readonly sourceNote: string
  readonly benchmarkId: string
  readonly benchmarkVersion: number
  readonly benchmarkManifestSha256: string
  readonly environmentFingerprint: string
  readonly versionsLockSha256: string
}

export class CandidateStore {
  private readonly artifactsDir: string
  private readonly manifestsDir: string

  constructor(rootDir: string) {
    this.artifactsDir = join(rootDir, 'artifacts')
    this.manifestsDir = join(rootDir, 'manifests')
    mkdirSync(this.artifactsDir, { recursive: true })
    mkdirSync(this.manifestsDir, { recursive: true })
  }

  async seal(request: SealRequest): Promise<CandidateManifest> {
    const payloadSha256 = sha256Hex(request.payload)
    const candidateId = `cand-${sha256Hex(canonicalJson({
      parentRevision: request.parentRevision,
      assetKind: request.assetKind,
      mutationKind: request.mutationKind,
      payloadSha256,
    })).slice(0, 32)}`
    const manifest: CandidateManifest = {
      schemaVersion: 'hourglass-evolution-candidate/1',
      candidateId,
      proposalId: `${candidateId}-proposal`,
      parentRevision: request.parentRevision,
      assetKind: request.assetKind,
      mutationKind: request.mutationKind,
      scope: 'isolated-store',
      payloadSha256,
      artifactSha256: payloadSha256,
      versionsLockSha256: request.versionsLockSha256,
      requestedCapabilities: ['task-input-read', 'trial-workspace-write', 'result-channel-write'],
      riskTier: 'E0',
      createdBy: request.createdBy,
      createdAt: new Date().toISOString(),
      sourceNote: request.sourceNote,
      benchmarkId: request.benchmarkId,
      benchmarkVersion: request.benchmarkVersion,
      benchmarkManifestSha256: request.benchmarkManifestSha256,
      environmentFingerprint: request.environmentFingerprint,
    }
    const validation = validateCandidateManifest(manifest)
    if (!validation.ok) {
      throw new Error(`seal refused: ${validation.errors.join(', ')}`)
    }
    const artifactPath = this.artifactPath(payloadSha256)
    writeWithNoOverwrite(artifactPath, request.payload, existing => {
      if (existing !== request.payload) {
        throw new Error('artifact-hash-collision: same sha256 with different content')
      }
    })
    const manifestPath = this.manifestPath(candidateId)
    writeWithNoOverwrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, () => {})
    return this.load(candidateId)
  }

  manifestPath(candidateId: string): string {
    return join(this.manifestsDir, `${candidateId}.json`)
  }

  artifactPath(payloadSha256: string): string {
    return join(this.artifactsDir, `${payloadSha256}.txt`)
  }

  load(candidateId: string): CandidateManifest {
    const path = this.manifestPath(candidateId)
    if (!existsSync(path)) {
      throw new Error(`unknown-candidate:${candidateId}`)
    }
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const validation = validateCandidateManifest(raw)
    if (!validation.ok || validation.value === undefined) {
      throw new Error(`stored-manifest-invalid:${candidateId}:${validation.errors.join(',')}`)
    }
    return validation.value
  }

  readArtifact(payloadSha256: string): string {
    return readFileSync(this.artifactPath(payloadSha256), 'utf8')
  }

  /** Post-seal integrity: recompute the artifact hash (anti-TOCTOU, EVO-CAND-02/08). */
  verifyArtifact(candidateId: string): { ok: boolean; reason?: string } {
    const manifest = this.load(candidateId)
    const path = this.artifactPath(manifest.payloadSha256)
    if (!existsSync(path)) {
      return { ok: false, reason: `artifact-missing:${manifest.payloadSha256}` }
    }
    const actual = sha256Hex(readFileSync(path, 'utf8'))
    if (actual !== manifest.payloadSha256) {
      return { ok: false, reason: `artifact-hash-mismatch:manifest=${manifest.payloadSha256},actual=${actual}` }
    }
    return { ok: true }
  }
}

function writeWithNoOverwrite(path: string, content: string, onExisting: (existing: string) => void): void {
  try {
    writeFileSync(path, content, { flag: 'wx' })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST') throw error
    onExisting(readFileSync(path, 'utf8'))
  }
}
