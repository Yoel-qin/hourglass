// Hidden judge for task abort-settle-scope. Real regression assertions
// carried over from the original fix: a client abort must STILL settle the
// call (a handler body that references a variable from another function's
// scope throws inside the event dispatch — the settlement silently never
// happens and the call leaks), the settled record must carry the kind the
// call was dispatched with, and the response path must keep working.
// Protocol: node judge.mjs <workspaceDir>.
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const workspace = process.argv[2]
const checks = []
const record = (name, ok, detail) => checks.push({ name, ok, detail })

function watchOnce(module, kind, emit) {
  const settled = []
  const events = new EventEmitter()
  module.watchUpstream(events, kind, record => settled.push(record))
  let dispatchError = undefined
  try {
    emit(events)
  } catch (error) {
    dispatchError = error
  }
  return { settled, dispatchError }
}

try {
  const mod = await import(pathToFileURL(join(workspace, 'upstream-watch.mjs')).href)

  const response = watchOnce(mod, 'messages', events => events.emit('response', { status: 200 }))
  record('response-settles-ok',
    response.dispatchError === undefined && response.settled.length === 1
      && response.settled[0].kind === 'messages' && response.settled[0].status === 200 && response.settled[0].ok === true,
    `dispatchError=${String(response.dispatchError)} settled=${JSON.stringify(response.settled)}`)

  // THE regression: the abort path must settle, with the dispatched kind.
  const abort = watchOnce(mod, 'messages', events => events.emit('abort'))
  record('abort-still-settles', abort.dispatchError === undefined && abort.settled.length === 1,
    `dispatchError=${String(abort.dispatchError)} settled=${JSON.stringify(abort.settled)}`)
  if (abort.settled.length === 1 && abort.dispatchError === undefined) {
    const entry = abort.settled[0]
    record('abort-record-kind-and-status',
      entry.kind === 'messages' && entry.status === 499 && entry.ok === false,
      `settled=${JSON.stringify(entry)}`)
  }

  const otherKind = watchOnce(mod, 'chat-completions', events => events.emit('abort'))
  record('kind-passthrough-on-abort',
    otherKind.dispatchError === undefined && otherKind.settled.length === 1 && otherKind.settled[0].kind === 'chat-completions',
    `settled=${JSON.stringify(otherKind.settled)} dispatchError=${String(otherKind.dispatchError)}`)
} catch (error) {
  record('judge-ran', false, String(error?.stack ?? error))
}

const ok = checks.length > 0 && checks.every(check => check.ok)
console.log(`JUDGE-RESULT: ${JSON.stringify({ ok, checks })}`)
process.exit(ok ? 0 : 1)
