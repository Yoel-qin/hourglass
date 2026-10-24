import { connect as netConnect, createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { afterAll, describe, expect, it } from 'vitest'
import {
  capViolation,
  ensureStreamUsageOption,
  errorDetail,
  extractUsageFromJson,
  extractUsageFromMessagesJson,
  extractUsageFromMessagesSse,
  extractUsageFromSse,
  parseRequestUrl,
  portOf,
  startLlmBroker,
  type LlmBroker,
} from '../src/llm-broker.ts'
import { buildToolArguments, pickArgumentProperty, startMockLlmServer, type MockLlmServer } from '../src/mock-llm-server.ts'

interface FakeProxy {
  readonly port: number
  readonly tunneled: string[]
  readonly stop: () => Promise<void>
}

const stoppers: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const stop of stoppers) await stop()
})

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function startFakeProxy(mode: 'ok' | 'refuse' | 'pad' | 'split' | 'stall' | 'flood'): Promise<FakeProxy> {
  const tunneled: string[] = []
  const server: TcpServer = createTcpServer((socket: Socket) => {
    socket.once('data', (chunk: Buffer) => {
      const head = chunk.toString('latin1')
      const target = /^CONNECT ([^:]+):(\d+) HTTP/.exec(head)
      if (target !== null) tunneled.push(`${target[1]}:${target[2]}`)
      if (mode === 'refuse' || target === null) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.end()
        return
      }
      if (mode === 'stall') return // accept the CONNECT, never answer
      if (mode === 'flood') {
        // A 200 status line followed by >16KiB of header bytes with no blank
        // line: the head-cap guard must fail the tunnel instead of buffering
        // forever.
        socket.write(`HTTP/1.1 200 OK
-x: ${'A'.repeat(20_000)}`)
        return
      }
      if (mode === 'split') {
        // Reply head split across two TCP writes: exercises the buffering.
        socket.write('HTTP/1.1 200 Connection Established\r')
        setTimeout(() => socket.write('\n\r\n'), 30)
      } else {
        socket.write(mode === 'pad' ? 'HTTP/1.1 200 Connection Established\r\n\r\n\r\n' : 'HTTP/1.1 200 Connection Established\r\n\r\n')
      }
      const upstream = netConnect({ host: target[1], port: Number(target[2]) })
      upstream.pipe(socket)
      socket.pipe(upstream)
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const stop = (): Promise<void> => new Promise<void>((resolve, reject) => server.close(error => (error === undefined ? resolve() : reject(error))))
  stoppers.push(stop)
  return { port, tunneled, stop }
}

async function startBroker(overrides: Partial<Parameters<typeof startLlmBroker>[0]> = {}): Promise<LlmBroker> {
  const broker = await startLlmBroker({
    upstreamBaseUrl: 'http://127.0.0.1:9',
    modelAllowlist: ['test-model'],
    caps: { maxCalls: 100, maxTotalTokens: 1_000_000, wallClockMs: 600_000 },
    ...overrides,
  })
  stoppers.push(broker.stop)
  return broker
}

async function startMock(config: Parameters<typeof startMockLlmServer>[0]): Promise<MockLlmServer> {
  const mock = await startMockLlmServer(config)
  stoppers.push(mock.stop)
  return mock
}

async function post(broker: LlmBroker, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  const response = await fetch(`${broker.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: response.status, text: await response.text() }
}

describe('usage extraction pure helpers', () => {
  it('extractUsageFromJson reads the usage object and rejects malformed bodies', () => {
    expect(extractUsageFromJson('{"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}')).toEqual({
      promptTokens: 3,
      completionTokens: 5,
      totalTokens: 8,
    })
    expect(extractUsageFromJson('not json')).toBeUndefined()
    expect(extractUsageFromJson('42')).toBeUndefined()
    expect(extractUsageFromJson('null')).toBeUndefined()
    expect(extractUsageFromJson('{"choices":[]}')).toBeUndefined()
    expect(extractUsageFromJson('{"usage":{"prompt_tokens":"x"}}')).toBeUndefined()
    expect(extractUsageFromJson('{"usage":{"total_tokens":9}}')).toEqual({ promptTokens: undefined, completionTokens: undefined, totalTokens: 9 })
  })

  it('extractUsageFromSse keeps the last usage-bearing chunk and skips [DONE]', () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"a"}}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":9,"total_tokens":16}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    expect(extractUsageFromSse(sse)).toEqual({ promptTokens: 7, completionTokens: 9, totalTokens: 16 })
    expect(extractUsageFromSse('data: {"choices":[]}\n\ndata: [DONE]\n\n')).toBeUndefined()
  })

  it('ensureStreamUsageOption only rewrites streaming bodies', () => {
    const rewritten = ensureStreamUsageOption('{"model":"m","stream":true,"messages":[]}')
    expect(JSON.parse(rewritten).stream_options).toEqual({ include_usage: true })
    const preserved = ensureStreamUsageOption('{"model":"m","stream":true,"stream_options":{"other":1},"messages":[]}')
    expect(JSON.parse(preserved).stream_options).toEqual({ other: 1, include_usage: true })
    const untouched = ensureStreamUsageOption('{"model":"m","stream":false,"messages":[]}')
    expect(untouched).toBe('{"model":"m","stream":false,"messages":[]}')
    expect(ensureStreamUsageOption('broken')).toBe('broken')
    expect(ensureStreamUsageOption('42')).toBe('42')
  })

  it('capViolation names the first violated cap', () => {
    const caps = { maxCalls: 2, maxTotalTokens: 100, wallClockMs: 1000 }
    expect(capViolation(caps, { calls: 2, totalTokens: 0 }, 0)).toBe('max-calls')
    expect(capViolation(caps, { calls: 1, totalTokens: 100 }, 0)).toBe('max-tokens')
    expect(capViolation(caps, { calls: 0, totalTokens: 0 }, 1000)).toBe('wall-clock')
    expect(capViolation(caps, { calls: 1, totalTokens: 99 }, 999)).toBeUndefined()
  })

  it('portOf applies protocol defaults and errorDetail renders any thrown shape', () => {
    expect(portOf(new URL('https://api.example.com'))).toBe(443)
    expect(portOf(new URL('http://api.example.com'))).toBe(80)
    expect(portOf(new URL('http://127.0.0.1:8080'))).toBe(8080)
    expect(errorDetail(new Error('boom'))).toBe('boom')
    expect(errorDetail('plain-string')).toBe('plain-string')
  })
})

describe('llm broker (loopback mock upstream)', () => {
  it('injects the host credential and strips whatever the child sent', async () => {
    const mock = await startMock({
      scripted: [{ content: 'ok', promptTokens: 2, completionTokens: 3 }],
      requireAuthorization: 'Bearer host-secret',
      allowModel: 'test-model',
    })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl, apiKey: 'host-secret' })
    const result = await post(broker, '/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] }, { authorization: 'Bearer child-should-not-leak' })
    expect(result.status).toBe(200)
    expect(JSON.parse(result.text).choices[0].message.content).toBe('ok')
    expect(mock.requests[0].authorization).toBe('Bearer host-secret')
    expect(broker.report()).toMatchObject({ calls: 1, promptTokens: 2, completionTokens: 3, totalTokens: 5, usageUnknownCalls: 0 })
  })

  it('meters usage from an SSE stream and injects stream_options.include_usage', async () => {
    const mock = await startMock({ scripted: [{ content: 'streamed', promptTokens: 11, completionTokens: 13 }] })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl })
    const result = await post(broker, '/chat/completions', { model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    expect(result.status).toBe(200)
    expect(result.text).toContain('streamed')
    expect(result.text).toContain('[DONE]')
    expect(mock.requests[0].includeUsage).toBe(true)
    expect(broker.report()).toMatchObject({ calls: 1, totalTokens: 24, usageUnknownCalls: 0 })
  })

  it('counts usage-unknown calls when the upstream omits usage', async () => {
    const mock = await startMock({ scripted: [{ content: 'opaque' }, { content: 'opaque-stream' }], omitUsage: true })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl })
    const plain = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    expect(plain.status).toBe(200)
    const streamed = await post(broker, '/chat/completions', { model: 'test-model', stream: true, messages: [] })
    expect(streamed.status).toBe(200)
    expect(broker.report()).toMatchObject({ calls: 2, totalTokens: 0, usageUnknownCalls: 2 })
  })

  it('aggregates raw partial usage objects that lack fields', async () => {
    const mock = await startMock({
      scripted: [
        { content: 'raw1', rawUsage: { prompt_tokens: 3 } },
        { content: 'raw2', rawUsage: { completion_tokens: 4 } },
      ],
    })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl })
    const first = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    const second = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(broker.report()).toMatchObject({ calls: 2, promptTokens: 3, completionTokens: 4, totalTokens: 0, usageUnknownCalls: 0 })
  })

  it('refuses non-allowlisted models and unknown paths before touching the upstream', async () => {
    const mock = await startMock({ scripted: [{ content: 'never' }] })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl })
    const badModel = await post(broker, '/chat/completions', { model: 'evil-model', messages: [] })
    expect(badModel.status).toBe(403)
    expect(badModel.text).toContain('model not allowlisted')
    const badPath = await post(broker, '/v1/embeddings', { model: 'test-model' })
    expect(badPath.status).toBe(403)
    const badBody = await fetch(`${broker.baseUrl}/chat/completions`, { method: 'PUT', body: '{}' })
    expect(badBody.status).toBe(403)
    const notJson = await post(broker, '/chat/completions', 'not-json')
    expect(notJson.status).toBe(400)
    const noModel = await post(broker, '/chat/completions', { messages: [] })
    expect(noModel.status).toBe(400)
    expect(mock.requests).toHaveLength(0)
    expect(broker.report().records.every(entry => entry.kind !== 'chat-completions')).toBe(true)
  })

  it('enforces the max-calls cap fail-closed and latches the reason', async () => {
    const mock = await startMock({ scripted: [{ content: 'one' }, { content: 'two' }] })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl, caps: { maxCalls: 1, maxTotalTokens: 1_000_000, wallClockMs: 600_000 } })
    const first = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    expect(first.status).toBe(200)
    const second = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    expect(second.status).toBe(429)
    expect(second.text).toContain('max-calls')
    const third = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    expect(third.status).toBe(429)
    const report = broker.report()
    expect(report.calls).toBe(1)
    expect(report.cappedReason).toBe('max-calls')
    expect(mock.requests).toHaveLength(1)
  })

  it('enforces the token cap from upstream-reported usage', async () => {
    const mock = await startMock({ scripted: [{ content: 'heavy', promptTokens: 40, completionTokens: 10 }, { content: 'more' }] })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl, caps: { maxCalls: 10, maxTotalTokens: 50, wallClockMs: 600_000 } })
    const first = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    expect(first.status).toBe(200)
    const second = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    expect(second.status).toBe(429)
    expect(second.text).toContain('max-tokens')
    expect(broker.report().cappedReason).toBe('max-tokens')
  })

  it('enforces the wall-clock cap', async () => {
    const mock = await startMock({ scripted: [{ content: 'later' }] })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl, caps: { maxCalls: 10, maxTotalTokens: 1_000_000, wallClockMs: 1 } })
    await sleep(20)
    const refused = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    expect(refused.status).toBe(429)
    expect(refused.text).toContain('wall-clock')
    expect(mock.requests).toHaveLength(0)
  })

  it('refuses oversized bodies with 413', async () => {
    const mock = await startMock({ scripted: [{ content: 'x' }] })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl, maxBodyBytes: 1024 })
    const big = 'x'.repeat(2048)
    const result = await post(broker, '/chat/completions', { model: 'test-model', messages: [{ role: 'user', content: big }] })
    expect(result.status).toBe(413)
    expect(mock.requests).toHaveLength(0)
  })

  it('passes a GET /models probe through unmetered', async () => {
    const mock = await startMock({ scripted: [], allowModel: 'test-model' })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl })
    const response = await fetch(`${broker.baseUrl}/v1/models`)
    expect(response.status).toBe(200)
    expect(JSON.parse(await response.text()).data[0].id).toBe('test-model')
    const report = broker.report()
    expect(report.calls).toBe(0)
    expect(report.records.some(entry => entry.kind === 'models-probe' && entry.status === 200)).toBe(true)
  })

  it('answers 502 when the upstream speaks plain HTTP behind an https URL', async () => {
    const mock = await startMock({ scripted: [{ content: 'never' }] })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl.replace('http://', 'https://') })
    const result = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    expect(result.status).toBe(502)
    expect(result.text).toContain('upstream request failed')
  })

  it('answers 502 when the upstream hangs past the timeout', async () => {
    const mock = await startMock({ scripted: [{ content: 'never' }] })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl, upstreamTimeoutMs: 150 })
    const result = await post(broker, '/chat/completions', { model: 'test-model', messages: [], mockHang: true })
    expect(result.status).toBe(502)
    expect(broker.report().records[broker.report().records.length - 1]?.reason).toContain('upstream timeout')
  })

  it('forwards a truncated stream when the upstream drops mid-stream', async () => {
    const mock = await startMock({ scripted: [{ content: 'partial' }] })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl })
    let sawDone = false
    try {
      const result = await post(broker, '/chat/completions', { model: 'test-model', stream: true, messages: [], mockDropStream: true })
      sawDone = result.text.includes('[DONE]')
    } catch {
      sawDone = false // connection reset surfaces as a fetch failure — equally no [DONE]
    }
    expect(sawDone).toBe(false)
    expect(broker.report().calls).toBe(1)
  })

  it('tunnels plain HTTP through a forward proxy (CONNECT)', async () => {
    const mock = await startMock({ scripted: [{ content: 'tunneled' }] })
    const proxy = await startFakeProxy('ok')
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl, proxyUrl: `http://127.0.0.1:${proxy.port}` })
    const result = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    expect(result.status).toBe(200)
    expect(JSON.parse(result.text).choices[0].message.content).toBe('tunneled')
    expect(proxy.tunneled).toHaveLength(1)
  })

  it('answers 502 when the proxy refuses CONNECT', async () => {
    const mock = await startMock({ scripted: [{ content: 'never' }] })
    const proxy = await startFakeProxy('refuse')
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl, proxyUrl: `http://127.0.0.1:${proxy.port}` })
    const result = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    expect(result.status).toBe(502)
    expect(result.text).toContain('proxy CONNECT refused')
    expect(mock.requests).toHaveLength(0)
  })

  it('answers 502 for https through a proxy when the target is not TLS', async () => {
    const mock = await startMock({ scripted: [{ content: 'never' }] })
    const proxy = await startFakeProxy('ok')
    const broker = await startBroker({
      upstreamBaseUrl: mock.baseUrl.replace('http://', 'https://'),
      proxyUrl: `http://127.0.0.1:${proxy.port}`,
    })
    const result = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    expect(result.status).toBe(502)
    expect(proxy.tunneled).toHaveLength(1)
  })
})

