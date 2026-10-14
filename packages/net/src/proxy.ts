/**
 * Host-side egress proxy: an HTTP proxy on a unix socket that enforces the
 * allowlist. Handles CONNECT (HTTPS tunnels) and absolute-URI HTTP requests.
 * Every decision is appended to a JSONL log so reports can quote it.
 * @module @hourglass/sandbox-net
 */

import { appendFileSync } from 'node:fs'
import { connect as netConnect, type Socket } from 'node:net'
import { createServer, type IncomingMessage, request as httpRequest, type Server, type ServerResponse } from 'node:http'
import { hostAllowedByAllowlist, normalizeHost } from '@hourglass/policy-ci/src/index.ts'
import type { NetEgressPolicy, ProxyDecision } from './types.ts'

export interface EgressProxy {
  readonly socketPath: string
  readonly decisions: readonly ProxyDecision[]
  readonly stop: () => Promise<void>
}

function decideHost(policy: NetEgressPolicy, rawHost: string): { allowed: boolean; normalized: string | undefined; reason: string } {
  const normalized = normalizeHost(rawHost)
  if (normalized === undefined) {
    return { allowed: false, normalized: undefined, reason: `invalid host literal rejected: ${JSON.stringify(rawHost)}` }
  }
  if (policy.mode === 'deny-all') {
    return { allowed: false, normalized, reason: 'policy is deny-all' }
  }
  if (policy.allowlist.length === 0) {
    return { allowed: false, normalized, reason: 'empty allowlist means deny-all' }
  }
  if (hostAllowedByAllowlist(normalized, policy.allowlist)) {
    return { allowed: true, normalized, reason: `host ${normalized} allowlisted` }
  }
  return { allowed: false, normalized, reason: `host ${normalized} not in allowlist` }
}

/**
 * Start the egress proxy on a unix socket. `socketPath` must not exist; the
 * caller owns cleanup via `stop()`.
 */
export async function startEgressProxy(
  socketPath: string,
  policy: NetEgressPolicy,
  decisionLogPath?: string,
): Promise<EgressProxy> {
  const decisions: ProxyDecision[] = []
  const record = (decision: ProxyDecision): void => {
    decisions.push(decision)
    if (decisionLogPath !== undefined) {
      try {
        appendFileSync(decisionLogPath, `${JSON.stringify(decision)}\n`, { encoding: 'utf8' })
      } catch {
        // The in-memory copy still serves queries; a failing decision log is
        // surfaced via diagnostics rather than weakening enforcement.
      }
    }
  }

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    // Absolute-URI HTTP proxying (plain http:// URLs through the proxy).
    let target: URL | undefined
    try {
      target = request.url === undefined ? undefined : new URL(request.url)
    } catch {
      target = undefined
    }
    if (target === undefined || !target.hostname) {
      response.writeHead(400, { 'content-type': 'text/plain' })
      response.end('hourglass proxy: expected absolute-URI request or CONNECT\n')
      return
    }
    const verdict = decideHost(policy, target.hostname)
    const port = Number(target.port) || 80
    record({ at: new Date().toISOString(), kind: 'absolute-uri', host: target.hostname, port, allowed: verdict.allowed, reason: verdict.reason })
    if (!verdict.allowed) {
      response.writeHead(403, { 'content-type': 'text/plain' })
      response.end(`hourglass proxy: ${verdict.reason}\n`)
      return
    }
    const headers = { ...request.headers }
    delete headers['proxy-connection']
    delete headers['connection']
    const upstream = httpRequest(
      { host: verdict.normalized, port, method: request.method, path: `${target.pathname}${target.search}`, headers },
      upstreamRes => {
        response.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(response)
      },
    )
    upstream.on('error', () => {
      response.writeHead(502)
      response.end('hourglass proxy: upstream failed')
    })
    request.pipe(upstream)
  })

  // CONNECT tunnels (https:// and anything that speaks CONNECT).
  server.on('connect', (request: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const [rawHost, rawPort] = (request.url ?? '').split(':')
    const verdict = decideHost(policy, rawHost ?? '')
    const port = Number(rawPort) || 443
    record({ at: new Date().toISOString(), kind: 'connect', host: rawHost ?? '', port, allowed: verdict.allowed, reason: verdict.reason })
    if (!verdict.allowed) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      clientSocket.end(`hourglass proxy: ${verdict.reason}\n`)
      return
    }
    const upstream = netConnect({ host: verdict.normalized, port }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      clientSocket.end()
    })
    clientSocket.on('error', () => upstream.destroy())
  })

  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  return {
    socketPath,
    get decisions() {
      return decisions
    },
    stop: () => new Promise<void>((resolve, reject) => server.close(error => (error === undefined ? resolve() : reject(error)))),
  }
}
