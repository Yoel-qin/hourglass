/**
 * Host-side LLM broker for the real-model trial lane (ADR-004 D2): the single
 * chokepoint between a confined agent-lane child and the LLM upstream. The
 * child's model route points here (loopback); the upstream credential never
 * enters the child — this process strips any client credential, injects the
 * host-side key, meters usage from the API `usage` fields (reported numbers,
 * not estimates), and enforces fail-closed hard caps (calls / tokens /
 * wall-clock). Only model traffic is forwarded — OpenAI-compatible
 * chat-completions AND the Messages protocol the DSH DeepSeek adapter speaks
 * (POST /v1/messages, Anthropic-style) — plus a read-only /models probe;
 * everything else is refused without touching the network. Token caps are as
 * hard as the upstream's usage
 * reporting: calls and wall-clock are enforced independently of it.
 *
 * @module @hourglass/evolution-trial
 */

import { appendFileSync } from 'node:fs'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export interface UsageCaps {
  /** Completed chat-completions calls allowed per broker lifetime. */
  readonly maxCalls: number
  /** Sum of upstream-reported total tokens allowed per broker lifetime. */
  readonly maxTotalTokens: number
  /** Broker wall-clock budget in milliseconds, checked before each call. */
  readonly wallClockMs: number
}

export interface LlmBrokerConfig {
  /** Upstream base, e.g. https://api.deepseek.com/v1 or a loopback mock. */
  readonly upstreamBaseUrl: string
  /** Host-side credential; empty/undefined injects no Authorization header. */
  readonly apiKey?: string
  /** Model ids the child may request; anything else is refused pre-upstream. */
  readonly modelAllowlist: readonly string[]
  readonly caps: UsageCaps
  /** Optional forward HTTP proxy (CONNECT) for reaching the upstream. */
  readonly proxyUrl?: string
  /** Bind host, default 127.0.0.1 (same-container loopback only). */
  readonly host?: string
  /** Bind port, default 0 (ephemeral). */
  readonly port?: number
  /** Upstream request timeout in milliseconds, default 120000. */
  readonly upstreamTimeoutMs?: number
  /** PEM of an extra CA trusted for the upstream TLS handshake (self-hosted gateways). */
  readonly trustedCaPem?: string
  /** Request body size ceiling in bytes, default 1 MiB. */
  readonly maxBodyBytes?: number
}

export interface UsageCounts {
  readonly promptTokens: number | undefined
  readonly completionTokens: number | undefined
  readonly totalTokens: number | undefined
}

export interface UsageRecord {
  readonly at: string
  readonly kind: 'chat-completions' | 'messages' | 'models-probe' | 'refused'
  readonly status: number
  readonly model: string | undefined
  readonly promptTokens: number | undefined
  readonly completionTokens: number | undefined
  readonly totalTokens: number | undefined
  readonly reason: string | undefined
}

export interface UsageReport {
  /** Completed chat-completions calls (refusals and probes excluded). */
  readonly calls: number
  readonly promptTokens: number
  readonly completionTokens: number
  readonly totalTokens: number
  /** Completed calls whose response carried no parsable usage object. */
  readonly usageUnknownCalls: number
  /** Set when a hard cap refused a request; the reason stays latched. */
  readonly cappedReason: string | undefined
  readonly records: readonly UsageRecord[]
}

export interface LlmBroker {
  readonly port: number
  readonly baseUrl: string
  readonly report: () => UsageReport
  readonly stop: () => Promise<void>
}

const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
/** Bound on the TCP/TLS/CONNECT setup phase, independent of the request timeout. */
const CONNECT_PHASE_TIMEOUT_MS = 15_000

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Usage from a non-streaming OpenAI-compatible JSON response, if present. */
export function extractUsageFromJson(bodyText: string): UsageCounts | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return undefined
  }
  return usageFromParsedJson(parsed)
}

