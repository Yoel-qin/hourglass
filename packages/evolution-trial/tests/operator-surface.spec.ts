/**
 * Operator surface through a REAL commands runtime: mount SessionStore +
 * CommandRuntime (the same composition DSH's commands.spec uses), load the
 * evolution-trial plugin on top, and drive `/sandbox-evolution` through
 * ctx.commands.execute — the handler branches (summary, broken chain, bad
 * JSON, missing filter, unknown candidate, tampered artifact) all execute
 * through the real registry, not a hand-called function.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as TrialPlugin from '../src/index.ts'

const root = mkdtempSync(join(tmpdir(), 'evo-operator-'))
const pluginRoot = join(root, 'state')

let ctx: Context
let agent: Agent

beforeAll(async () => {
  ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(TrialPlugin, { rootDir: pluginRoot })
  const session = ctx.sessions.create(SessionId('evo-operator'))
  agent = { id: session.id, session } as Agent
})

afterAll(async () => {
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
})

async function run(rawLine: string): Promise<{ kind: string; text: string } | undefined> {
  const execution = await ctx.commands.execute(agent, rawLine, [], new AbortController().signal)
  return execution?.result as { kind: string; text: string } | undefined
}

describe('sandbox-evolution command (real CommandRuntime)', () => {
  it('errorText renders Errors by message and everything else by String()', async () => {
    const { errorText } = await import('../src/index.ts')
    expect(errorText(new Error('boom'))).toBe('boom')
    expect(errorText('plain string')).toBe('plain string')
    expect(errorText(42)).toBe('42')
  })

  it('summarizes an empty journal with an intact chain', async () => {
    const result = await run('/sandbox-evolution')
    expect(result?.kind).toBe('success')
    expect(result?.text).toContain('chain-ok')
    expect(result?.text).toContain('(empty)')
  })

  it('summarizes events and flags a broken chain', async () => {
    const journalPath = join(pluginRoot, 'evolution-journal.jsonl')
    writeFileSync(journalPath, `${JSON.stringify({ seq: 1, kind: 'proposal-created', at: 't', prevHash: '0'.repeat(64), hash: 'f'.repeat(64) })}\n`, 'utf8')
    const healthy = await run('/sandbox-evolution')
    expect(healthy?.text).toContain('1 event(s)')
    expect(healthy?.text).toContain('proposal-created')

    const lines = readFileSync(journalPath, 'utf8').trim().split('\n')
    const poisoned = JSON.parse(lines[0] as string) as { kind: string }
    poisoned.kind = 'decision-recorded'
    writeFileSync(journalPath, `${JSON.stringify(poisoned)}\n`, 'utf8')
    const broken = await run('/sandbox-evolution')
    expect(broken?.text).toContain('CHAIN-BROKEN')
  })

  it('rejects malformed query filters', async () => {
    expect((await run('/sandbox-evolution not-json'))?.kind).toBe('error')
    expect((await run('/sandbox-evolution [1,2]'))?.kind).toBe('error')
    expect((await run('/sandbox-evolution {"candidateId":""}'))?.kind).toBe('error')
    expect((await run('/sandbox-evolution {"other":1}'))?.kind).toBe('error')
  })

  it('reports an unknown candidate as an error', async () => {
    const result = await run('/sandbox-evolution {"candidateId":"cand-nope"}')
    expect(result?.kind).toBe('error')
    expect(result?.text).toMatch(/unknown-candidate/)
  })

  it('answers a sealed candidate and flags a tampered artifact', async () => {
    // Seed the store through the plugin's own CandidateStore root layout.
    const { CandidateStore } = await import('../src/candidate-store.ts')
    const store = new CandidateStore(join(pluginRoot, 'candidates'))
    const manifest = await store.seal({
      assetKind: 'dsh_skill',
      mutationKind: 'create',
      parentRevision: 'skill-root',
      payload: '# operator surface probe\n',
      createdBy: 'operator-spec',
      sourceNote: 'synthetic',
      benchmarkId: 'evo-bench-mvp-a',
      benchmarkVersion: 1,
      benchmarkManifestSha256: 'e'.repeat(64),
      environmentFingerprint: 'dsh=d743267;lane=bwrap-container',
      versionsLockSha256: 'a'.repeat(64),
    })
    const healthy = await run(`/sandbox-evolution {"candidateId":"${manifest.candidateId}"}`)
    expect(healthy?.kind).toBe('success')
    expect(healthy?.text).toContain('artifact: verified')

    writeFileSync(store.artifactPath(manifest.payloadSha256), 'tampered', 'utf8')
    const broken = await run(`/sandbox-evolution {"candidateId":"${manifest.candidateId}"}`)
    expect(broken?.kind).toBe('success')
    expect(broken?.text).toContain('BROKEN:artifact-hash-mismatch')
  })

  it('defaults rootDir to hourglass-evolution under the cwd when unconfigured', async () => {
    const defaultCtx = new Context()
    await defaultCtx.plugin(SessionStore)
    await defaultCtx.plugin(CommandRuntime)
    const previousCwd = process.cwd()
    const isolated = join(root, 'cwd-isolated')
    mkdirSync(join(isolated, 'hourglass-evolution'), { recursive: true })
    process.chdir(isolated)
    try {
      await defaultCtx.plugin(TrialPlugin, {})
      const session = defaultCtx.sessions.create(SessionId('evo-default'))
      const defaultAgent = { id: session.id, session } as Agent
      const execution = await defaultCtx.commands.execute(defaultAgent, '/sandbox-evolution', [], new AbortController().signal)
      expect((execution?.result as { text: string }).text).toContain('chain-ok')
      // The default CandidateStore constructor materialized its directories
      // under ./hourglass-evolution (the journal file only appears on first
      // append, which the read-only summary never performs).
      expect(existsSync(join(isolated, 'hourglass-evolution', 'candidates', 'artifacts'))).toBe(true)
    } finally {
      process.chdir(previousCwd)
      await defaultCtx.fiber.dispose()
    }
  })
})
