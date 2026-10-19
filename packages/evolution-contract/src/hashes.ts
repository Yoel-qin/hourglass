/**
 * Hash and canonicalization primitives shared by every evolution contract.
 * Canonical JSON sorts object keys recursively so the same value always
 * hashes to the same digest regardless of field insertion order.
 */

import { createHash } from 'node:crypto'

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

export function canonicalJson(value: unknown): string {
  return stringifyCanonical(value)
}

function stringifyCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map(stringifyCanonical).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).filter(key => record[key] !== undefined).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stringifyCanonical(record[key])}`).join(',')}}`
}