function usageFromParsedJson(parsed: unknown): UsageCounts | undefined {
  if (parsed === null || typeof parsed !== 'object') return undefined
  const usage = (parsed as { usage?: unknown }).usage
  if (usage === null || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>
  const promptTokens = positiveNumber(u.prompt_tokens)
  const completionTokens = positiveNumber(u.completion_tokens)
  const totalTokens = positiveNumber(u.total_tokens)
  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) return undefined
  return { promptTokens, completionTokens, totalTokens }
}

/**
 * Usage from a Messages-protocol (Anthropic-style) JSON response:
 * `{usage: {input_tokens, output_tokens}}`. Both snake_case fields and the
 * OpenAI-style aliases are accepted.
 */
export function extractUsageFromMessagesJson(bodyText: string): UsageCounts | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return undefined
  }
  const direct = usageFromParsedJson(parsed)
  if (direct !== undefined && (direct.promptTokens !== undefined || direct.completionTokens !== undefined)) return direct
  if (parsed === null || typeof parsed !== 'object') return undefined
  const usage = (parsed as { usage?: unknown }).usage
  if (usage === null || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>
  const promptTokens = positiveNumber(u.input_tokens)
  const completionTokens = positiveNumber(u.output_tokens)
  if (promptTokens === undefined && completionTokens === undefined) return undefined
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined,
  }
}

/**
 * Usage from an SSE chat-completions stream: the chunk carrying a `usage`
 * object (emitted last when stream_options.include_usage is on). The last
 * usage-bearing chunk wins.
 */
export function extractUsageFromSse(bodyText: string): UsageCounts | undefined {
  let found: UsageCounts | undefined
  for (const line of bodyText.split('\n')) {
    const match = /^data: (.+)$/.exec(line)
    if (match === null || match[1] === '[DONE]') continue
    const candidate = extractUsageFromJson(match[1])
    if (candidate !== undefined) found = candidate
  }
  return found
}

/**
 * Usage from a Messages-protocol SSE stream: `message_start` carries
 * `usage.input_tokens`, `message_delta` carries `usage.output_tokens`; the
 * last observed value per field wins (both may also nest under `message`).
 */
export function extractUsageFromMessagesSse(bodyText: string): UsageCounts | undefined {
  let promptTokens: number | undefined
  let completionTokens: number | undefined
  for (const line of bodyText.split('\n')) {
    const match = /^data: (.+)$/.exec(line)
    if (match === null || match[1] === '[DONE]') continue
    let event: unknown
    try {
      event = JSON.parse(match[1])
    } catch {
      continue
    }
    if (event === null || typeof event !== 'object') continue
    const record = event as { usage?: unknown; message?: { usage?: unknown } }
    const usage = record.usage ?? record.message?.usage
    if (usage === null || typeof usage !== 'object') continue
    const u = usage as Record<string, unknown>
    const input = positiveNumber(u.input_tokens)
    const output = positiveNumber(u.output_tokens)
    if (input !== undefined) promptTokens = input
    if (output !== undefined) completionTokens = output
  }
  if (promptTokens === undefined && completionTokens === undefined) return undefined
  return { promptTokens, completionTokens, totalTokens: promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined }
}

/**
 * Rewrite a chat-completions body so streaming responses carry usage: when
 * `stream` is true, force stream_options.include_usage. Returns the original
 * text untouched in every other case (including unparsable bodies).
 */
export function ensureStreamUsageOption(bodyText: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return bodyText
  }
  if (parsed === null || typeof parsed !== 'object') return bodyText
  const body = parsed as { stream?: unknown; stream_options?: Record<string, unknown> }
  if (body.stream !== true) return bodyText
  const options = { ...(body.stream_options ?? {}), include_usage: true }
  return JSON.stringify({ ...body, stream_options: options })
}

/** Which hard cap (if any) refuses the next call, given current state. */
export function capViolation(
  caps: UsageCaps,
  state: { calls: number; totalTokens: number },
  elapsedMs: number,
): string | undefined {
  if (state.calls >= caps.maxCalls) return 'max-calls'
  if (state.totalTokens >= caps.maxTotalTokens) return 'max-tokens'
  if (elapsedMs >= caps.wallClockMs) return 'wall-clock'
  return undefined
}