describe('llm broker edge coverage (loopback mock upstream)', () => {
  it('rejects a JSON null body and one without a content-type header', async () => {
    const mock = await startMock({ scripted: [{ content: 'a' }, { content: 'b' }] })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl })
    const nullBody = await post(broker, '/chat/completions', 'null')
    expect(nullBody.status).toBe(400)
    expect(nullBody.text).toContain('must carry a string model')
    const bare = await new Promise<{ status: number }>(resolve => {
      const request = httpRequest(`${broker.baseUrl}/chat/completions`, { method: 'POST' }, response => {
        response.on('data', () => undefined)
        response.on('end', () => resolve({ status: response.statusCode ?? 0 }))
      })
      request.end(JSON.stringify({ model: 'test-model', messages: [] }))
    })
    expect(bare.status).toBe(200)
    expect(mock.requests[0].model).toBe('test-model')
  })

  it('parses usage from a JSON response without a content-type header', async () => {
    const mock = await startMock({ scripted: [{ content: 'bare', promptTokens: 4, completionTokens: 6 }], noContentType: true })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl })
    const result = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    expect(result.status).toBe(200)
    expect(broker.report().totalTokens).toBe(10)
  })

  it('sums partial usage objects that only report some fields', async () => {
    const mock = await startMock({ scripted: [{ content: 'p', promptTokens: 5 }, { content: 'c', completionTokens: 7 }] })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl })
    const first = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    const second = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(broker.report()).toMatchObject({ calls: 2, promptTokens: 5, completionTokens: 7, totalTokens: 12, usageUnknownCalls: 0 })
  })

  it('destroys a hanging stream after the upstream timeout and records the failed call', async () => {
    const mock = await startMock({ scripted: [{ content: 'forever' }] })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl, upstreamTimeoutMs: 150 })
    let sawDone = false
    try {
      const result = await post(broker, '/chat/completions', { model: 'test-model', stream: true, messages: [], mockStreamThenHang: true })
      sawDone = result.text.includes('[DONE]')
    } catch {
      sawDone = false
    }
    expect(sawDone).toBe(false)
    const report = broker.report()
    expect(report.calls).toBe(1)
    expect(report.records.some(entry => entry.kind === 'chat-completions' && entry.status === 502)).toBe(true)
  })

  it('answers 502 when the proxy itself is unreachable (no port fallback to 80)', async () => {
    const mock = await startMock({ scripted: [{ content: 'never' }] })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl, proxyUrl: 'http://127.0.0.1' })
    const result = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    expect(result.status).toBe(502)
    expect(result.text).toContain('proxy connection failed')
  })

  it('passes piggybacked bytes after the CONNECT response head through the tunnel', async () => {
    const mock = await startMock({ scripted: [{ content: 'tunneled' }] })
    const proxy = await startFakeProxy('pad')
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl, proxyUrl: `http://127.0.0.1:${proxy.port}` })
    // node's client parser tolerates leading CRLF before the status line
    // (RFC 7230), so the piggybacked bytes ride the tunnel harmlessly.
    const result = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    expect(result.status).toBe(200)
    expect(result.text).toContain('tunneled')
    expect(proxy.tunneled).toHaveLength(1)
  })

  it('appends every usage record to the JSONL log and survives a broken log path', async () => {
    const mock = await startMock({
      scripted: [
        { content: 'logged', promptTokens: 1, completionTokens: 1 },
        { content: 'logged-again', promptTokens: 1, completionTokens: 1 },
      ],
    })
    const root = mkdtempSync(join(tmpdir(), 'evo-broker-'))
    try {
      const healthy = await startLlmBroker({
        upstreamBaseUrl: mock.baseUrl,
        modelAllowlist: ['test-model'],
        caps: { maxCalls: 10, maxTotalTokens: 1000, wallClockMs: 600_000 },
      }, join(root, 'usage.jsonl'))
      const served = await fetch(`${healthy.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test-model', messages: [] }),
      })
      expect(served.status).toBe(200)
      await healthy.stop()
      const lines = readFileSync(join(root, 'usage.jsonl'), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toMatchObject({ kind: 'chat-completions', totalTokens: 2 })

      const broken = await startLlmBroker({
        upstreamBaseUrl: mock.baseUrl,
        modelAllowlist: ['test-model'],
        caps: { maxCalls: 10, maxTotalTokens: 1000, wallClockMs: 600_000 },
      }, root) // a directory: appendFileSync must throw and be swallowed
      const stillServed = await fetch(`${broken.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test-model', messages: [] }),
      })
      expect(stillServed.status).toBe(200)
      expect(broken.report().calls).toBe(1)
      await broken.stop()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a second stop() call', async () => {
    const mock = await startMock({ scripted: [] })
    const broker = await startLlmBroker({
      upstreamBaseUrl: mock.baseUrl,
      modelAllowlist: ['test-model'],
      caps: { maxCalls: 1, maxTotalTokens: 1, wallClockMs: 1 },
    })
    await broker.stop()
    await expect(broker.stop()).rejects.toThrow()
  })
})

