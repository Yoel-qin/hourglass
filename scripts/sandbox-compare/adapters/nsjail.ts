/**
 * nsjail adapter (Linux lane only). nsjail gets namespace granularity:
 * read-only root bind plus explicit rw binds map the file profiles, and its
 * default isolated network namespace blocks all egress — including the
 * allowlisted host, which the runner reports honestly (nsjail cannot express
 * a domain allowlist; NET-01 is a real gap, never silently flipped).
 */

import { spawn } from 'node:child_process'
import type { CompareCase } from '../schema.ts'
import { renderTemplate } from '../cases.ts'
import type { RawExecution, RunEnv, SubjectAdapter } from './types.ts'

function nsjailArgv(caseDefinition: CompareCase, command: string, workspace: string): string[] {
  // No --silent here: nsjail's own logs go to stderr (ignored by verdicts),
  // but silencing also swallows the sandboxed process's stdio.
  const argv = ['nsjail', '--mode', 'o', '-R', '/', '--proc_rw']
  if (caseDefinition.profile !== 'P0-READONLY') {
    // Re-bind the workspace and tmp writable on top of the read-only root.
    argv.push('-B', workspace, '-B', '/tmp')
  }
  argv.push('--', '/bin/bash', '-c', command)
  return argv
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

export const nsjail: SubjectAdapter = {
  id: 'NSJAIL',
  async available() {
    if (process.platform !== 'linux') return { ok: false, reason: `nsjail is Linux-only; host is ${process.platform}` }
    const probe = await runCommand(['nsjail', '--help'], {}, 10_000)
    if (probe.exitCode === 0 || probe.stderr.includes('Usage')) return { ok: true }
    return { ok: false, reason: `nsjail not runnable (exit ${String(probe.exitCode)})` }
  },
  async execute(caseDefinition, env): Promise<RawExecution> {
    const command = caseDefinition.action.kind === 'shell'
      ? renderTemplate(caseDefinition.action.command, env.context)
      : caseDefinition.action.argv.join(' ')
    const raw = await runCommand(
      nsjailArgv(caseDefinition, command, env.context.workspace),
      { HG_PORT: String(env.context.port), HG_CANARY: env.context.canary, ...env.env },
      45_000,
    )
    return {
      ...raw,
      notes: ['network: nsjail runs in its own network namespace (all egress blocked, allowlist inexpressible)'],
    }
  },
}
