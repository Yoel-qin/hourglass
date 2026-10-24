/**
 * Minimal local HTTP recorder for the agent-carrier probe: every request that
 * reaches it is recorded with its body so the probe can prove the confined
 * child's egress attempts NEVER arrived (server-side zero-canary evidence,
 * the same discipline as the compare net-service). Loopback-only, no public
 * network involved.
 *
 * @module @hourglass/evolution-runner
 */

import { createServer, type IncomingMessage, type Server } from 'node:http'

export interface RecordedHit {
  readonly at: string
  readonly method: string
  readonly path: string
  readonly body: string
}

export interface NetRecorder {
  readonly port: number
  readonly hits: readonly RecordedHit[]
  readonly stop: () => Promise<void>
}

export async function startNetRecorder(port = 0): Promise<NetRecorder> {
  const hits: RecordedHit[] = []
  const server: Server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      hits.push({
        at: new Date().toISOString(),
        method: request.method ?? '(none)',
        path: request.url ?? '/',
        body: Buffer.concat(chunks).toString('utf8'),
      })
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('hourglass-agent-carrier-recorder\n')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject) // node always hands an Error here
    server.listen(port, '0.0.0.0', () => resolve())
  })
  const address = server.address() as { port: number }
  return {
    port: address.port,
    get hits() {
      return hits
    },
    stop: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close(error => (error === undefined ? resolve() : reject(error)))
    }),
  }
}