describe('mock llm server (direct, no broker)', () => {
  it('answers 404 for unknown paths', async () => {
    const mock = await startMock({ scripted: [] })
    const response = await fetch(`${mock.baseUrl}/v1/embeddings`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(404)
  })

  it('answers 400 for a non-JSON body', async () => {
    const mock = await startMock({ scripted: [] })
    const response = await fetch(`${mock.baseUrl}/v1/chat/completions`, { method: 'POST', body: 'not-json' })
    expect(response.status).toBe(400)
  })

  it('answers 500 when the scripted responses run out', async () => {
    const mock = await startMock({ scripted: [{ content: 'only-one' }] })
    const first = await fetch(`${mock.baseUrl}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) })
    expect(first.status).toBe(200)
    const second = await fetch(`${mock.baseUrl}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) })
    expect(second.status).toBe(500)
    expect(await second.text()).toContain('script exhausted')
  })

  it('answers 400 for a model outside allowModel', async () => {
    const mock = await startMock({ scripted: [], allowModel: 'good-model' })
    const response = await fetch(`${mock.baseUrl}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'bad-model', messages: [] }) })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('model not allowed')
  })

  it('lists no models when allowModel is unset', async () => {
    const mock = await startMock({ scripted: [] })
    const response = await fetch(`${mock.baseUrl}/v1/models`)
    expect(response.status).toBe(200)
    expect(JSON.parse(await response.text()).data).toEqual([])
  })
})

describe('mock llm server (auth and lifecycle edges)', () => {
  it('answers 401 when the authorization header does not match', async () => {
    const mock = await startMock({ scripted: [], requireAuthorization: 'Bearer right' })
    const wrong = await fetch(`${mock.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    })
    expect(wrong.status).toBe(401)
    const missing = await fetch(`${mock.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'm', messages: [] }),
    })
    expect(missing.status).toBe(401)
  })

  it('records a missing model and non-array messages as placeholder values', async () => {
    const mock = await startMock({ scripted: [{ content: 'served-anyway' }] })
    const response = await fetch(`${mock.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(200)
    expect(mock.requests[0].model).toBe('(missing)')
    expect(mock.requests[0].nMessages).toBe(0)
  })

  it('rejects a second stop() call', async () => {
    const mock = await startMockLlmServer({ scripted: [] })
    await mock.stop()
    await expect(mock.stop()).rejects.toThrow()
  })
})

describe('llm broker review fixes (PR #15 feedback)', () => {
  it('never negotiates content codings with the upstream', async () => {
    const mock = await startMock({ scripted: [{ content: 'plain', promptTokens: 2, completionTokens: 2 }] })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl })
    const result = await new Promise<{ status: number }>(resolve => {
      const request = httpRequest(`${broker.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip, br' } }, response => {
        response.on('data', () => undefined)
        response.on('end', () => resolve({ status: response.statusCode ?? 0 }))
      })
      request.end(JSON.stringify({ model: 'test-model', messages: [] }))
    })
    expect(result.status).toBe(200)
    expect(mock.requests[0].acceptEncoding).toBe('identity')
    expect(broker.report().totalTokens).toBe(4)
  })

  it('parseRequestUrl refuses unparsable targets instead of throwing', () => {
    expect(parseRequestUrl('/chat/completions')?.pathname).toBe('/chat/completions')
    expect(parseRequestUrl('http://a:999999999999999999/x')).toBeUndefined()
  })

  it('answers 403 to an unparsable absolute-form request target over the wire', async () => {
    const mock = await startMock({ scripted: [] })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl })
    const raw = await new Promise<string>(resolve => {
      const socket = netConnect({ host: '127.0.0.1', port: broker.port })
      let seen = ''
      socket.on('data', (chunk: Buffer) => {
        seen += chunk.toString('utf8')
        socket.end()
      })
      socket.on('end', () => resolve(seen))
      socket.on('error', () => resolve(seen))
      socket.write('POST http://a:999999999999999999/x HTTP/1.1\r\nHost: a\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    })
    expect(raw).toContain('403')
    expect(mock.requests).toHaveLength(0)
  })
})

describe('mock llm scripted tool calls', () => {
  const shellTool = { type: 'function', function: { name: 'shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }

  it('pickArgumentProperty prefers command, then strings, then anything', () => {
    expect(pickArgumentProperty({ properties: { cmd: { type: 'string' }, command: { type: 'string' } } })).toBe('command')
    expect(pickArgumentProperty({ properties: { count: { type: 'number' }, path: { type: 'string' } } })).toBe('path')
    expect(pickArgumentProperty({ properties: { anything: { type: 'number' } } })).toBe('anything')
    expect(pickArgumentProperty({ properties: {} })).toBe('input')
    expect(pickArgumentProperty('not-a-schema')).toBe('input')
    expect(pickArgumentProperty({ properties: 'nope' })).toBe('input')
    expect(pickArgumentProperty({ properties: { a: 'string-not-object', b: { type: 'string' } } })).toBe('b')
    expect(pickArgumentProperty({ properties: { a: 'string-not-object' } })).toBe('a')
  })

  it('answers a function call against the first requested tool (broker path, non-stream)', async () => {
    const mock = await startMock({ scripted: [{ content: '', callFirstTool: { firstStringArg: 'echo carrier' }, promptTokens: 4, completionTokens: 6 }] })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl })
    const response = await fetch(`${broker.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test-model', messages: [], tools: [shellTool] }),
    })
    expect(response.status).toBe(200)
    const body = JSON.parse(await response.text())
    expect(body.choices[0].finish_reason).toBe('tool_calls')
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('shell')
    expect(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments)).toEqual({ command: 'echo carrier' })
    expect(mock.requests[0].nTools).toBe(1)
    expect(mock.requests[0].toolNames).toEqual(['shell'])
    expect(broker.report().totalTokens).toBe(10)
  })

  it('streams a function call chunk too', async () => {
    const mock = await startMock({ scripted: [{ content: '', callFirstTool: { firstStringArg: 'x' } }] })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl })
    const result = await post(broker, '/chat/completions', { model: 'test-model', stream: true, messages: [], tools: [shellTool] })
    expect(result.status).toBe(200)
    expect(result.text).toContain('tool_calls')
    expect(result.text).toContain('"name":"shell"')
    expect(result.text).toContain('[DONE]')
  })

  it('answers 500 when callFirstTool is scripted but no tools were offered', async () => {
    const mock = await startMock({ scripted: [{ content: '', callFirstTool: { firstStringArg: 'x' } }] })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl })
    const result = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    expect(result.status).toBe(500)
    expect(result.text).toContain('carried no tools')
  })
})