/** Rendering for thrown/errored values of any shape (Errors carry a message). */
export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Parse a request target, or undefined when it is not a parsable URL. */
export function parseRequestUrl(rawUrl: string): URL | undefined {
  try {
    return new URL(rawUrl, 'http://hourglass-broker.local')
  } catch {
    return undefined
  }
}

/** Upstream port, applying the protocol default when the URL carries none. */
export function portOf(target: URL): number {
  if (target.port !== '') return Number(target.port)
  return target.protocol === 'https:' ? 443 : 80
}

/** CONNECT tunnel through a forward proxy, byte-transparent. */
function connectThroughProxy(proxyUrl: string, target: URL, connectTimeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const proxy = new URL(proxyUrl)
    const socket = netConnect({ host: proxy.hostname, port: Number(proxy.port) || 80 })
    // The whole setup phase — TCP connect, CONNECT exchange — is bounded: a
    // proxy or firewall that accepts the connection but stays silent must not
    // hang the broker (the wall-clock cap only re-checks at admission).
    const deadline = setTimeout(() => {
      socket.destroy()
      reject(new Error(`proxy connect phase timed out after ${connectTimeoutMs}ms`))
    }, connectTimeoutMs)
    const fail = (reason: string): void => {
      clearTimeout(deadline)
      socket.destroy()
      reject(new Error(reason))
    }
    socket.on('error', error => fail(`proxy connection failed: ${errorDetail(error)}`))
    // The CONNECT reply may span several TCP segments: buffer until the
    // blank line, then hand back anything past it as tunnel payload.
    let head = ''
    const onData = (chunk: Buffer): void => {
      head += chunk.toString('latin1')
      if (!/^HTTP\/1\.[01] 200/.test(head)) {
        socket.off('data', onData)
        fail(`proxy CONNECT refused: ${head.split('\r\n')[0]}`)
        return
      }
      const separator = head.indexOf('\r\n\r\n')
      if (separator < 0) {
        if (head.length > 16 * 1024) {
          socket.off('data', onData)
          fail('proxy CONNECT reply head exceeded 16KiB without a blank line')
        }
        return
      }
      socket.off('data', onData)
      clearTimeout(deadline)
      const leftover = chunk.subarray(chunk.length - (head.length - separator - 4))
      if (leftover.length > 0) socket.unshift(leftover)
      resolve(socket)
    }
    socket.on('data', onData)
    socket.write(`CONNECT ${target.hostname}:${portOf(target)} HTTP/1.1\r\nHost: ${target.hostname}:${portOf(target)}\r\n\r\n`)
  })
}

/**
 * Transport for one upstream request: a ready socket for EVERY shape (plain
 * direct HTTP included — node's request-timeout does not bound the connect
 * phase, so a black-holed upstream would hang the broker). Possibly TLS over
 * a CONNECT tunnel. The whole setup phase is bounded by `connectTimeoutMs`.
 */
type UpstreamTransport = (target: URL, proxyUrl: string | undefined, connectTimeoutMs: number, trustedCaPem: string | undefined) => Promise<Socket>

async function openUpstreamPlain(target: URL, proxyUrl: string | undefined, connectTimeoutMs: number, _trustedCaPem: string | undefined): Promise<Socket> {
  if (proxyUrl !== undefined) return connectThroughProxy(proxyUrl, target, connectTimeoutMs)
  return new Promise<Socket>((resolve, reject) => {
    const socket = netConnect({ host: target.hostname, port: portOf(target) })
    const deadline = setTimeout(() => {
      socket.destroy()
      reject(new Error(`upstream connect timed out after ${connectTimeoutMs}ms`))
    }, connectTimeoutMs)
    socket.on('connect', () => {
      clearTimeout(deadline)
      resolve(socket)
    })
    socket.on('error', error => {
      clearTimeout(deadline)
      reject(new Error(`upstream connection failed: ${errorDetail(error)}`))
    })
  })
}

