/**
 * Anthropic Sandbox Runtime adapter. SRT is configured through
 * ~/.srt-settings.json per run (HOME redirected into the test sandbox home),
 * mapping compare profiles onto SRT's deny/allow semantics:
 * - writes are allow-only (allowWrite)
 * - reads are deny-then-allow (denyRead)
 * - network is allow-only (allowedDomains), mediated by proxies
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CompareCase } from '../schema.ts'
import { ALLOW_HOST, DENY_HOST } from '../net-service.ts'
import { renderAction } from '../cases.ts'
import type { RawExecution, RunEnv, SubjectAdapter } from './types.ts'

interface SrtSettings {
  filesystem: {
    denyRead: string[]
    allowRead: string[]
    allowWrite: string[]
    denyWrite: string[]
  }
  network: {
    allowedDomains: string[]
    deniedDomains: string[]
  }
}

function settingsFor(caseDefinition: CompareCase, env: RunEnv): SrtSettings {
  const filesystem = {
    // denyRead targets the same synthetic sensitive directory the cases read.
    denyRead: [] as string[],
    allowRead: [] as string[],
    allowWrite: caseDefinition.profile === 'P0-READONLY' ? [] : [env.context.workspace],
    denyWrite: [] as string[],
  }
  const network = { allowedDomains: [ALLOW_HOST], deniedDomains: [] }
  if (caseDefinition.profile === 'P2-DENY-READ') {
    filesystem.denyRead = [env.context.sensitive]
  }
  if (caseDefinition.id === 'NET-10') {
    // Reverse test: an empty allowlist must deny everything.
    network.allowedDomains = []
  }
  void DENY_HOST
  return { filesystem, network }
}

function runCommand(argv: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<RawExecution> {
  const startedAt = Date.now()
  return new Promise(resolve => {
    const child = spawn(argv[0] as string, argv.slice(1), { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', () => {
      clearTimeout(timer)
      resolve({ exitCode: child.exitCode, stdout, stderr, durationMs: Date.now() - startedAt, notes: [] })
    })
  })
}

export const srt: SubjectAdapter = {
  id: 'SRT',
  async available() {
    const probe = await runCommand(['srt', '--version'], {}, 10_000)
    if (probe.exitCode === 0 || probe.stdout.includes('srt')) return { ok: true }
    return { ok: false, reason: `srt CLI not runnable (exit ${String(probe.exitCode)}): ${probe.stderr.slice(0, 200)}` }
  },
  async execute(caseDefinition, env): Promise<RawExecution> {
    // Fresh synthetic SRT home per case: settings live there; secrets stay in
    // the shared synthetic home the cases read from.
    const srtHome = join(env.context.workspace, '..', 'srt-home')
    mkdirSync(srtHome, { recursive: true })
    const settings = settingsFor(caseDefinition, env)
    writeFileSync(join(srtHome, '.srt-settings.json'), `${JSON.stringify(settings, null, 2)}\n`)
    const command = renderAction(caseDefinition.action, env.context)
    const raw = await runCommand(
      ['srt', 'bash', '-c', command],
      {
        HOME: srtHome,
        HG_PORT: String(env.context.port),
        HG_CANARY: env.context.canary,
        ...env.env,
      },
      45_000,
    )
    return {
      ...raw,
      notes: [`settings: ${JSON.stringify(settings)}`, `srt-home: ${srtHome}`],
    }
  },
}
