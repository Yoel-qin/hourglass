/**
 * Controlled local network service for NET cases. Two endpoints, both local:
 * an allow-side and a deny-side. The service records every request it
 * receives (path, headers, canary) so cases judge by server-side evidence.
 * No public network is involved; domain names resolve via /etc/hosts inside
 * the test container only.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http'
import { hostname } from 'node:os'

export const ALLOW_HOST = 'hourglass-allow.tests.local'
export const DENY_HOST = 'hourglass-deny.tests.local'

export interface RecordedRequest {
  readonly at: string
  readonly host: string
  readonly path: string
  readonly canary: string | undefined
  readonly headers: Record<string, string>
}

export interface NetService {
  readonly port: number
  readonly baseUrl: (host: string) => string
  readonly requests: readonly RecordedRequest[]
  readonly requestsFor: (host: string) => readonly RecordedRequest[]
  readonly stop: () => Promise<void>
}

export async function startNetService(port = 0): Promise<NetService> {
  const recorded: RecordedRequest[] = []
  const server: Server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      recorded.push({
        at: new Date().toISOString(),
        host: request.headers.host ?? '(no host)',
        path: request.url ?? '/',
        canary: body.includes('DSH_SYNTHETIC_CANARY_')
          ? (body.match(/DSH_SYNTHETIC_CANARY_[A-Za-z0-9]+/g) ?? []).join(',')
          : undefined,
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : String(value)]),
        ),
      })
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('hourglass-test-service\n')
    })
  })
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('net service did not bind an tcp port')
  const boundPort = address.port
  return {
    port: boundPort,
    baseUrl: (host: string) => `http://${host}:${boundPort}/probe`,
    get requests() {
      return recorded
    },
    requestsFor: (host: string) => recorded.filter(entry => entry.host.startsWith(host)),
    stop: () => new Promise<void>((resolve, reject) => server.close(error => (error === undefined ? resolve() : reject(error)))),
  }
}

/** /etc/hosts entries the container needs for the synthetic test domains. */
export function etcHostsLines(port: number): string {
  return [
    '# hourglass sandbox-compare synthetic domains',
    `127.0.0.1 ${ALLOW_HOST}`,
    `127.0.0.1 ${DENY_HOST}`,
    `# service port for reference: ${port}`,
    `# host: ${hostname()}`,
  ].join('\n')
}
