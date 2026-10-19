/**
 * Evolution lock gate: every locked benchmark/fixture file must hash to its
 * recorded SHA-256. Mirrors the sandbox-compare versions-lock discipline but
 * is a SEPARATE lock file, so the existing framework stays untouched
 * (ADR-003 D7). Any benchmark change is a new lock version reviewed in the
 * same PR — never an in-place edit.
 */

import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface LockValidationResult {
  readonly ok: boolean
  readonly errors: readonly string[]
  readonly lockSha256: string
}

export function validateEvolutionLock(baseDir: string): LockValidationResult {
  const lockPath = join(baseDir, 'evolution.lock.json')
  const errors: string[] = []
  if (!existsSync(lockPath)) {
    return { ok: false, errors: ['lock-file-missing'], lockSha256: '' }
  }
  const lockRaw = readFileSync(lockPath, 'utf8')
  const lockSha256 = createHash('sha256').update(lockRaw, 'utf8').digest('hex')
  let lock: { files?: Record<string, string> }
  try {
    lock = JSON.parse(lockRaw) as { files?: Record<string, string> }
  } catch {
    return { ok: false, errors: ['lock-file-unparseable'], lockSha256 }
  }
  if (lock.files === undefined || Object.keys(lock.files).length === 0) {
    errors.push('lock-files-empty')
  } else {
    for (const [relative, expected] of Object.entries(lock.files)) {
      const target = join(baseDir, relative)
      if (!existsSync(target)) {
        errors.push(`locked-file-missing:${relative}`)
        continue
      }
      const actual = createHash('sha256').update(readFileSync(target, 'utf8'), 'utf8').digest('hex')
      if (actual !== expected) {
        errors.push(`locked-hash-mismatch:${relative}`)
      }
    }
  }
  return { ok: errors.length === 0, errors, lockSha256 }
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
