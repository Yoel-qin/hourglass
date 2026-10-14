import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
import * as RsrcPlugin from '../src/index.ts'
import { prlimitArgs, wrapConfinedForResourceLimits } from '../src/index.ts'

const confined: ConfinedArgv = {
  argv: ['bwrap', '--ro-bind', '/', '/', '--', 'bash', '-c', 'true'],
  enforcement: 'full',
  denialSignatures: ['read-only file system'],
  runnerFailureRules: [],
}

describe('prlimitArgs', () => {
  it('emits configured caps in a stable order', () => {
    expect(prlimitArgs({ nproc: 8, asBytes: 1000, nofile: 32 })).toEqual(['--nproc=8', '--as=1000', '--nofile=32'])
  })

  it('empty config emits nothing', () => {
    expect(prlimitArgs({})).toEqual([])
  })
})

describe('wrapConfinedForResourceLimits', () => {
  it('inserts prlimit immediately before the command', () => {
    const wrapped = wrapConfinedForResourceLimits(confined, { nproc: 8 })
    const separator = wrapped.argv.indexOf('--')
    expect(wrapped.argv.slice(separator + 1)).toEqual(['prlimit', '--nproc=8', '--', 'bash', '-c', 'true'])
  })

  it('works after the net plugin launcher (prlimit wraps the launcher)', () => {
    const netWrapped: ConfinedArgv = {
      ...confined,
      argv: ['bwrap', '--tmpfs', '/tmp', '--', '/bin/sh', '/tmp/.hourglass/launch.sh', 'bash', '-c', 'true'],
    }
    const wrapped = wrapConfinedForResourceLimits(netWrapped, { nofile: 32 })
    const separator = wrapped.argv.indexOf('--')
    expect(wrapped.argv.slice(separator + 1)).toEqual(['prlimit', '--nofile=32', '--', '/bin/sh', '/tmp/.hourglass/launch.sh', 'bash', '-c', 'true'])
  })

  it('empty config leaves the wrap untouched', () => {
    expect(wrapConfinedForResourceLimits(confined, {})).toBe(confined)
  })

  it('fails closed on a non-bwrap rung', () => {
    expect(() => wrapConfinedForResourceLimits({ ...confined, argv: ['landlock-run', '--', 'bash'] }, { nproc: 8 }))
      .toThrow(/cannot be enforced on a non-bwrap rung/)
  })

  it('fails closed without a separator', () => {
    expect(() => wrapConfinedForResourceLimits({ ...confined, argv: ['bwrap', '--ro-bind'] }, { nproc: 8 }))
      .toThrow(/no "--" separator/)
  })
})

describe('hourglass-sandbox-rsrc plugin', () => {
  class FakeProvider extends SandboxProvider {
    async confine(argv: readonly string[]): Promise<ConfinedArgv> {
      return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
    }
  }

  it('wraps confine with the configured caps and restores on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeProvider)
    const plugin = await ctx.plugin(RsrcPlugin, { nproc: 8 })
    try {
      const wrapped = await ctx.sandbox.confine(['bwrap', '--', 'true'])
      expect(wrapped.argv).toContain('prlimit')
      expect(wrapped.argv.join(' ')).toContain('--nproc=8')
    } finally {
      await plugin.dispose()
    }
    const after = await ctx.sandbox.confine(['bwrap', '--', 'true'])
    expect(after.argv).toEqual(['bwrap', '--', 'true'])
    await ctx.fiber.dispose()
  })
})
