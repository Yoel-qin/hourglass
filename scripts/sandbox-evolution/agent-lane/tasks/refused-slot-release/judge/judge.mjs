// Hidden judge for task refused-slot-release. Real regression assertions
// carried over from the original fix: slots burned by refused connects must
// be recovered (a later healthy call is still admitted under the same
// gate), the concurrency cap itself must stay enforced, and accounting must
// settle back to zero after mixed traffic.
// Protocol: node judge.mjs <workspaceDir>.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const workspace = process.argv[2]
const checks = []
const record = (name, ok, detail) => checks.push({ name, ok, detail })

const refused = () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('connect ECONNREFUSED')), 5))
const okResponse = (status = 200) => new Promise(resolve => setTimeout(() => resolve({ status }), 5))
const slowOk = () => new Promise(resolve => setTimeout(() => resolve({ status: 200 }), 60))

try {
  const { createCallGate } = await import(pathToFileURL(join(workspace, 'broker-core.mjs')).href)

  // 1. THE regression: three refused connects, then a healthy call must be
  //    admitted by the SAME gate whose slots the refusals burned.
  const gate = createCallGate(1)
  const refusedStatuses = []
  for (let index = 0; index < 3; index += 1) {
    const refusedResult = await gate.forward(refused)
    refusedStatuses.push(refusedResult.status)
  }
  record('refused-forwards-report-502', refusedStatuses.every(status => status === 502),
    `statuses=[${refusedStatuses.join(',')}]`)
  const after = await gate.forward(() => okResponse())
  record('slot-recovered-after-refusals', after.status === 200,
    `healthy call after refusals: ${String(after.status)} ${String(after.reason ?? '')}`)

  // 2. The cap itself must stay enforced: while a slow call is in flight,
  //    a second call through the same gate is refused with 429.
  const capped = createCallGate(1)
  const first = capped.forward(slowOk)
  const second = await capped.forward(() => okResponse())
  await first
  record('concurrency-cap-still-enforced', second.status === 429, `second in-flight call: ${String(second.status)}`)

  // 3. Accounting settles back to zero after mixed traffic.
  const settle = createCallGate(2)
  await settle.forward(refused)
  await settle.forward(() => okResponse())
  await settle.forward(refused)
  record('inflight-settles-to-zero', settle.inflight() === 0, `inflight=${String(settle.inflight())}`)

  // 4. The event log keeps its shape: refusals carry status/reason.
  const shape = createCallGate(1)
  await shape.forward(refused)
  const refusal = shape.events.find(event => event.kind === 'refused')
  record('refusal-events-keep-shape',
    refusal !== undefined && refusal.status === 502 && typeof refusal.reason === 'string' && refusal.reason.includes('ECONNREFUSED'),
    `event=${JSON.stringify(refusal)}`)
} catch (error) {
  record('judge-ran', false, String(error?.stack ?? error))
}

const ok = checks.length > 0 && checks.every(check => check.ok)
console.log(`JUDGE-RESULT: ${JSON.stringify({ ok, checks })}`)
process.exit(ok ? 0 : 1)