describe('mock llm Messages protocol and tool-argument building', () => {
  it('buildToolArguments fills every required string property besides the argument one', () => {
    const schema = { type: 'object', required: ['command', 'description'], properties: { command: { type: 'string' }, description: { type: 'string' }, timeoutMs: { type: 'number' } } }
    expect(buildToolArguments(schema, 'command', 'ls')).toEqual({ command: 'ls', description: 'hourglass carrier description' })
    expect(buildToolArguments(undefined, 'input', 'x')).toEqual({ input: 'x' })
    expect(buildToolArguments({ properties: {} }, 'a', 'b')).toEqual({ a: 'b' })
  })

  it('serves Messages-protocol tool_use streams with an initial input object', async () => {
    const mock = await startMock({ scripted: [{ content: '', callFirstTool: { firstStringArg: 'cat canary.txt' }, promptTokens: 5, completionTokens: 2 }] })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl, modelAllowlist: ['deepseek-flash'] })
    const response = await fetch(`${broker.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-flash',
        stream: true,
        messages: [],
        tools: [{ name: 'bash', input_schema: { type: 'object', required: ['command', 'description'], properties: { command: { type: 'string' }, description: { type: 'string' } } } }],
      }),
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('"type":"tool_use"')
    expect(text).toContain('"input":{}')
    expect(text).toContain('"stop_reason":"tool_use"')
    expect(mock.requests[0].toolNames).toEqual(['bash'])
    expect(JSON.stringify(mock.requests[0].firstToolParameters)).toContain('command')
    const report = broker.report()
    expect(report.calls).toBe(1)
    expect(report.promptTokens).toBe(5)
    expect(report.completionTokens).toBe(2)
  })

  it('selects the tool by scripted pattern when provided', async () => {
    const mock = await startMock({ scripted: [{ content: '', callFirstTool: { firstStringArg: 'x', toolNamePattern: /^working_directory$/ } }] })
    const response = await fetch(`${mock.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [], tools: [
        { type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
        { type: 'function', function: { name: 'working_directory', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
      ] }),
    })
    expect(response.status).toBe(200)
    const body = JSON.parse(await response.text())
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('working_directory')
    expect(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments)).toEqual({ path: 'x' })
  })

  it('answers 500 when a Messages tool call is scripted but no tool matches', async () => {
    const mock = await startMock({ scripted: [{ content: '', callFirstTool: { firstStringArg: 'x' } }] })
    const response = await fetch(`${mock.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    })
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('carried no tools')
  })

  it('buildToolArguments skips required properties that are not plain objects', () => {
    const schema = { type: 'object', required: ['command', 'weird'], properties: { command: { type: 'string' }, weird: 'not-an-object' } }
    expect(buildToolArguments(schema, 'command', 'go')).toEqual({ command: 'go' })
  })

  it('serves Messages streams and bodies with no usage at all', async () => {
    const mock = await startMock({ scripted: [{ content: 'bare' }, { content: 'bare2' }] })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl, modelAllowlist: ['deepseek-flash'] })
    const streamed = await fetch(`${broker.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', stream: true, messages: [] }),
    })
    expect(streamed.status).toBe(200)
    const streamedText = await streamed.text()
    expect(streamedText).not.toContain('input_tokens')
    expect(streamedText).not.toContain('output_tokens')
    const plain = await fetch(`${broker.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', messages: [] }),
    })
    expect(plain.status).toBe(200)
    const body = JSON.parse(await plain.text())
    expect(body.usage).toBeUndefined()
    expect(broker.report()).toMatchObject({ calls: 2, usageUnknownCalls: 2, totalTokens: 0 })
  })

  it('fills absent single-side usage with zeros and tolerates non-object tools entries', async () => {
    const mock = await startMock({ scripted: [{ content: 'half', promptTokens: 4 }] })
    const response = await fetch(`${mock.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [], tools: ['garbage-entry', null] }),
    })
    expect(response.status).toBe(200)
    const body = JSON.parse(await response.text())
    expect(body.usage).toEqual({ input_tokens: 4, output_tokens: 0 })
    expect(mock.requests[0].nTools).toBe(2)
    expect(mock.requests[0].toolNames).toEqual(['(unnamed)', '(unnamed)'])
  })

  it('covers completion-only usage and malformed tool shapes', async () => {
    const mock = await startMock({ scripted: [{ content: 'c', completionTokens: 3 }] })
    const response = await fetch(`${mock.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [], tools: [
        { function: { parameters: {} } },
        { foo: 1 },
      ] }),
    })
    expect(response.status).toBe(200)
    const body = JSON.parse(await response.text())
    expect(body.usage).toEqual({ input_tokens: 0, output_tokens: 3 })
    expect(mock.requests[0].toolNames).toEqual(['(unnamed)', '(unnamed)'])
    expect(mock.requests[0].nTools).toBe(2)
  })

  it('resetScript restarts the served sequence without lifetime counting', async () => {
    const mock = await startMock({ scripted: [{ content: 'only' }] })
    await fetch(`${mock.baseUrl}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) })
    mock.resetScript([{ content: 'fresh' }])
    const second = await fetch(`${mock.baseUrl}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) })
    expect(second.status).toBe(200)
    expect(await second.text()).toContain('fresh')
  })

  it('Messages non-stream tool_use answers a JSON object body', async () => {
    const mock = await startMock({ scripted: [{ content: '', callFirstTool: { firstStringArg: 'x' }, promptTokens: 1, completionTokens: 1 }] })
    const response = await fetch(`${mock.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [], tools: [{ name: 'bash', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }] }),
    })
    expect(response.status).toBe(200)
    const body = JSON.parse(await response.text())
    expect(body.content[0].type).toBe('tool_use')
    expect(body.stop_reason).toBe('tool_use')
    expect(body.usage).toEqual({ input_tokens: 1, output_tokens: 1 })
  })
})

