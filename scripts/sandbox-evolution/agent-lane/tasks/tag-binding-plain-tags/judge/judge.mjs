// Hidden judge for task tag-binding-plain-tags. Real regression assertions
// carried over from the original fix: a plain version tag at HEAD must not
// produce a false mismatch when the HEAD sha itself matches the pin; a
// pinned-sha tag must still match on its own; unrelated tags or an
// unreadable tree must stay mismatches (fail-closed).
// Protocol: node judge.mjs <workspaceDir>.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const workspace = process.argv[2]
const checks = []

function record(name, ok, detail) {
  checks.push({ name, ok, detail })
}

const PINNED = 'd743267388641bc76f17c45ce8b4c231aed1d32c'
const OTHER = '1111111111111111111111111111111111111111'

const scenarios = [
  { name: 'plain-version-tag-no-false-mismatch', tree: { headSha: PINNED, tags: ['v1.2.3'] }, pinned: PINNED, expected: true },
  { name: 'pinned-sha-tag-still-matches', tree: { headSha: OTHER, tags: [PINNED] }, pinned: PINNED, expected: true },
  { name: 'head-and-pinned-tag-together-match', tree: { headSha: PINNED, tags: [PINNED, 'v0.9.0'] }, pinned: PINNED, expected: true },
  { name: 'unrelated-tags-stay-mismatch', tree: { headSha: OTHER, tags: ['v1.2.3', 'v0.9.0'] }, pinned: PINNED, expected: false },
  { name: 'unreadable-tree-fails-closed', tree: { headSha: undefined, tags: [] }, pinned: PINNED, expected: false },
]

try {
  const mod = await import(pathToFileURL(join(workspace, 'env-gate.mjs')).href)
  for (const scenario of scenarios) {
    try {
      const got = mod.environmentMatches(scenario.tree, scenario.pinned)
      record(scenario.name, got === scenario.expected,
        `head=${String(scenario.tree.headSha)} tags=[${scenario.tree.tags.join(',')}] expected=${String(scenario.expected)} got=${String(got)}`)
    } catch (error) {
      record(scenario.name, false, `threw: ${String(error?.message ?? error)}`)
    }
  }
} catch (error) {
  record('judge-ran', false, String(error?.stack ?? error))
}

const ok = checks.length > 0 && checks.every(check => check.ok)
console.log(`JUDGE-RESULT: ${JSON.stringify({ ok, checks })}`)
process.exit(ok ? 0 : 1)
