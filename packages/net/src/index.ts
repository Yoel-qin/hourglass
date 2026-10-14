/**
 * hourglass sandbox-net plugin. Under a restrictive mode it rewrites every
 * confine result of the mounted bwrap rung into a network-isolated wrap
 * (kernel netns + allowlist proxy over a unix socket); under
 * `unrestricted` it changes nothing and records that the mode was used
 * (AUD-15). Fails closed: a dead proxy or a non-bwrap rung refuses the call.
 * @module @hourglass/sandbox-net
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { startEgressProxy } from './proxy.ts'
import { bridgeScript, launcherScript, SandboxUnavailableError, wrapConfinedForNetwork } from './confine.ts'
import type { NetEgressPolicy } from './types.ts'

export const name = 'hourglass-sandbox-net'

export const inject = ['sandbox']

export interface Config {
  /** Egress policy mode; `unrestricted` leaves every existing semantic untouched. */
  mode?: 'deny-all' | 'allowlist' | 'unrestricted'
  /** Allowed hostnames (suffix-subdomain matching, normalized per NET-09). */
  allowlist?: string[]
  /** Optional JSONL decision log (every proxy decision and the mode fact). */
  decisionLog?: string
}

export const Config: z<Config> = z.object({
  mode: z.union(['deny-all', 'allowlist', 'unrestricted']).default('unrestricted'),
  allowlist: z.array(z.string()).default([]),
  decisionLog: z.string(),
})

export function apply(ctx: Context, config: Config): void {
  const policy: NetEgressPolicy = {
    mode: config.mode ?? 'unrestricted',
    allowlist: config.allowlist ?? [],
  }
  const recordFact = (fact: Record<string, unknown>): void => {
    if (config.decisionLog === undefined) return
    try {
      appendFileSync(config.decisionLog, `${JSON.stringify({ at: new Date().toISOString(), ...fact })}\n`, { encoding: 'utf8' })
    } catch {
      // Auditing must never weaken enforcement; a failing log stays visible
      // through proxy diagnostics instead.
    }
  }

  if (policy.mode === 'unrestricted') {
    // AUD-15: unrestricted (incl. danger-full-access) usage is itself an
    // audited fact; semantics are untouched either way.
    recordFact({ kind: 'mode', allowed: true, reason: 'network egress unrestricted — mode recorded, no enforcement applied' })
    return
  }

  // Materialize the runtime pieces: proxy socket, bridge, launcher.
  const runtimeDir = join(tmpdir(), `hourglass-net-${randomUUID()}`)
  mkdirSync(runtimeDir, { recursive: true })
  const socketPath = join(runtimeDir, 'proxy.sock')
  const bridgePath = join(runtimeDir, 'bridge.mjs')
  const launcherPath = join(runtimeDir, 'launch.sh')
  writeFileSync(bridgePath, bridgeScript(), { encoding: 'utf8', mode: 0o644 })
  writeFileSync(launcherPath, launcherScript(), { encoding: 'utf8', mode: 0o755 })
  recordFact({ kind: 'mode', allowed: false, reason: `network egress ${policy.mode} with allowlist [${policy.allowlist.join(', ')}]` })

  const provider = ctx.sandbox as unknown as { confine: SandboxProvider['confine'] }
  const originalConfine = provider.confine.bind(provider)
  let proxyPromise: Promise<{ stop(): Promise<void> }> | undefined
  let proxyReady: Promise<void> | undefined

  provider.confine = async (argv: readonly string[], policyRequest: Parameters<SandboxProvider['confine']>[1], signal?: AbortSignal) => {
    // The proxy starts asynchronously at plugin load; the first confine
    // awaits readiness instead of racing it.
    if (proxyReady !== undefined) await proxyReady
    // Fail closed before any wrap work when the proxy is not alive.
    if (!existsSync(socketPath)) {
      throw new SandboxUnavailableError('hourglass sandbox-net: egress proxy socket is not up; refusing to run unconfined')
    }
    const confined = await originalConfine(argv, policyRequest, signal)
    return wrapConfinedForNetwork(confined, { proxySocketPath: socketPath, bridgePath, launcherPath })
  }

  const restore = (): void => {
    provider.confine = originalConfine
  }

  proxyPromise = startEgressProxy(socketPath, policy, config.decisionLog)
  proxyReady = proxyPromise.then(() => undefined, () => undefined)
  ctx.effect(() => () => {
    restore()
    // Synchronous cleanup so dispose leaves nothing behind; the server's own
    // close runs in the background and fails harmlessly against the removed
    // socket file.
    rmSync(runtimeDir, { recursive: true, force: true })
    void proxyPromise?.then(proxy => proxy.stop()).catch(() => undefined)
  })
}