describe('Messages-protocol usage extraction', () => {
  it('extractUsageFromMessagesJson reads snake_case fields and sums them', () => {
    expect(extractUsageFromMessagesJson('{"usage":{"input_tokens":3,"output_tokens":4}}'))
      .toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7 })
    expect(extractUsageFromMessagesSse('data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}')).toEqual({ promptTokens: 5, completionTokens: undefined, totalTokens: undefined })
    expect(extractUsageFromMessagesJson('{"usage":{"input_tokens":5}}'))
      .toEqual({ promptTokens: 5, completionTokens: undefined, totalTokens: undefined })
    expect(extractUsageFromMessagesJson('{"usage":{"output_tokens":2}}'))
      .toEqual({ promptTokens: undefined, completionTokens: 2, totalTokens: undefined })
    expect(extractUsageFromMessagesJson('{"usage":{"prompt_tokens":9,"total_tokens":11}}'))
      .toEqual({ promptTokens: 9, completionTokens: undefined, totalTokens: 11 })
    expect(extractUsageFromMessagesJson('not json')).toBeUndefined()
    expect(extractUsageFromMessagesJson('42')).toBeUndefined()
    expect(extractUsageFromMessagesJson('{"usage":{"total_tokens":9}}')).toBeUndefined()
    expect(extractUsageFromMessagesJson('{"choices":[]}')).toBeUndefined()
    expect(extractUsageFromMessagesJson('{"usage":{}}')).toBeUndefined()
  })

  it('extractUsageFromMessagesSse merges message_start and message_delta usage', () => {
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":8}}',
      'data: {"type":"message_stop"}',
    ].join('\n')
    expect(extractUsageFromMessagesSse(sse)).toEqual({ promptTokens: 7, completionTokens: 8, totalTokens: 15 })
    expect(extractUsageFromMessagesSse('data: {"type":"message_stop"}')).toBeUndefined()
    expect(extractUsageFromMessagesSse('data: not-json')).toBeUndefined()
    expect(extractUsageFromMessagesSse('data: 42')).toBeUndefined()
  })

  it('meters a Messages-protocol NON-stream response through the broker', async () => {
    const mock = await startMock({ scripted: [{ content: 'plain-messages', promptTokens: 6, completionTokens: 2 }] })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl, modelAllowlist: ['deepseek-flash'] })
    const response = await fetch(`${broker.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', messages: [] }),
    })
    expect(response.status).toBe(200)
    expect(broker.report()).toMatchObject({ calls: 1, promptTokens: 6, completionTokens: 2, totalTokens: 8, usageUnknownCalls: 0 })
  })

  it('meters a Messages-protocol stream through the broker end to end', async () => {
    const mock = await startMock({ scripted: [{ content: 'messages-body', promptTokens: 11, completionTokens: 6 }] })
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl, modelAllowlist: ['deepseek-flash'] })
    const response = await fetch(`${broker.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', stream: true, messages: [] }),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('messages-body')
    expect(broker.report()).toMatchObject({ calls: 1, promptTokens: 11, completionTokens: 6, totalTokens: 17, usageUnknownCalls: 0 })
    expect(broker.report().records[0]).toMatchObject({ kind: 'messages', status: 200, model: 'deepseek-flash' })
  })
})

