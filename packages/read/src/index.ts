/**
 * hourglass sandbox-read plugin (P2b): sensitive-read protection on the bwrap
 * rung. Every configured deny-read path is shadowed inside the sandbox by an
 * empty tmpfs mount, so the content is unobtainable both through the direct
 * path and through symlink/hardlink aliases that resolve onto it (mounts are
 * pathname-level, evaluated after symlink resolution).
 *
 * The default configuration is empty — protection is opt-in per deployment,
 * never a silent change to standing behavior. Non-bwrap rungs cannot express
 * pathname shadowing and fail closed, exactly like the net plugin.
 * @module @hourglass/sandbox-read
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ConfinedArgv, SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'

export const name = 'hourglass-sandbox-read'

export const inject = ['sandbox']

export interface Config {
  /** Paths whose content must be unobtainable inside the sandbox. */
  denyRead?: string[]
  /** Optional JSONL audit trail of what was shadowed on each confine. */
  decisionLog?: string
}

export const Config: z<Config> = z.object({
  denyRead: z.array(z.string()).default([]),
  decisionLog: z.string(),
})

/** Rewrite one bwrap wrap so every deny-read path is shadowed by empty tmpfs. */
export function wrapConfinedForReadShadowing(confined: ConfinedArgv, denyRead: readonly string[]): ConfinedArgv {
  if (confined.argv.length === 0 || confined.argv[0] !== 'bwrap') {
    throw new SandboxUnavailableError(
      `read protection cannot be enforced on a non-bwrap rung (argv0=${JSON.stringify(confined.argv[0])}); refusing to run`,
    )
  }
  const separator = confined.argv.indexOf('--')
  if (separator < 0) {
    throw new SandboxUnavailableError('read protection: bwrap argv has no "--" separator; refusing to guess')
  }
  const bwrapArgs = confined.argv.slice(0, separator)
  const command = confined.argv.slice(separator + 1)
  for (const denied of denyRead) {
    bwrapArgs.push('--tmpfs', denied)
  }
  return { ...confined, argv: [...bwrapArgs, '--', ...command] }
}

export function apply(ctx: Context, config: Config): void {
  const denyRead = config.denyRead ?? []
  if (denyRead.length === 0) return
  const provider = ctx.sandbox as unknown as { confine: SandboxProvider['confine'] }
  const originalConfine = provider.confine.bind(provider)
  provider.confine = async (argv: readonly string[], policyRequest: Parameters<SandboxProvider['confine']>[1], signal?: AbortSignal) => {
    const confined = await originalConfine(argv, policyRequest, signal)
    return wrapConfinedForReadShadowing(confined, denyRead)
  }
  ctx.effect(() => () => {
    provider.confine = originalConfine
  })
}
