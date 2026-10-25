// Locked-file digest gate, minimal extraction: verifies a locked file's
// content against the digest recorded in the lock. Digests are recorded on
// an LF-normalized checkout of the tree.
import { createHash } from 'node:crypto'

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function verifyLocked(content, expectedSha) {
  return sha256(content) === expectedSha
}
