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
  /**
   * Answer with a function call instead of plain text: the deterministic way
   * to drive a real agent loop (and its confinement pipeline) without a real
   * model. Targets the first tool whose name matches `toolNamePattern`
   * (default /bash|shell|exec|command/i); `firstStringArg` fills the
   * argument property `pickArgumentProperty` selects from that tool's schema.
   */
  readonly callFirstTool?: { readonly firstStringArg: string; readonly toolNamePattern?: RegExp }
}

/**
 * The argument property a scripted tool call fills: `command` when the schema
 * offers it, else the first string-typed property, else the first property of
 * any type, else `input` as a last resort.
 */
export function pickArgumentProperty(parameters: unknown): string {
  if (parameters === null || typeof parameters !== 'object') return 'input'
  const properties = (parameters as { properties?: unknown }).properties
  if (properties === null || typeof properties !== 'object') return 'input'
  const entries = Object.entries(properties as Record<string, unknown>)
  const byName = entries.find(([key]) => key === 'command')
  if (byName !== undefined) return byName[0]
  const stringTyped = entries.find(([, value]) => {
    if (value === null || typeof value !== 'object') return false
    return (value as { type?: unknown }).type === 'string'
  })
  if (stringTyped !== undefined) return stringTyped[0]
  return entries[0]?.[0] ?? 'input'
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
  readonly nTools: number
  readonly toolNames: readonly string[]
  /** First tool's raw parameters schema (debugging carrier arg shapes). */
  readonly firstToolParameters: unknown
  /** Concatenated message/system text (capped) for content assertions. */
  readonly messageText: string
  readonly stream: boolean
  readonly includeUsage: boolean
  readonly authorization: string | undefined
  readonly acceptEncoding: string | undefined
  /** Received Host header (transport truthfulness assertions). */
  readonly host: string | undefined
  readonly mockHang: boolean
  readonly mockDropStream: boolean
  readonly mockStreamThenHang: boolean
}

export interface MockLlmServer {
  readonly port: number
  readonly baseUrl: string
  readonly requests: readonly MockLlmRequest[]
  /** Replace the scripted response sequence (drives multi-phase scenarios). */
  readonly resetScript: (scripted: readonly ScriptedResponse[]) => void
  readonly stop: () => Promise<void>
}

/** The first tool matching the scripted pattern, defaulting to a shell-ish name. */
function selectTool(
  tools: { name: string; parameters: unknown }[],
  pattern: RegExp | undefined,
): { name: string; parameters: unknown } | undefined {
  if (pattern !== undefined) return tools.find(tool => pattern.test(tool.name))
  return tools.find(tool => /bash|shell|exec|command/i.test(tool.name))
}

/**
 * Build a tool-call argument object that satisfies the tool's schema: the
 * selected string property carries `firstStringArg`, and every OTHER
 * required string property (e.g. DSH bash's `description`) gets a canned
 * filler — real agent loops validate arguments before dispatch.
 */
export function buildToolArguments(parameters: unknown, argumentProperty: string, firstStringArg: string): Record<string, string> {
  const args: Record<string, string> = { [argumentProperty]: firstStringArg }
  const schema = parameters === null || typeof parameters !== 'object' ? {} : parameters as { required?: unknown; properties?: Record<string, unknown> }
  const required = Array.isArray(schema.required) ? schema.required : []
  const properties = schema.properties ?? {}
  for (const name of required) {
    if (typeof name !== 'string' || name === argumentProperty || name in args) continue
    const prop = properties[name]
    const type = prop === null || typeof prop !== 'object' ? undefined : (prop as { type?: unknown }).type
    if (type === 'string') args[name] = `hourglass carrier ${name}`
  }
  return args
}

