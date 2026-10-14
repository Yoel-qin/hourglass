import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
import * as NetPlugin from '../src/index.ts'
import { startEgressProxy } from '../src/proxy.ts'
import { bridgeScript, isBwrapArgv, launcherScript, wrapConfinedForNetwork } from '../src/confine.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hourglass-net-'))
  dirs.push(dir)
  return dir
}

function proxiedRequest(socketPath: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: 'GET', headers: { host: 'ignored' } }, res => {
      let body = ''
      res.on('data', chunk => {
        body += String(chunk)
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('egress proxy', () => {
  it('allows an allowlisted host and forwards to the upstream', async () => {
    const dir = tempDir()
    const upstream = (await import('node:http')).createServer((_req, res) => {
      res.writeHead(200)
      res.end('upstream-ok')
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const port = (upstream.address() as { port: number }).port
    const proxy = await startEgressProxy(join(dir, 'p.sock'), { mode: 'allowlist', allowlist: ['127.0.0.1'] })
    try {
      const res = await proxiedRequest(proxy.socketPath, `http://127.0.0.1:${port}/x`)
      expect(res.status).toBe(200)
      expect(res.body).toContain('upstream-ok')
      expect(proxy.decisions).toHaveLength(1)
      expect(proxy.decisions[0]!.allowed).toBe(true)
    } finally {
      await proxy.stop()
      upstream.close()
    }
  })

  it('denies a non-allowlisted host with 403 and records the decision', async () => {
    const dir = tempDir()
    const proxy = await startEgressProxy(join(dir, 'p.sock'), { mode: 'allowlist', allowlist: ['allow.tests.local'] })
    try {
      const res = await proxiedRequest(proxy.socketPath, 'http://deny.tests.local:8080/y')
      expect(res.status).toBe(403)
      expect(proxy.decisions[0]!.allowed).toBe(false)
      expect(proxy.decisions[0]!.reason).toContain('not in allowlist')
    } finally {
      await proxy.stop()
    }
  })

  it('an empty allowlist denies everything (NET-10 semantics)', async () => {
    const dir = tempDir()
    const proxy = await startEgressProxy(join(dir, 'p.sock'), { mode: 'allowlist', allowlist: [] })
    try {
      const res = await proxiedRequest(proxy.socketPath, 'http://allow.tests.local/z')
      expect(res.status).toBe(403)
      expect(proxy.decisions[0]!.reason).toContain('deny-all')
    } finally {
      await proxy.stop()
    }
  })

  it('invalid host literals are rejected outright', async () => {
    const dir = tempDir()
    const proxy = await startEgressProxy(join(dir, 'p.sock'), { mode: 'allowlist', allowlist: ['allow.tests.local'] })
    try {
      const res = await proxiedRequest(proxy.socketPath, 'http://bad_host/z')
      expect(res.status).toBe(403)
      expect(proxy.decisions[0]!.reason).toContain('invalid host literal')
    } finally {
      await proxy.stop()
    }
  })

  it('appends decisions to the JSONL decision log when configured', async () => {
    const dir = tempDir()
    const logPath = join(dir, 'decisions.jsonl')
    const proxy = await startEgressProxy(join(dir, 'p.sock'), { mode: 'deny-all', allowlist: [] }, logPath)
    try {
      await proxiedRequest(proxy.socketPath, 'http://anywhere.local/q')
      const lines = readFileSync(logPath, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0]!).allowed).toBe(false)
    } finally {
      await proxy.stop()
    }
  })
})

describe('confine rewriting', () => {
  const confined: ConfinedArgv = {
    argv: ['bwrap', '--ro-bind', '/', '/', '--', 'bash', '-c', 'echo hi'],
    enforcement: 'full',
    denialSignatures: ['read-only file system'],
    runnerFailureRules: [],
  }
  const options = { proxySocketPath: '/tmp/p.sock', bridgePath: '/tmp/bridge.mjs', launcherPath: '/tmp/launch.sh' }

  it('recognizes bwrap argv', () => {
    expect(isBwrapArgv(['bwrap', '--ro-bind'])).toBe(true)
    expect(isBwrapArgv(['/opt/landlock-run'])).toBe(false)
    expect(isBwrapArgv([])).toBe(false)
  })

  it('adds --unshare-net, the three binds, and the launcher before the command', () => {
    const wrapped = wrapConfinedForNetwork(confined, options)
    const separator = wrapped.argv.indexOf('--')
    expect(separator).toBeGreaterThan(0)
    const bwrapPart = wrapped.argv.slice(0, separator)
    expect(bwrapPart).toContain('--unshare-net')
    expect(bwrapPart.join(' ')).toContain('--dir /tmp/.hourglass')
    expect(bwrapPart.join(' ')).toContain('--ro-bind /tmp/p.sock /tmp/.hourglass/proxy.sock')
    expect(wrapped.argv.slice(separator + 1)).toEqual(['/bin/sh', '/tmp/.hourglass/launch.sh', 'bash', '-c', 'echo hi'])
    expect(wrapped.enforcement).toBe(confined.enforcement)
    expect(wrapped.denialSignatures).toBe(confined.denialSignatures)
  })

  it('fails closed on a non-bwrap rung', () => {
    expect(() => wrapConfinedForNetwork({ ...confined, argv: ['landlock-run', '--', 'bash'] }, options))
      .toThrow(/cannot be enforced on a non-bwrap rung/)
  })

  it('fails closed when the separator is missing', () => {
    expect(() => wrapConfinedForNetwork({ ...confined, argv: ['bwrap', '--ro-bind', '/', '/'] }, options))
      .toThrow(/no "--" separator/)
  })

  it('the launcher exports proxy env, boots the bridge, and execs the command', () => {
    const script = launcherScript()
    expect(script).toContain('HTTP_PROXY=http://127.0.0.1:3128')
    expect(script).toContain('NO_PROXY=localhost,127.0.0.1')
    expect(script).toContain('exec "$@"')
    expect(script).toContain('node /tmp/.hourglass/bridge.mjs')
  })

  it('the bridge relays loopback TCP to the bind-mounted unix socket', () => {
    const script = bridgeScript()
    expect(script).toContain('connect("/tmp/.hourglass/proxy.sock")')
    expect(script).toContain("server.listen(3128, '127.0.0.1',")
    expect(script).toContain("writeFileSync(\"/tmp/.hourglass-ready\"")
  })
})

describe('hourglass-sandbox-net plugin', () => {
  class FakeProvider extends SandboxProvider {
    async confine(argv: readonly string[]): Promise<ConfinedArgv> {
      return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
    }
  }

  it('unrestricted mode replaces nothing and records the fact', async () => {
    const dir = tempDir()
    const logPath = join(dir, 'net-decisions.jsonl')
    const ctx = new Context()
    await ctx.plugin(FakeProvider)
    const plugin = await ctx.plugin(NetPlugin, { mode: 'unrestricted', decisionLog: logPath })
    // Behavior assertion (ctx.sandbox.confine is re-bound per access, so
    // identity checks are meaningless): the wrap must pass through untouched.
    const confined = await ctx.sandbox.confine(['bwrap', '--', 'true'])
    expect(confined.argv).toEqual(['bwrap', '--', 'true'])
    const fact = readFileSync(logPath, 'utf8').trim()
    expect(fact).toContain('unrestricted')
    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('restrictive mode rewrites confine results and restores on dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeProvider)
    const plugin = await ctx.plugin(NetPlugin, { mode: 'allowlist', allowlist: ['allow.tests.local'] })
    try {
      const confined = await ctx.sandbox.confine(['bwrap', '--', 'true'])
      expect(confined.argv).toContain('--unshare-net')
      expect(confined.argv).toContain('/tmp/.hourglass/launch.sh')
      // Fail-closed when the proxy socket vanished (simulated dead proxy).
      const runtimeSocket = confined.argv[confined.argv.indexOf('--ro-bind') + 1]
      rmSync(runtimeSocket, { force: true })
      await expect(ctx.sandbox.confine(['bwrap', '--', 'true'])).rejects.toThrow(/proxy socket is not up/)
    } finally {
      await plugin.dispose()
    }
    // After dispose the wrap passes through untouched again.
    const after = await ctx.sandbox.confine(['bwrap', '--', 'true'])
    expect(after.argv).toEqual(['bwrap', '--', 'true'])
    await ctx.fiber.dispose()
  })

  it('leaves no runtime directory behind after dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeProvider)
    const plugin = await ctx.plugin(NetPlugin, { mode: 'deny-all' })
    const confined = await ctx.sandbox.confine(['bwrap', '--', 'true'])
    const runtimeSocket = confined.argv[confined.argv.indexOf('--ro-bind') + 1]
    expect(existsSync(runtimeSocket)).toBe(true)
    const runtimeDir = join(runtimeSocket, '..')
    await plugin.dispose()
    expect(existsSync(runtimeDir)).toBe(false)
    await ctx.fiber.dispose()
  })
})
