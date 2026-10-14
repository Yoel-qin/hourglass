/**
 * Argument redaction for audit records (AUD-04). Default output never carries
 * raw argument values: secret-shaped strings collapse to `[redacted]`, and the
 * summary keeps only key names plus a bounded, redacted preview.
 * @module @hourglass/sandbox-audit
 */

import type { AuditArgumentsSummary } from './types.ts'

/**
 * Substrings that mark a value as secret-shaped. Matches are case-insensitive
 * on the key side; values are replaced wholesale, never partially, so a
 * leaked fragment cannot ride inside a truncated preview.
 */
const SECRET_KEY_PATTERN = /(?:api[-_]?key|authorization|bearer|secret|token|password|passwd|credential|private[-_]?key)/iu

/** Canary prefixes used by hourglass test fixtures; redacted like real secrets. */
const SYNTHETIC_CANARY_PATTERN = /DSH_SYNTHETIC_CANARY_/iu

/** Placeholder substituted for every redacted value. */
export const REDACTED = '[redacted]'

/** Default ceiling on the preview text; larger payloads are truncated. */
export const DEFAULT_PREVIEW_CHARS = 200

/** Returns true when a string value looks like a secret and must be dropped. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key) || SYNTHETIC_CANARY_PATTERN.test(key)
}

/**
 * Redact one already-serialized value string. Secret-looking segments inside
 * free text (e.g. a shell command embedding `token=...`) are masked so that
 * the preview stays useful without carrying the credential.
 */
export function redactValueString(value: string): string {
  let out = value.replace(/(DSH_SYNTHETIC_CANARY_)[A-Za-z0-9_-]+/gu, `$1${REDACTED}`)
  out = out.replace(/\b((?:api[-_]?key|token|secret|password|passwd|authorization|bearer)[=:]\s*)(\S+)/giu, `$1${REDACTED}`)
  return out
}

/**
 * Build the default audit summary of a tool's arguments: sorted key names for
 * objects, a type tag otherwise, plus a bounded redacted preview.
 */
export function summarizeArguments(
  args: unknown,
  previewChars: number = DEFAULT_PREVIEW_CHARS,
): AuditArgumentsSummary {
  let keys: readonly string[] = []
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    keys = Object.keys(args as Record<string, unknown>).sort()
  }
  // Probe serializability first: deepRedact would recurse forever on a
  // circular structure that JSON.stringify refuses.
  let serializable = true
  try {
    JSON.stringify(args)
  } catch {
    serializable = false
  }
  if (!serializable) {
    return { keys, redacted: true, preview: '[unserializable]' }
  }
  const redacted = keys.length > 0 && keys.every(isSecretKey)
    ? Object.fromEntries(keys.map(key => [key, REDACTED]))
    : deepRedact(args)
  let preview: string
  try {
    preview = JSON.stringify(redacted) ?? 'null'
  } catch {
    preview = '[unserializable]'
  }
  if (preview.length > previewChars) preview = `${preview.slice(0, Math.max(0, previewChars - 1))}…`
  return { keys, redacted: true, preview }
}

/**
 * Recursively copy a JSON-ish value with secret values replaced. Arrays and
 * nested objects are walked; primitives under secret-shaped keys are dropped.
 */
export function deepRedact(value: unknown): unknown {
  if (typeof value === 'string') return redactValueString(value)
  if (Array.isArray(value)) return value.map(deepRedact)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? REDACTED : deepRedact(inner)
    }
    return out
  }
  return value
}
