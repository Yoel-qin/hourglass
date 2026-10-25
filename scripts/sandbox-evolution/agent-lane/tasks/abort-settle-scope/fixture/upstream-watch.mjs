// Minimal upstream watcher, extracted from a real forwarder: every
// forwarded call must settle EXACTLY ONCE — on the upstream response, or on
// client abort — carrying the protocol kind it was dispatched with.
export function watchUpstream(events, kind, settle) {
  events.on('response', response => {
    settle({ kind, status: response.status, ok: response.status < 400 })
  })
  events.on('abort', () => {
    settle({ kind: isChat ? 'chat-completions' : 'messages', status: 499, ok: false })
  })
}
