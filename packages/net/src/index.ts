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
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { connect as netConnect } from 'node:net'
import { startEgressProxy } from './proxy.ts'
import { bridgeScript, launcherScript, SandboxUnavailableError, wrapConfinedForNetwork } from './confine.ts'
import type { NetEgressPolicy } from './types.ts'

/**
 * Sweep orphaned runtime directories from crashed prior plugin instances
 * (ROB-05): an hourglass-net-* dir whose proxy socket no longer answers a
 * probe connection is dead — a live concurrent session's socket answers,
 * so only true orphans get removed. Await it before creating a new runtime.
 */
export async function sweepOrphanedRuntimes(tmpRoot: string = tmpdir()): Promise<number> {
  let entries: string[] = []
  try {
    entries = readdirSync(tmpRoot).filter(name => name.startsWith('hourglass-net-'))
  } catch {
    return 0
  }
  const probes = entries.map(name => new Promise<boolean>(resolve => {
    const dir = join(tmpRoot, name)
    const socketPath = join(dir, 'proxy.sock')
    if (!existsSync(socketPath)) {
      resolve(false)
      return
    }
    const probe = netConnect({ path: socketPath })
    probe.setTimeout(500)
    probe.on('connect', () => {
      probe.destroy()
      resolve(true)
    })
    const dead = (): void => {
      probe.destroy()
      resolve(false)
    }
    probe.on('error', dead)
    probe.on('timeout', dead)
  }).then(alive => {
    if (!alive) {
      rmSync(join(tmpRoot, name), { recursive: true, force: true })
      return 1
    }
    return 0
  }))
  const removed = await Promise.all(probes)
  return removed.reduce((sum, count) => sum + count, 0)
}

export const name = 'hourglass-sandbox-net'

export const inject = ['sandbox']

/**
 * Duplicate-mount guard (ROB-06): cordis reuses the runtime record and
 * silently starts a second fiber for a repeated `ctx.plugin()` call, which
 * would chain a second proxy wrap onto the provider. The plugin therefore
 * refuses a second mount itself — set on the provider while mounted.
 */
const MOUNT_GUARD = Symbol('hourglass.sandbox-net.mounted')

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

  // ROB-06: refuse a duplicate mount before creating anything. Without this
  // guard a second `ctx.plugin()` would chain a second wrap + proxy onto the
  // provider (cordis does not reject repeated loads itself).
  const provider = ctx.sandbox as unknown as { confine: SandboxProvider['confine'] } & { [MOUNT_GUARD]?: boolean }
  if (provider[MOUNT_GUARD] === true) {
    throw new Error('hourglass sandbox-net: refusing a duplicate mount on the same sandbox provider; dispose the existing instance first')
  }
  provider[MOUNT_GUARD] = true

  // Materialize the runtime pieces: proxy socket, bridge, launcher. Any
  // runtime left behind by a crashed earlier instance is swept (ROB-05); the
  // sweep runs concurrently with setup but every confine awaits it before
  // touching the proxy (see proxyReady chain below).
  const sweep = sweepOrphanedRuntimes()
  const runtimeDir = join(tmpdir(), `hourglass-net-${randomUUID()}`)
  mkdirSync(runtimeDir, { recursive: true })
  const socketPath = join(runtimeDir, 'proxy.sock')
  const bridgePath = join(runtimeDir, 'bridge.mjs')
  const launcherPath = join(runtimeDir, 'launch.sh')
  writeFileSync(bridgePath, bridgeScript(), { encoding: 'utf8', mode: 0o644 })
  writeFileSync(launcherPath, launcherScript(), { encoding: 'utf8', mode: 0o755 })
  recordFact({ kind: 'mode', allowed: false, reason: `network egress ${policy.mode} with allowlist [${policy.allowlist.join(', ')}]` })

  const originalConfine = provider.confine.bind(provider)
  let proxyPromise: Promise<{ stop(): Promise<void> }> | undefined
  let proxyReady: Promise<void> | undefined

  provider.confine = async (argv: readonly string[], policyRequest: Parameters<SandboxProvider['confine']>[1], signal?: AbortSignal) => {
    // The orphan sweep and the proxy startup both run asynchronously from
    // plugin load; the first confine awaits both instead of racing them.
    await sweep
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
    delete provider[MOUNT_GUARD]
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
