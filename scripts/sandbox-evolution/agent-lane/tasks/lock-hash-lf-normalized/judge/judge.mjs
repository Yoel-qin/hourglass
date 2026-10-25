// Hidden judge for task lock-hash-lf-normalized. Real regression assertions
// carried over from the original fix: a digest recorded over LF content must
// verify on a CRLF-rewritten copy of the same content (autocrlf checkout),
// while genuinely different content — and lone-CR content, which is NOT a
// CRLF pair — must keep failing.
// Protocol: node judge.mjs <workspaceDir>.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const workspace = process.argv[2]
const checks = []

function record(name, ok, detail) {
  checks.push({ name, ok, detail })
}

try {
  const mod = await import(pathToFileURL(join(workspace, 'lock-gate.mjs')).href)

  const lfContent = '{\n  "schema": "example/1",\n  "value": 7\n}\n'
  const crlfContent = lfContent.replace(/\n/g, '\r\n')
  const changedContent = '{\n  "schema": "example/1",\n  "value": 8\n}\n'

  // The digest is recorded from the LF copy, exactly as the real lock does.
  const recorded = mod.sha256(lfContent)

  record('lf-content-verifies', mod.verifyLocked(lfContent, recorded) === true,
    `recorded=${recorded.slice(0, 12)}…`)
  record('crlf-checkout-verifies-same-digest', mod.verifyLocked(crlfContent, recorded) === true,
    'autocrlf-rewritten copy must match the LF-recorded digest')
  record('different-content-still-fails', mod.verifyLocked(changedContent, recorded) === false,
    'changed content must not verify')
  record('lone-cr-stays-distinct', mod.verifyLocked('a\rb', mod.sha256('ab')) === false,
    'a lone CR is not a CRLF pair; it must not be normalized away')
  // The digest helper itself must stay RAW: digests are recorded by outside
  // tooling over LF text, so folding line endings inside sha256() would
  // silently change what a recorded digest means.
  record('sha256-stays-raw', mod.sha256(lfContent) === recorded && mod.sha256(crlfContent) !== recorded,
    'sha256 must hash its argument verbatim')
} catch (error) {
  record('judge-ran', false, String(error?.stack ?? error))
}

const ok = checks.length > 0 && checks.every(check => check.ok)
console.log(`JUDGE-RESULT: ${JSON.stringify({ ok, checks })}`)
process.exit(ok ? 0 : 1)