async function openUpstreamTls(target: URL, proxyUrl: string | undefined, connectTimeoutMs: number, trustedCaPem: string | undefined): Promise<Socket> {
  const raw = await openUpstreamPlain(target, proxyUrl, connectTimeoutMs, trustedCaPem)
  return tlsConnect({
    socket: raw,
    servername: target.hostname,
    rejectUnauthorized: true,
    handshakeTimeout: connectTimeoutMs,
    ...trustedCaPem === undefined ? {} : { ca: [trustedCaPem] },
  })
}

export function joinUpstreamPath(base: URL, pathname: string, search: string): string {
  const baseDir = base.pathname.replace(/\/+$/u, '')
  // The child may already carry the base's version prefix (the DSH adapter
  // posts /v1/messages against a base of .../v1): never concatenate it twice.
  if (baseDir === '' || pathname === baseDir || pathname.startsWith(`${baseDir}/`)) {
    return `${pathname}${search}`
  }
  return `${baseDir}${pathname}${search}`
}

/**
 * Start the broker. `usageLogPath` (optional) appends every record as JSONL —
 * same discipline as the sandbox-net egress decision log.
 */
export async function startLlmBroker(config: LlmBrokerConfig, usageLogPath?: string): Promise<LlmBroker> {
  const upstream = new URL(config.upstreamBaseUrl)
  const timeoutMs = config.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS
  // Picked once at startup: keeps the request hot path branch-free (both
  // sides of the pick are exercised across the http/https broker suites).
  const upstreamTransport: UpstreamTransport = upstream.protocol === 'https:' ? openUpstreamTls : openUpstreamPlain
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const startedAt = Date.now()
  let calls = 0
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0
  let usageUnknownCalls = 0
  let cappedReason: string | undefined
  const records: UsageRecord[] = []

  const record = (entry: UsageRecord): void => {
    records.push(entry)
    if (usageLogPath !== undefined) {
      try {
        appendFileSync(usageLogPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' })
      } catch {
        // In-memory copy still serves the report; a failing log file must not
        // weaken enforcement.
      }
    }
  }

  const refuse = (response: ServerResponse, status: number, reason: string, model: string | undefined): void => {
    record({ at: new Date().toISOString(), kind: 'refused', status, model, promptTokens: undefined, completionTokens: undefined, totalTokens: undefined, reason })
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(`${JSON.stringify({ error: { message: `hourglass broker: ${reason}`, type: 'hourglass-broker-refused' } })}\n`)
  }

  const forward = (
    response: ServerResponse,
    method: string,
    pathname: string,
    search: string,
    headers: Record<string, string>,
    body: Buffer | undefined,
    kind: 'chat-completions' | 'messages' | 'models-probe',
    model: string | undefined,
    onDone: (upstreamStatus: number, usage: UsageCounts | undefined) => void,
  ): void => {
    void (async () => {
      let socket: Socket
      try {
        socket = await upstreamTransport(upstream, config.proxyUrl, Math.min(timeoutMs, CONNECT_PHASE_TIMEOUT_MS), config.trustedCaPem)
      } catch (error) {
        const reason = errorDetail(error)
        record({ at: new Date().toISOString(), kind: 'refused', status: 502, model, promptTokens: undefined, completionTokens: undefined, totalTokens: undefined, reason })
        response.writeHead(502, { 'content-type': 'application/json' })
        response.end(`${JSON.stringify({ error: { message: `hourglass broker: upstream connection failed: ${reason}`, type: 'hourglass-broker-upstream' } })}\n`)
        return
      }
      const forwardPath = joinUpstreamPath(upstream, pathname, search)
      // createConnection supplies the (already connected) transport while
      // host/port keep node's default Host header truthful for the upstream
      // vhost (a socket-only options object would send Host: localhost and a
      // real provider answers 403).
      const options = { host: upstream.hostname, port: portOf(upstream), createConnection: () => socket, method, path: forwardPath, headers }
      const upstreamRequest = httpRequest(options, upstreamRes => {
        // node delivers ClientResponse only after status line + headers, so
        // statusCode is always present here; the cast keeps the coverage gate
        // free of an unreachable undefined branch.
        const statusCode = upstreamRes.statusCode as number
        const chunks: Buffer[] = []
        upstreamRes.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
        })
        response.writeHead(statusCode, upstreamRes.headers)
        upstreamRes.pipe(response)
        upstreamRes.on('end', () => {
          const contentType = String(upstreamRes.headers['content-type'] ?? '')
          const text = Buffer.concat(chunks).toString('utf8')
          let usage: UsageCounts | undefined
          if (contentType.includes('text/event-stream')) {
            usage = kind === 'messages' ? extractUsageFromMessagesSse(text) : extractUsageFromSse(text)
          } else {
            usage = kind === 'messages' ? extractUsageFromMessagesJson(text) : extractUsageFromJson(text)
          }
          onDone(statusCode, usage)
        })
      })
      upstreamRequest.setTimeout(timeoutMs, () => upstreamRequest.destroy(new Error('upstream timeout')))
      upstreamRequest.on('error', error => {
        const detail = errorDetail(error)
        if (response.headersSent) {
          response.destroy()
          onDone(502, undefined)
          return
        }
        record({ at: new Date().toISOString(), kind: 'refused', status: 502, model, promptTokens: undefined, completionTokens: undefined, totalTokens: undefined, reason: `upstream request failed: ${detail}` })
        response.writeHead(502, { 'content-type': 'application/json' })
        response.end(`${JSON.stringify({ error: { message: `hourglass broker: upstream request failed: ${detail}`, type: 'hourglass-broker-upstream' } })}\n`)
      })
      response.on('close', () => upstreamRequest.destroy())
      if (body !== undefined) upstreamRequest.end(body)
      else upstreamRequest.end()
    })()
  }

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    // An unparsable target (e.g. an out-of-range port in absolute form) must
    // be refused, never crash the broker — it is the chokepoint for an
    // untrusted child.
    const incoming = parseRequestUrl(`${request.url}`)
    const isChat = request.method === 'POST' && incoming !== undefined && /\/chat\/completions$/.test(incoming.pathname)
    // The DSH DeepSeek adapter speaks the Messages protocol (Anthropic-style
    // /v1/messages), not OpenAI chat-completions; the broker forwards both.
    const isMessages = request.method === 'POST' && incoming !== undefined && /\/(v1\/)?messages$/.test(incoming.pathname)
    const isModels = request.method === 'GET' && incoming !== undefined && /\/models$/.test(incoming.pathname)
    const chunks: Buffer[] = []
    let bodyBytes = 0
    request.on('data', (chunk: Buffer) => {
      bodyBytes += chunk.length
      if (bodyBytes <= maxBodyBytes) chunks.push(chunk)
    })
    request.on('end', () => {
      if (bodyBytes > maxBodyBytes) {
        refuse(response, 413, `request body exceeds ${maxBodyBytes} bytes`, undefined)
        return
      }
      if (incoming === undefined || (!isChat && !isMessages && !isModels)) {
        refuse(response, 403, `path not allowed: ${request.method} ${incoming?.pathname ?? `${request.url}`}`, undefined)
        return
      }
      if (isModels) {
        const headers = sanitizeHeaders(request.headers)
        applyCredential(headers, config)
        // Capture the record's index at push time: a concurrent completion
        // must not be overwritten by this probe's status patch.
        const probeIndex = records.length
        record({ at: new Date().toISOString(), kind: 'models-probe', status: 0, model: undefined, promptTokens: undefined, completionTokens: undefined, totalTokens: undefined, reason: undefined })
        forward(response, 'GET', incoming.pathname, incoming.search, headers, undefined, 'models-probe', undefined, (status, _usage) => {
          records[probeIndex] = { ...records[probeIndex], status }
        })
        return
      }
      const rawBody = Buffer.concat(chunks).toString('utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(rawBody)
      } catch {
        refuse(response, 400, 'request body is not JSON', undefined)
        return
      }
      const body = parsed === null || typeof parsed !== 'object' ? undefined : parsed as { model?: unknown }
      if (body === undefined || typeof body.model !== 'string' || body.model === '') {
        refuse(response, 400, 'request body must carry a string model', undefined)
        return
      }
      const model = body.model
      if (!config.modelAllowlist.includes(model)) {
        refuse(response, 403, `model not allowlisted: ${model}`, model)
        return
      }
      const violation = capViolation(config.caps, { calls, totalTokens }, Date.now() - startedAt)
      if (violation !== undefined) {
        if (cappedReason === undefined) cappedReason = violation
        refuse(response, 429, `hard cap reached: ${violation}`, model)
        return
      }
      const headers = sanitizeHeaders(request.headers)
      headers['content-type'] = String(request.headers['content-type'] ?? 'application/json')
      applyCredential(headers, config)
      // stream_options.include_usage is an OpenAI-completions field; Messages
      // bodies pass through untouched.
      const outbound = Buffer.from(isChat ? ensureStreamUsageOption(rawBody) : rawBody, 'utf8')
      calls += 1
      forward(response, 'POST', incoming.pathname, incoming.search, headers, outbound, isChat ? 'chat-completions' : 'messages', model, (status, usage) => {
        if (usage === undefined) usageUnknownCalls += 1
        if (usage !== undefined) {
          if (usage.promptTokens !== undefined) promptTokens += usage.promptTokens
          if (usage.completionTokens !== undefined) completionTokens += usage.completionTokens
          // Fail-closed budget: providers that omit total_tokens must not
          // leave the cap at zero forever — derive it from the parts (a
          // present usage object always carries at least one field).
          totalTokens += usage.totalTokens ?? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)
        }
        record({ at: new Date().toISOString(), kind: isChat ? 'chat-completions' : 'messages', status, model, promptTokens: usage?.promptTokens, completionTokens: usage?.completionTokens, totalTokens: usage?.totalTokens, reason: undefined })
      })
    })
  })

  const host = config.host ?? '127.0.0.1'
  await new Promise<void>((resolve, reject) => {
    // A taken port or invalid host must reject the start call, never escape
    // as an unhandled 'error' event that kills the host process.
    server.once('error', reject) // node always hands an Error here
    server.listen(config.port ?? 0, host, () => resolve())
  })
  // A TCP listen that resolved always yields an AddressInfo; the cast keeps
  // the coverage gate free of an unreachable unix-socket branch.
  const address = server.address() as { port: number }
  return {
    port: address.port,
    baseUrl: `http://${host}:${address.port}`,
    report: () => ({
      calls,
      promptTokens,
      completionTokens,
      totalTokens,
      usageUnknownCalls,
      cappedReason,
      records: [...records],
    }),
    stop: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close(error => (error === undefined ? resolve() : reject(error)))
    }),
  }
}

function sanitizeHeaders(requestHeaders: IncomingMessage['headers']): Record<string, string> {
  const headers: Record<string, string> = {}
  // Node delivers received request headers as string values (duplicates are
  // already comma-joined at the parser), so a plain string cast is exact.
  const source = requestHeaders as Record<string, string>
  for (const [key, value] of Object.entries(source)) {
    if (key === 'authorization' || key === 'x-api-key' || key === 'host' || key === 'connection' || key === 'proxy-connection' || key === 'content-length' || key === 'transfer-encoding' || key === 'accept-encoding') continue
    headers[key] = value
  }
  // The tee-side usage parser reads plain UTF-8: compression would turn every
  // response into usage-unknown and silently disable the token cap, so the
  // broker never negotiates content codings with the upstream.
  headers['accept-encoding'] = 'identity'
  return headers
}

function applyCredential(headers: Record<string, string>, config: LlmBrokerConfig): void {
  if (config.apiKey !== undefined && config.apiKey !== '') headers.authorization = `Bearer ${config.apiKey}`
}
