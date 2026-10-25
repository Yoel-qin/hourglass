// Hidden judge for task sse-crlf-usage. Real regression assertions carried
// over from the original fix: usage must be metered from CRLF-terminated
// SSE frames exactly as from LF frames (an unmetered stream is the defect —
// it fails the lane's usage caps closed); last-wins and no-usage semantics
// must hold on both line endings.
// Protocol: node judge.mjs <workspaceDir>.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const workspace = process.argv[2]
const checks = []

function record(name, ok, detail) {
  checks.push({ name, ok, detail })
}

const LF_BODY = 'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\ndata: [DONE]\n\n'
const CRLF_BODY = 'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\r\n\r\ndata: [DONE]\r\n\r\n'
const LAST_WINS_LF = 'data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: {"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10}}\n\ndata: [DONE]\n'
const NO_USAGE_CRLF = 'data: {"choices":[{"delta":{"content":"hi"}}]}\r\n\r\ndata: [DONE]\r\n'

try {
  const mod = await import(pathToFileURL(join(workspace, 'usage-from-sse.mjs')).href)

  const expected = { promptTokens: 2, completionTokens: 3, totalTokens: 5 }
  const lf = mod.extractUsageFromSse(LF_BODY)
  record('lf-frames-metered',
    JSON.stringify(lf) === JSON.stringify(expected), `got=${JSON.stringify(lf) ?? 'undefined'}`)

  const crlf = mod.extractUsageFromSse(CRLF_BODY)
  record('crlf-frames-metered',
    JSON.stringify(crlf) === JSON.stringify(expected), `got=${JSON.stringify(crlf) ?? 'undefined'}`)

  const lastWins = mod.extractUsageFromSse(LAST_WINS_LF)
  record('last-usage-chunk-wins',
    JSON.stringify(lastWins) === JSON.stringify({ promptTokens: 4, completionTokens: 6, totalTokens: 10 }),
    `got=${JSON.stringify(lastWins) ?? 'undefined'}`)

  const none = mod.extractUsageFromSse(NO_USAGE_CRLF)
  record('stream-without-usage-stays-undefined', none === undefined, `got=${JSON.stringify(none) ?? 'undefined'}`)
} catch (error) {
  record('judge-ran', false, String(error?.stack ?? error))
}

const ok = checks.length > 0 && checks.every(check => check.ok)
console.log(`JUDGE-RESULT: ${JSON.stringify({ ok, checks })}`)
process.exit(ok ? 0 : 1)