/** One Messages-protocol answer: text or a scripted tool_use block. */
function respondMessages(
  scripted: ScriptedResponse,
  entry: MockLlmRequest,
  tools: { name: string; parameters: unknown }[],
  model: string,
  response: ServerResponse,
): void {
  const target = scripted.callFirstTool === undefined ? undefined : selectTool(tools, scripted.callFirstTool.toolNamePattern)
  const toolUse = target === undefined
    ? undefined
    : {
      name: target.name,
      input: buildToolArguments(target.parameters, pickArgumentProperty(target.parameters), scripted.callFirstTool!.firstStringArg),
    }
  if (scripted.callFirstTool !== undefined && toolUse === undefined) {
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(`${JSON.stringify({ type: 'error', error: { message: 'mock llm: callFirstTool scripted but the request carried no tools' } })}\n`)
    return
  }
  if (entry.stream) {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    // data-only framing (no `event:` lines) — byte-compatible with the DSH
    // llm-deepseek adapter's SSE parser, per its own wire fixtures.
    const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
    response.write(frame({
      type: 'message_start',
      message: { id: 'msg_mock_1', model, ...(scripted.promptTokens === undefined ? {} : { usage: { input_tokens: scripted.promptTokens, output_tokens: 0 } }) },
    }))
    if (toolUse !== undefined) {
      // content_block_start for tool_use must carry an `input` object — the
      // DSH translator runs object(native.input) at block start.
      response.write(frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_mock_1', name: toolUse.name, input: {} } }))
      response.write(frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolUse.input) } }))
    } else {
      response.write(frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      response.write(frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: scripted.content } }))
    }
    response.write(frame({ type: 'content_block_stop', index: 0 }))
    response.write(frame({
      type: 'message_delta',
      delta: { stop_reason: toolUse === undefined ? 'end_turn' : 'tool_use' },
      ...(scripted.completionTokens === undefined ? {} : { usage: { output_tokens: scripted.completionTokens } }),
    }))
    response.write(frame({ type: 'message_stop' }))
    response.end()
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(`${JSON.stringify({
    id: 'msg_mock_1',
    type: 'message',
    role: 'assistant',
    model,
    content: [toolUse === undefined
      ? { type: 'text', text: scripted.content }
      : { type: 'tool_use', id: 'toolu_mock_1', name: toolUse.name, input: toolUse.input }],
    stop_reason: toolUse === undefined ? 'end_turn' : 'tool_use',
    ...(scripted.promptTokens === undefined && scripted.completionTokens === undefined
      ? {}
      : { usage: { input_tokens: scripted.promptTokens ?? 0, output_tokens: scripted.completionTokens ?? 0 } }),
  })}\n`)
}

