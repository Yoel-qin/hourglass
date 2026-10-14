/**
 * Version-lock gate for the sandbox comparison framework. Validates
 * scripts/sandbox-compare/versions.lock.json: schema shape, pinned commits
 * for every subject, explicit reasons for unsupported scopes, and review
 * metadata. Exit code 1 on any violation; prints the file SHA-256 for
 * reports to quote on success.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const LOCK_PATH = join(here, 'versions.lock.json')

interface Violation {
  path: string
  problem: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireFields(
  container: Record<string, unknown>,
  path: string,
  fields: readonly string[],
  violations: Violation[],
): void {
  for (const field of fields) {
    if (!(field in container)) violations.push({ path: `${path}.${field}`, problem: 'missing field' })
  }
}

function validate(lock: unknown): Violation[] {
  const violations: Violation[] = []
  if (!isObject(lock)) return [{ path: '$', problem: 'lock file is not a JSON object' }]
  if (lock.schema !== 'hourglass-versions-lock/1') {
    violations.push({ path: 'schema', problem: `unexpected schema ${JSON.stringify(lock.schema)}` })
  }
  requireFields(lock, '$', ['lockedAt', 'environment', 'subjects', 'review'], violations)
  if (typeof lock.lockedAt !== 'string') violations.push({ path: 'lockedAt', problem: 'not a string' })

  if (!isObject(lock.environment)) {
    violations.push({ path: 'environment', problem: 'not an object' })
  } else {
    requireFields(lock.environment, 'environment', ['testPlatform', 'containerBase', 'node'], violations)
  }

  const subjects = lock.subjects
  if (!isObject(subjects)) {
    violations.push({ path: 'subjects', problem: 'not an object' })
    return violations
  }
  const REQUIRED_SUBJECTS = ['DSH-BASE', 'DSH-PLUGIN', 'SRT', 'CODEX', 'NSJAIL'] as const
  for (const id of REQUIRED_SUBJECTS) {
    if (!(id in subjects)) violations.push({ path: `subjects.${id}`, problem: 'required subject missing' })
  }
  for (const [id, rawSubject] of Object.entries(subjects)) {
    const path = `subjects.${id}`
    if (!isObject(rawSubject)) {
      violations.push({ path, problem: 'not an object' })
      continue
    }
    requireFields(rawSubject, path, ['kind', 'repository', 'role'], violations)
    const commit = rawSubject.commit
    if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {
      violations.push({ path: `${path}.commit`, problem: 'must be a pinned 40-hex commit SHA' })
    }
    if (rawSubject.kind === 'npm' && typeof rawSubject.version !== 'string') {
      violations.push({ path: `${path}.version`, problem: 'npm subjects must pin a version' })
    }
  }

  if (Array.isArray(lock.unsupportedDeclarations)) {
    lock.unsupportedDeclarations.forEach((raw, index) => {
      if (!isObject(raw)) {
        violations.push({ path: `unsupportedDeclarations.${index}`, problem: 'not an object' })
        return
      }
      requireFields(raw, `unsupportedDeclarations.${index}`, ['subject', 'scope', 'reason'], violations)
    })
  } else {
    violations.push({ path: 'unsupportedDeclarations', problem: 'missing or not an array' })
  }

  if (!isObject(lock.review)) {
    violations.push({ path: 'review', problem: 'not an object' })
  } else {
    requireFields(lock.review, 'review', ['lastReviewedAt', 'lastReviewedBy', 'policy'], violations)
  }
  return violations
}

function main(): number {
  let lock: unknown
  try {
    lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
  } catch (error) {
    console.error(`[versions-lock] cannot read ${LOCK_PATH}: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  const violations = validate(lock)
  if (violations.length > 0) {
    console.error(`[versions-lock] ${violations.length} violation(s):`)
    for (const violation of violations) console.error(`  - ${violation.path}: ${violation.problem}`)
    return 1
  }
  const sha256 = createHash('sha256').update(readFileSync(LOCK_PATH)).digest('hex')
  console.log(`[versions-lock] OK sha256=${sha256}`)
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  process.exit(main())
}

export { validate, LOCK_PATH }
