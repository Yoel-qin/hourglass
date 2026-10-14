/**
 * hourglass sandbox-rsrc plugin (P3): kernel-enforced resource quotas on the
 * bwrap rung. A prlimit(1) prefix is injected immediately before the wrapped
 * command, so every descendant inherits hard caps (RLIMIT_NPROC, RLIMIT_AS,
 * RLIMIT_CPU, RLIMIT_FSIZE, RLIMIT_NOFILE). The limits are kernel semantics:
 * a breach fails the allocating call (or kills on RLIMIT_CPU) — never the
 * host. Empty config changes nothing; non-bwrap rungs fail closed.
 * @module @hourglass/sandbox-rsrc
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ConfinedArgv, SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'

export const name = 'hourglass-sandbox-rsrc'

export const inject = ['sandbox']

export interface Config {
  /** Max processes for the sandboxed user (RLIMIT_NPROC). */
  nproc?: number
  /** Max address space in bytes (RLIMIT_AS). */
  asBytes?: number
  /** Max CPU seconds (RLIMIT_CPU; overrun is SIGKILLed). */
  cpuSeconds?: number
  /** Max file size in bytes (RLIMIT_FSIZE). */
  fsizeBytes?: number
  /** Max open file descriptors (RLIMIT_NOFILE). */
  nofile?: number
}

export const Config: z<Config> = z.object({
  nproc: z.number(),
  asBytes: z.number(),
  cpuSeconds: z.number(),
  fsizeBytes: z.number(),
  nofile: z.number(),
})

/** prlimit argv fragments for the configured caps, in a stable order. */
export function prlimitArgs(config: Config): string[] {
  const args: string[] = []
  if (config.nproc !== undefined) args.push(`--nproc=${config.nproc}`)
  if (config.asBytes !== undefined) args.push(`--as=${config.asBytes}`)
  if (config.cpuSeconds !== undefined) args.push(`--cpu=${config.cpuSeconds}`)
  if (config.fsizeBytes !== undefined) args.push(`--fsize=${config.fsizeBytes}`)
  if (config.nofile !== undefined) args.push(`--nofile=${config.nofile}`)
  return args
}

/**
 * The uid the nproc cap drops to. RLIMIT_NPROC is enforced per real UID and
 * is kernel-exempted for processes holding CAP_SYS_ADMIN/CAP_SYS_RESOURCE —
 * which sandboxed root always has inside its user namespace. Dropping to an
 * unprivileged uid (nobody) makes the cap bite; the trade-off is that the
 * sandboxed process then needs ordinary file permissions to write.
 */
export const NPROC_DROP_UID = 65534

/**
 * Rewrite one confined argv so the command runs under the configured hard
 * caps. Works with a bare wrap (bwrap … -- cmd) and with the net plugin's
 * launcher (… -- /bin/sh launch.sh cmd): prlimit is inserted immediately
 * before the command either way. When an nproc cap is configured, the command
 * additionally runs as an unprivileged uid via setpriv — see NPROC_DROP_UID.
 */
export function wrapConfinedForResourceLimits(confined: ConfinedArgv, config: Config): ConfinedArgv {
  const limits = prlimitArgs(config)
  if (limits.length === 0) return confined
  if (confined.argv.length === 0 || confined.argv[0] !== 'bwrap') {
    throw new SandboxUnavailableError(
      `resource quotas cannot be enforced on a non-bwrap rung (argv0=${JSON.stringify(confined.argv[0])}); refusing to run`,
    )
  }
  const separator = confined.argv.indexOf('--')
  if (separator < 0) {
    throw new SandboxUnavailableError('resource quotas: bwrap argv has no "--" separator; refusing to guess')
  }
  const bwrapArgs = confined.argv.slice(0, separator)
  const command = confined.argv.slice(separator + 1)
  if (config.nproc === undefined) {
    return { ...confined, argv: [...bwrapArgs, '--', 'prlimit', ...limits, '--', ...command] }
  }
  return {
    ...confined,
    argv: [
      ...bwrapArgs,
      '--',
      'prlimit', ...limits, '--',
      'setpriv',
      `--reuid=${NPROC_DROP_UID}`, `--regid=${NPROC_DROP_UID}`, '--clear-groups',
      '--',
      ...command,
    ],
  }
}

export function apply(ctx: Context, config: Config): void {
  if (prlimitArgs(config).length === 0) return
  const provider = ctx.sandbox as unknown as { confine: SandboxProvider['confine'] }
  const originalConfine = provider.confine.bind(provider)
  provider.confine = async (argv: readonly string[], policyRequest: Parameters<SandboxProvider['confine']>[1], signal?: AbortSignal) => {
    const confined = await originalConfine(argv, policyRequest, signal)
    return wrapConfinedForResourceLimits(confined, config)
  }
  ctx.effect(() => () => {
    provider.confine = originalConfine
  })
}