describe('llm broker transport hardening (PR #15 persistent review)', () => {
  it('sends a truthful Host header through the CONNECT tunnel', async () => {
    const mock = await startMock({ scripted: [{ content: 'host-ok' }] })
    const proxy = await startFakeProxy('ok')
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl, proxyUrl: `http://127.0.0.1:${proxy.port}` })
    const result = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    expect(result.status).toBe(200)
    expect(mock.requests[0].host).toBe(`127.0.0.1:${mock.port}`)
  })

  it('buffers a CONNECT reply that spans two TCP segments', async () => {
    const mock = await startMock({ scripted: [{ content: 'split-ok' }] })
    const proxy = await startFakeProxy('split')
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl, proxyUrl: `http://127.0.0.1:${proxy.port}` })
    const result = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    expect(result.status).toBe(200)
    expect(JSON.parse(result.text).choices[0].message.content).toBe('split-ok')
  })

  it('fails a proxy reply whose head exceeds the cap without a blank line', async () => {
    const mock = await startMock({ scripted: [{ content: 'never' }] })
    const proxy = await startFakeProxy('flood')
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl, proxyUrl: `http://127.0.0.1:${proxy.port}` })
    const result = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    expect(result.status).toBe(502)
    expect(result.text).toContain('exceeded 16KiB')
  })

  it('times out a proxy that accepts the connection but never answers CONNECT', async () => {
    const mock = await startMock({ scripted: [{ content: 'never' }] })
    const proxy = await startFakeProxy('stall')
    const broker = await startBroker({ upstreamBaseUrl: mock.baseUrl, proxyUrl: `http://127.0.0.1:${proxy.port}`, upstreamTimeoutMs: 300 })
    const result = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    expect(result.status).toBe(502)
    expect(result.text).toContain('connect phase timed out')
    expect(mock.requests).toHaveLength(0)
  })

  it('times out a silent raw upstream connect', async () => {
    const broker = await startBroker({ upstreamBaseUrl: 'http://10.255.255.1:81', upstreamTimeoutMs: 400 })
    const result = await post(broker, '/chat/completions', { model: 'test-model', messages: [] })
    expect(result.status).toBe(502)
    expect(result.text).toContain('connect timed out')
  })
})
