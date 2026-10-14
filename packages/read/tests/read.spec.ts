import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
import * as ReadPlugin from '../src/index.ts'
import { wrapConfinedForReadShadowing } from '../src/index.ts'

const confined: ConfinedArgv = {
  argv: ['bwrap', '--ro-bind', '/', '/', '--', 'bash', '-c', 'cat /x'],
  enforcement: 'full',
  denialSignatures: ['read-only file system'],
  runnerFailureRules: [],
}

describe('wrapConfinedForReadShadowing', () => {
  it('shadows every denied path with a tmpfs mount before the separator', () => {
    const wrapped = wrapConfinedForReadShadowing(confined, ['/root/.synthetic-secrets', '/root/.ssh'])
    const separator = wrapped.argv.indexOf('--')
    const bwrapPart = wrapped.argv.slice(0, separator).join(' ')
    expect(bwrapPart).toContain('--tmpfs /root/.synthetic-secrets')
    expect(bwrapPart).toContain('--tmpfs /root/.ssh')
    expect(wrapped.argv.slice(separator + 1)).toEqual(['bash', '-c', 'cat /x'])
    expect(wrapped.enforcement).toBe(confined.enforcement)
  })

  it('keeps the wrap facts (enforcement, denial signatures) untouched', () => {
    const wrapped = wrapConfinedForReadShadowing(confined, ['/a'])
    expect(wrapped.denialSignatures).toBe(confined.denialSignatures)
    expect(wrapped.runnerFailureRules).toBe(confined.runnerFailureRules)
  })

  it('fails closed on a non-bwrap rung', () => {
    expect(() => wrapConfinedForReadShadowing({ ...confined, argv: ['landlock-run', '--', 'bash'] }, ['/a']))
      .toThrow(/read protection cannot be enforced on a non-bwrap rung/)
  })

  it('fails closed without a separator', () => {
    expect(() => wrapConfinedForReadShadowing({ ...confined, argv: ['bwrap', '--ro-bind', '/', '/'] }, ['/a']))
      .toThrow(/no "--" separator/)
  })
})

describe('hourglass-sandbox-read plugin', () => {
  class FakeProvider extends SandboxProvider {
    async confine(argv: readonly string[]): Promise<ConfinedArgv> {
      return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
    }
  }

  it('an empty deny list changes nothing', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeProvider)
    const plugin = await ctx.plugin(ReadPlugin, {})
    const wrapped = await ctx.sandbox.confine(['bwrap', '--', 'true'])
    expect(wrapped.argv).toEqual(['bwrap', '--', 'true'])
    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('a configured list shadows paths and the wrap is restored on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeProvider)
    const plugin = await ctx.plugin(ReadPlugin, { denyRead: ['/root/.synthetic-secrets'] })
    try {
      const wrapped = await ctx.sandbox.confine(['bwrap', '--', 'true'])
      expect(wrapped.argv).toContain('--tmpfs')
      expect(wrapped.argv).toContain('/root/.synthetic-secrets')
    } finally {
      await plugin.dispose()
    }
    const after = await ctx.sandbox.confine(['bwrap', '--', 'true'])
    expect(after.argv).toEqual(['bwrap', '--', 'true'])
    await ctx.fiber.dispose()
  })
})
