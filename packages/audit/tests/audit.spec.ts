import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as AuditPlugin from '../src/index.ts'

const signal = new AbortController().signal
const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function harness(): Promise<{ ctx: Context; ledgerPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'hourglass-audit-'))
  dirs.push(dir)
  const ledgerPath = join(dir, 'audit.jsonl')
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AuditPlugin, { ledgerPath })
  ctx.tools.register(defineContentToolFixture({
    name: 'probe',
    description: 'p',
    parameters: {},
    async execute() {
      return [{ type: 'text', text: 'ok' }]
    },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'fails',
    description: 'f',
    parameters: {},
    async execute() {
      throw new Error('command exploded')
    },
  }))
  return { ctx, ledgerPath }
}

function records(ledgerPath: string): Record<string, unknown>[] {
  return readFileSync(ledgerPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('hourglass-sandbox-audit plugin', () => {
  it('writes a begin record at pre-execute and an end record at result, correlated by callId', async () => {
    const { ctx, ledgerPath } = await harness()
    await ctx.tools.execute({ signal, callId: ToolCallId('c1'), name: 'probe', arguments: { q: 1 } })
    const written = records(ledgerPath)
    expect(written).toHaveLength(2)
    expect(written[0]).toMatchObject({ kind: 'begin', callId: 'c1', tool: 'probe', layer: 'policy_decision' })
    expect(written[1]).toMatchObject({ kind: 'end', callId: 'c1', tool: 'probe', layer: 'backend_result' })
    expect(written[0]!.schema).toBe('hourglass-audit/1')
  })

  it('classifies a successful call as allowed and records duration', async () => {
    const { ctx, ledgerPath } = await harness()
    await ctx.tools.execute({ signal, callId: ToolCallId('c-ok'), name: 'probe', arguments: {} })
    const end = records(ledgerPath).find(record => record.kind === 'end')!
    expect(end['outcome']).toEqual({ kind: 'allowed', basis: 'result is success' })
    expect(end['backend']).toEqual({ source: 'unavailable' })
    expect(end['osObservation']).toEqual({ status: 'unavailable' })
    expect(typeof end['durationMs']).toBe('number')
  })

  it('classifies a thrown tool error as an ordinary failure with error identity', async () => {
    const { ctx, ledgerPath } = await harness()
    await ctx.tools.execute({ signal, callId: ToolCallId('c-fail'), name: 'fails', arguments: {} })
    const end = records(ledgerPath).find(record => record.kind === 'end')!
    expect((end['outcome'] as Record<string, unknown>)['kind']).toBe('ordinary-failure')
  })

  it('redacts secret-shaped arguments in the begin summary (AUD-04)', async () => {
    const { ctx, ledgerPath } = await harness()
    await ctx.tools.execute({ signal, callId: ToolCallId('c-sec'), name: 'probe', arguments: { path: '/tmp/x', api_key: 'sk-live-99' } })
    const raw = readFileSync(ledgerPath, 'utf8')
    expect(raw).not.toContain('sk-live-99')
    const begin = records(ledgerPath).find(record => record.kind === 'begin')!
    const summary = begin['argumentsSummary'] as Record<string, unknown>
    expect(summary['keys']).toEqual(['api_key', 'path'])
    expect(String(summary['preview'])).toContain('[redacted]')
  })

  it('records backend facts when the consumer publishes result.sandbox (and not otherwise)', async () => {
    const { ctx, ledgerPath } = await harness()
    ctx.tools.register(defineContentToolFixture({
      name: 'sandboxed',
      description: 's',
      parameters: {},
      async execute() {
        return [{ type: 'text', text: 'ran' }]
      },
    }))
    // Simulate the consumer contract: a bash-sandbox-style denial publishes a
    // failed result whose meta carries the structured sandbox facts.
    const plugin = await ctx.plugin((inner: Context) => {
      inner.on('tools/execute', async (exec, next) => {
        if (exec.name !== 'sandboxed') return next()
        await next()
        return {
          isError: true,
          error: { message: 'sandbox denied the write' },
          content: [],
          meta: { sandbox: { mode: 'read-only', denied: true, enforcement: 'full' } },
        }
      })
    })
    await ctx.tools.execute({ signal, callId: ToolCallId('c-sbx'), name: 'sandboxed', arguments: {} })
    await plugin.dispose()
    const end = records(ledgerPath).find(record => record.kind === 'end' && record.callId === 'c-sbx')!
    expect(end['outcome']).toEqual({ kind: 'sandbox-denial', basis: 'result.sandbox.denied = true' })
    expect(end['backend']).toEqual({ denied: true, enforcement: 'full', source: 'tools/result/meta.sandbox' })
  })

  it('survives concurrent calls without crossing records (AUD-05)', async () => {
    const { ctx, ledgerPath } = await harness()
    await Promise.all([
      ctx.tools.execute({ signal, callId: ToolCallId('p1'), name: 'probe', arguments: {} }),
      ctx.tools.execute({ signal, callId: ToolCallId('p2'), name: 'probe', arguments: {} }),
      ctx.tools.execute({ signal, callId: ToolCallId('p3'), name: 'fails', arguments: {} }),
    ])
    const written = records(ledgerPath)
    expect(written).toHaveLength(6)
    for (const callId of ['p1', 'p2', 'p3']) {
      const chain = written.filter(record => record.callId === callId)
      expect(chain.map(record => record.kind)).toEqual(['begin', 'end'])
    }
  })
})
