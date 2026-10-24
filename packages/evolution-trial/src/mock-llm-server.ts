/**
 * Scripted OpenAI-compatible chat-completions upstream for tests and for the
 * zero-real-model discipline of the agent lane (ADR-004 D2): a DSH child's
 * model route points at the broker, the broker forwards here, and every
 * carrier/metering/cap behavior is exercised without a real provider. Speaks
 * both plain JSON and SSE (with the trailing usage chunk when the request
 * asks for it via stream_options.include_usage), records every request for
 * assertions, and can be told to misbehave (hang, drop mid-stream) so broker
 * failure paths stay covered without network tricks.
 *
 * @module @hourglass/evolution-trial
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export interface ScriptedResponse {
  readonly content: string
  readonly promptTokens?: number
  readonly completionTokens?: number
  /** Verbatim usage object (overrides the built one) for partial-usage tests. */
  readonly rawUsage?: Record<string, unknown>
}

export interface MockLlmConfig {
  /** Responses served in order; exhausting the script answers 500. */
  readonly scripted: readonly ScriptedResponse[]
  /** When set, requests must carry exactly this Authorization header. */
  readonly requireAuthorization?: string
  /** When set, requests with any other model id are answered 400. */
  readonly allowModel?: string
  /** Omit usage from responses (broker must count usage-unknown calls). */
  readonly omitUsage?: boolean
  /** Answer without a content-type header (broker must still parse JSON). */
  readonly noContentType?: boolean
}

export interface MockLlmRequest {
  readonly at: string
  readonly model: string
  readonly nMessages: number
  readonly stream: boolean
  readonly includeUsage: boolean
  readonly authorization: string | undefined
  readonly acceptEncoding: string | undefined
  readonly mockHang: boolean
  readonly mockDropStream: boolean
  readonly mockStreamThenHang: boolean
}

export interface MockLlmServer {
  readonly port: number
  readonly baseUrl: string
  readonly requests: readonly MockLlmRequest[]
  readonly stop: () => Promise<void>
}

export async function startMockLlmServer(config: MockLlmConfig, port = 0): Promise<MockLlmServer> {
  const requests: MockLlmRequest[] = []
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      // Template-string coercion (not ??): an undefined url becomes the
      // literal 'undefined' and falls into the unknown-path 404 — same
      // outcome, no unreachable branch for the coverage gate.
      const url = `${request.url}`
      if (request.method === 'GET' && /\/models$/.test(url)) {
        const models = config.allowModel === undefined ? [] : [{ id: config.allowModel, object: 'model' }]
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(`${JSON.stringify({ object: 'list', data: models })}\n`)
        return
      }
      if (request.method !== 'POST' || !/\/chat\/completions$/.test(url)) {
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end('mock llm: unknown path\n')
        return
      }
      let parsed: {
        model?: unknown
        messages?: unknown
        stream?: unknown
        stream_options?: { include_usage?: unknown }
        mockHang?: unknown
        mockDropStream?: unknown
        mockStreamThenHang?: unknown
      }
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(`${JSON.stringify({ error: { message: 'mock llm: body is not JSON' } })}\n`)
        return
      }
      const authorization = request.headers.authorization
      if (config.requireAuthorization !== undefined && authorization !== config.requireAuthorization) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(`${JSON.stringify({ error: { message: `mock llm: expected authorization ${config.requireAuthorization}` } })}\n`)
        return
      }
      const model = typeof parsed.model === 'string' ? parsed.model : '(missing)'
      if (config.allowModel !== undefined && model !== config.allowModel) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(`${JSON.stringify({ error: { message: `mock llm: model not allowed: ${model}` } })}\n`)
        return
      }
      const streamOptions = parsed.stream_options === null || typeof parsed.stream_options !== 'object' ? {} : parsed.stream_options
      const entry: MockLlmRequest = {
        at: new Date().toISOString(),
        model,
        nMessages: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
        stream: parsed.stream === true,
        includeUsage: streamOptions.include_usage === true,
        authorization,
        acceptEncoding: request.headers['accept-encoding'],
        mockHang: parsed.mockHang === true,
        mockDropStream: parsed.mockDropStream === true,
        mockStreamThenHang: parsed.mockStreamThenHang === true,
      }
      requests.push(entry)
      const served = requests.filter(item => !item.mockHang).length
      if (parsed.mockHang === true) return // never answer: broker timeout path
      const scripted = config.scripted[served - 1]
      if (scripted === undefined) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(`${JSON.stringify({ error: { message: `mock llm: script exhausted at ${served}` } })}\n`)
        return
      }
      // Partial usage shapes are legal: only the scripted fields are reported.
      const usage = config.omitUsage === true
        ? undefined
        : (scripted.rawUsage ?? {
          ...(scripted.promptTokens === undefined ? {} : { prompt_tokens: scripted.promptTokens }),
          ...(scripted.completionTokens === undefined ? {} : { completion_tokens: scripted.completionTokens }),
          total_tokens: (scripted.promptTokens ?? 0) + (scripted.completionTokens ?? 0),
        })
      if (entry.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const chunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
        const base = { id: 'mock-chatcmpl-1', object: 'chat.completion.chunk', model }
        response.write(chunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }))
        response.write(chunk({ ...base, choices: [{ index: 0, delta: { content: scripted.content } }] }))
        response.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
        if (entry.mockDropStream) {
          response.write(chunk({ ...base, choices: [{ index: 0, delta: { content: 'about-to-' } }] }))
          response.destroy()
          return
        }
        if (usage !== undefined) response.write(chunk({ ...base, choices: [], usage }))
        if (entry.mockStreamThenHang) return // headers sent, body never ends
        response.end('data: [DONE]\n\n')
        return
      }
      const headers = config.noContentType === true ? {} : { 'content-type': 'application/json' }
      response.writeHead(200, headers)
      response.end(`${JSON.stringify({
        id: 'mock-chatcmpl-1',
        object: 'chat.completion',
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: scripted.content }, finish_reason: 'stop' }],
        ...(usage === undefined ? {} : { usage }),
      })}\n`)
    })
  })
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
  // A TCP listen that resolved always yields an AddressInfo; the cast keeps
  // the coverage gate free of an unreachable unix-socket branch.
  const address = server.address() as { port: number }
  return {
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    get requests() {
      return requests
    },
    stop: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close(error => (error === undefined ? resolve() : reject(error)))
    }),
  }
}
