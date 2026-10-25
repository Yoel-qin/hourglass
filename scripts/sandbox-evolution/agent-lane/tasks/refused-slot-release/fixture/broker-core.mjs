// Minimal in-flight call accounting, extracted from a real broker core:
// every forwarded call occupies a concurrency slot from dispatch until the
// call fully settles — success, upstream failure, or client abort.
export function createCallGate(maxConcurrentCalls) {
  let inflight = 0
  const events = []
  return {
    inflight: () => inflight,
    async forward(opener) {
      if (inflight >= maxConcurrentCalls) {
        events.push({ kind: 'refused', status: 429, reason: 'concurrency-cap' })
        return { status: 429, reason: 'concurrency-cap' }
      }
      inflight += 1
      try {
        const response = await opener()
        inflight -= 1
        events.push({ kind: 'served', status: response.status })
        return response
      } catch (error) {
        events.push({ kind: 'refused', status: 502, reason: `upstream connection failed: ${String(error)}` })
        return { status: 502, reason: `upstream connection failed: ${String(error)}` }
      }
    },
    events,
  }
}
