// Hidden judge for task verdict-substring-false-positive. Real regression
// assertions carried over from the original fix: a JSONL decision log whose
// records all carry "denied":false is NOT confinement evidence (the field
// NAME contains the word "denied" — a substring shortcut false-positives),
// genuine denied:true records ARE evidence, and malformed lines are skipped
// rather than crashing or counting.
// Protocol: node judge.mjs <workspaceDir>.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const workspace = process.argv[2]
const checks = []
const record = (name, ok, detail) => checks.push({ name, ok, detail })

const ALLOWED_ONLY = [
  '{"host":"a.example","decision":"allow","denied":false}',
  '{"host":"b.example","decision":"allow","denied":false}',
  '{"host":"c.example","decision":"allow","denied":false}',
].join('\n')
const GENUINE = [
  '{"host":"a.example","decision":"allow","denied":false}',
  '{"host":"evil.example","decision":"deny","denied":true}',
].join('\n')
const MALFORMED = [
  'not-json-at-all',
  '{"host":"evil.example","decision":"deny","denied":true}',
  '{{',
].join('\n')

try {
  const mod = await import(pathToFileURL(join(workspace, 'confinement-verdict.mjs')).href)

  const allowed = mod.confinementVerdict(ALLOWED_ONLY)
  record('allowed-only-log-is-not-confinement', allowed.confined === false,
    `verdict=${JSON.stringify(allowed)}`)

  const genuine = mod.confinementVerdict(GENUINE)
  record('genuine-denial-is-confinement', genuine.confined === true,
    `verdict=${JSON.stringify(genuine)}`)

  const empty = mod.confinementVerdict('')
  record('empty-log-is-not-confinement', empty.confined === false,
    `verdict=${JSON.stringify(empty)}`)

  const malformed = mod.confinementVerdict(MALFORMED)
  record('malformed-lines-skipped-not-counted', malformed.confined === true,
    `verdict=${JSON.stringify(malformed)} (garbage lines must neither crash nor deny)`)

  const garbageOnly = mod.confinementVerdict('not-json\nalso not json')
  record('garbage-only-is-not-confinement', garbageOnly.confined === false,
    `verdict=${JSON.stringify(garbageOnly)}`)
} catch (error) {
  record('judge-ran', false, String(error?.stack ?? error))
}

const ok = checks.length > 0 && checks.every(check => check.ok)
console.log(`JUDGE-RESULT: ${JSON.stringify({ ok, checks })}`)
process.exit(ok ? 0 : 1)
