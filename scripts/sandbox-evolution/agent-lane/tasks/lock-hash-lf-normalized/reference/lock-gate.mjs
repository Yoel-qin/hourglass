// Locked-file digest gate, minimal extraction: verifies a locked file's
// content against the digest recorded in the lock. Digests are recorded on
// an LF-normalized checkout of the tree — git's autocrlf rewrites working-
// tree line endings on checkout, so the gate must normalize CRLF back to LF
// before hashing or every Windows checkout would false-mismatch. A lone CR
// is not a CRLF pair and must stay distinct.
import { createHash } from 'node:crypto'

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function normalizedContent(content) {
  return content.replace(/\r\n/g, '\n')
}

export function verifyLocked(content, expectedSha) {
  return sha256(normalizedContent(content)) === expectedSha
}