export async function startMockLlmServer(config: MockLlmConfig, port = 0): Promise<MockLlmServer> {
  const requests: MockLlmRequest[] = []
  let script: ScriptedResponse[] = [...config.scripted]
  // Requests served since the last resetScript: the script position is per
  // script, not per server lifetime.
  let servedBase = 0
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      // Template-string coercion (not ??): an undefined url becomes the
      // literal 'undefined' and falls into the unknown-path 404 — same
      // outcome, no unreachable branch for the coverage gate.
      const url = `${request.url}`
      const isMessages = request.method === 'POST' && /\/(v1\/)?messages$/.test(url)
      if (request.method === 'GET' && /\/models$/.test(url)) {
        const models = config.allowModel === undefined ? [] : [{ id: config.allowModel, object: 'model' }]
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(`${JSON.stringify({ object: 'list', data: models })}\n`)
        return
      }
      if (!isMessages && (request.method !== 'POST' || !/\/chat\/completions$/.test(url))) {
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end('mock llm: unknown path\n')
        return
      }
      let parsed: {
        model?: unknown
        messages?: unknown
        system?: unknown
        tools?: unknown
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
      const tools = Array.isArray(parsed.tools)
        ? parsed.tools.map(tool => {
          if (tool === null || typeof tool !== 'object') return undefined
          // OpenAI completions carry {function:{name,parameters}}; the
          // Messages protocol carries {name, input_schema} directly.
          const direct = (tool as { name?: unknown; input_schema?: unknown }).name
          const fn = (tool as { function?: { name?: unknown; parameters?: unknown } }).function
          if (fn !== null && typeof fn === 'object') {
            return { name: typeof fn.name === 'string' ? fn.name : '(unnamed)', parameters: fn.parameters }
          }
          if (typeof direct === 'string') {
            return { name: direct, parameters: (tool as { input_schema?: unknown }).input_schema }
          }
          return undefined
        })
        : []
      const toolNames = tools.map(tool => tool?.name ?? '(unnamed)')
      const entry: MockLlmRequest = {
        at: new Date().toISOString(),
        model,
        nMessages: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
        nTools: tools.length,
        toolNames,
        firstToolParameters: tools[0]?.parameters,
        // Messages-protocol skills ride the `system` field; content blocks
        // are objects, so JSON-stringify rather than String-coerce.
        messageText: `${JSON.stringify(parsed.messages ?? [])} ${JSON.stringify(parsed.system ?? '')}`.slice(0, 120000),
        stream: parsed.stream === true,
        includeUsage: streamOptions.include_usage === true,
        authorization,
        acceptEncoding: request.headers['accept-encoding'],
        host: request.headers.host,
        mockHang: parsed.mockHang === true,
        mockDropStream: parsed.mockDropStream === true,
        mockStreamThenHang: parsed.mockStreamThenHang === true,
      }
      requests.push(entry)
      const served = requests.slice(servedBase).filter(item => !item.mockHang).length
      if (parsed.mockHang === true) return // never answer: broker timeout path
      const scripted = script[served - 1]
      if (scripted === undefined) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(`${JSON.stringify({ error: { message: `mock llm: script exhausted at ${served}` } })}\n`)
        return
      }
      if (isMessages) return respondMessages(scripted, entry, tools, model, response)
      // Partial usage shapes are legal: only the scripted fields are reported.
      const usage = config.omitUsage === true
        ? undefined
        : (scripted.rawUsage ?? {
          ...(scripted.promptTokens === undefined ? {} : { prompt_tokens: scripted.promptTokens }),
          ...(scripted.completionTokens === undefined ? {} : { completion_tokens: scripted.completionTokens }),
          total_tokens: (scripted.promptTokens ?? 0) + (scripted.completionTokens ?? 0),
        })
      const completionsTarget = scripted.callFirstTool === undefined ? undefined : selectTool(tools, scripted.callFirstTool.toolNamePattern)
      const toolCall = completionsTarget === undefined
        ? undefined
        : {
          name: completionsTarget.name,
          arguments: JSON.stringify(buildToolArguments(completionsTarget.parameters, pickArgumentProperty(completionsTarget.parameters), scripted.callFirstTool!.firstStringArg)),
        }
      if (scripted.callFirstTool !== undefined && toolCall === undefined) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(`${JSON.stringify({ error: { message: 'mock llm: callFirstTool scripted but the request carried no tools' } })}\n`)
        return
      }
      if (entry.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const chunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`
        const base = { id: 'mock-chatcmpl-1', object: 'chat.completion.chunk', model }
        response.write(chunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }))
        if (toolCall !== undefined) {
          response.write(chunk({
            ...base,
            choices: [{
              index: 0,
              delta: { tool_calls: [{ index: 0, id: 'mocktc-1', type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }] },
            }],
          }))
          response.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }))
        } else {
          response.write(chunk({ ...base, choices: [{ index: 0, delta: { content: scripted.content } }] }))
          response.write(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
        }
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
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: scripted.content,
            ...(toolCall === undefined ? {} : {
              tool_calls: [{ id: 'mocktc-1', type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }],
            }),
          },
          finish_reason: toolCall === undefined ? 'stop' : 'tool_calls',
        }],
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
    resetScript: (scripted: readonly ScriptedResponse[]) => {
      script = [...scripted]
      servedBase = requests.length
    },
    stop: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close(error => (error === undefined ? resolve() : reject(error)))
    }),
  }
}
