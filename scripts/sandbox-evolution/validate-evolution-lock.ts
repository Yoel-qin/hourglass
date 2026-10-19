/**
 * Evolution lock gate: every locked benchmark/fixture file must hash to its
 * recorded SHA-256, and the lock must carry a well-formed policy and dsh
 * commit — the runner consumes BOTH from the lock, so the lock is the single
 * source of truth it claims to be (PR #3 review finding). Mirrors the
 * sandbox-compare versions-lock discipline but is a SEPARATE lock file, so
 * the existing framework stays untouched (ADR-003 D7).
 */

import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface LockedPolicy {
  readonly primaryMetric: string
  readonly minImprovementPctPoints: number
  readonly ciConfidence: number
  readonly minPairedSamples: number
  readonly keyCategoryRegressionBudgetPct: number
  readonly costLatencyDegradationBudgetPct: number
  readonly controlRunTolerancePct: number
}

export interface EvolutionLock {
  readonly dshCommit: string
  readonly policy: LockedPolicy
}

export interface LockValidationResult {
  readonly ok: boolean
  readonly errors: readonly string[]
  readonly lockSha256: string
  readonly lock?: EvolutionLock
}

const POLICY_NUMERIC_FIELDS = [
  'minImprovementPctPoints',
  'ciConfidence',
  'minPairedSamples',
  'keyCategoryRegressionBudgetPct',
  'costLatencyDegradationBudgetPct',
  'controlRunTolerancePct',
] as const

export function validateEvolutionLock(baseDir: string): LockValidationResult {
  const lockPath = join(baseDir, 'evolution.lock.json')
  const errors: string[] = []
  if (!existsSync(lockPath)) {
    return { ok: false, errors: ['lock-file-missing'], lockSha256: '' }
  }
  const lockRaw = readFileSync(lockPath, 'utf8')
  const lockSha256 = createHash('sha256').update(lockRaw, 'utf8').digest('hex')
  let parsed: { files?: Record<string, string>; dshCommit?: string; policy?: Record<string, unknown> }
  try {
    parsed = JSON.parse(lockRaw) as { files?: Record<string, string>; dshCommit?: string; policy?: Record<string, unknown> }
  } catch {
    return { ok: false, errors: ['lock-file-unparseable'], lockSha256 }
  }
  if (parsed.files === undefined || Object.keys(parsed.files).length === 0) {
    errors.push('lock-files-empty')
  } else {
    for (const [relative, expected] of Object.entries(parsed.files)) {
      const target = join(baseDir, relative)
      if (!existsSync(target)) {
        errors.push(`locked-file-missing:${relative}`)
        continue
      }
      // Locked hashes are recorded over LF-normalized content: git's
      // autocrlf rewrites working-tree line endings on checkout, and the
      // gate must not depend on which platform checked the tree out.
      const normalized = readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
      const actual = createHash('sha256').update(normalized, 'utf8').digest('hex')
      if (actual !== expected) {
        errors.push(`locked-hash-mismatch:${relative}`)
      }
    }
  }
  if (typeof parsed.dshCommit !== 'string' || !/^[0-9a-f]{40}$/u.test(parsed.dshCommit)) {
    errors.push('malformed-field:dshCommit')
  }
  const policy = parsed.policy
  if (policy === undefined || typeof policy['primaryMetric'] !== 'string' || policy['primaryMetric'] === '') {
    errors.push('malformed-field:policy.primaryMetric')
  }
  for (const field of POLICY_NUMERIC_FIELDS) {
    const value = policy?.[field]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      errors.push(`malformed-field:policy.${field}`)
    }
  }
  if (errors.length > 0 || typeof parsed.dshCommit !== 'string' || policy === undefined) {
    return { ok: false, errors, lockSha256 }
  }
  const lock: EvolutionLock = {
    dshCommit: parsed.dshCommit,
    policy: {
      primaryMetric: policy['primaryMetric'] as string,
      minImprovementPctPoints: policy['minImprovementPctPoints'] as number,
      ciConfidence: policy['ciConfidence'] as number,
      minPairedSamples: policy['minPairedSamples'] as number,
      keyCategoryRegressionBudgetPct: policy['keyCategoryRegressionBudgetPct'] as number,
      costLatencyDegradationBudgetPct: policy['costLatencyDegradationBudgetPct'] as number,
      controlRunTolerancePct: policy['controlRunTolerancePct'] as number,
    },
  }
  return { ok: true, errors: [], lockSha256, lock }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('validate-evolution-lock.ts')) {
  const baseDir = dirname(fileURLToPath(import.meta.url))
  const result = validateEvolutionLock(baseDir)
  console.log(`[evolution-lock] ${result.ok ? 'OK' : 'FAILED'} sha256=${result.lockSha256}`)
  for (const error of result.errors) {
    console.error(`[evolution-lock] ${error}`)
  }
  process.exit(result.ok ? 0 : 1)
}
