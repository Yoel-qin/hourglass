// Minimal upstream watcher, extracted from a real forwarder: every
// forwarded call must settle EXACTLY ONCE — on the upstream response, or on
// client abort — carrying the protocol kind it was dispatched with. Event
// handler bodies see only their own scope; the abort settlement uses the
// SAME kind parameter the call was dispatched with.
export function watchUpstream(events, kind, settle) {
  events.on('response', response => {
    settle({ kind, status: response.status, ok: response.status < 400 })
  })
  events.on('abort', () => {
    settle({ kind, status: 499, ok: false })
  })
}
