/**
 * One-shot trial driver for the evolution safety sandbox (ADR-003 D2).
 *
 * Spawned as an INDEPENDENT child process by the trial launcher; this
 * process is where the confinement plugins are mounted, so every command
 * runs inside this process's bwrap chain (net -> read -> rsrc ->
 * LocalSandboxProvider.confine). Security properties, deliberately stricter
 * than the compare driver it is modeled on:
 *
 *   1. NO host egress tools are registered — no web_fetch, no MCP, no
 *      harness-side fetch of any kind (NET-13: harness tools are an
 *      independent egress the sandbox policy cannot bound; the only reliable
 *      control is physical absence).
 *   2. There is no danger/unrestricted mode on this path: every command is
 *      confined under workspace-write.
 *   3. The audit plugin runs in strict mode: a ledger write failure fails
 *      the trial instead of being silently dropped.
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as AuditPlugin from '@hourglass/sandbox-audit/src/index.ts'
import * as NetPlugin from '@hourglass/sandbox-net/src/index.ts'
import * as ReadPlugin from '@hourglass/sandbox-read/src/index.ts'
import * as RsrcPlugin from '@hourglass/sandbox-rsrc/src/index.ts'

interface DriverRequest {
  commands: { callId: string; command: string }[]
  workspaceRoot: string
  ledgerPath: string
  net: { mode: 'allowlist' | 'deny-all'; allowlist?: string[] }
  readDeny?: string[]
  rsrc?: { nproc?: number; asBytes?: number; cpuSeconds?: number; fsizeBytes?: number; nofile?: number }
}

interface DriverResult {
  callId: string
  exitCode: number
  stdout: string
  stderr: string
  denied: boolean
}

interface DriverResponse {
  ok: boolean
  driverPid: number
  results: DriverResult[]
  ledger: unknown[]
  error?: string
}

async function main(): Promise<void> {
  const request = JSON.parse(readFileSync(0, 'utf8')) as DriverRequest
  const response: DriverResponse = { ok: true, driverPid: process.pid, results: [], ledger: [] }
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalSandboxProvider, {})
  await ctx.plugin(AuditPlugin, { ledgerPath: request.ledgerPath, strict: true })
  await ctx.plugin(NetPlugin, {
    mode: request.net.mode,
    allowlist: request.net.allowlist ?? [],
    decisionLog: `${request.ledgerPath}.net-decisions.jsonl`,
  })
  if (request.readDeny !== undefined && request.readDeny.length > 0) {
    await ctx.plugin(ReadPlugin, { denyRead: request.readDeny })
  }
  if (request.rsrc !== undefined) {
    await ctx.plugin(RsrcPlugin, request.rsrc)
  }
  ctx.tools.register(defineTool({
    name: 'trial_exec',
    description: 'confined shell for evolution trials (workspace-write only, no host tools)',
    parameters: {
      command: { type: 'string', required: true },
    } as never,
    output: {
      schema: { type: 'string' } as never,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const command = (args as { command: string }).command
      const confined = await ctx.sandbox.confine(['bash', '-c', command], {
        mode: 'workspace-write',
        workspaceRoot: request.workspaceRoot,
      })
      // Asynchronous spawn is load-bearing: the egress proxy lives in THIS
      // process and a synchronous spawn would freeze the event loop it needs.
      const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
        const child = spawn(confined.argv[0] as string, confined.argv.slice(1), {
          cwd: request.workspaceRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', chunk => {
          stdout += String(chunk)
        })
        child.stderr.on('data', chunk => {
          stderr += String(chunk)
        })
        const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
        child.on('close', () => {
          clearTimeout(timer)
          resolve({ status: child.exitCode, stdout, stderr })
        })
      })
      const denied = result.status !== 0
        && confined.denialSignatures.some(signature => (result.stderr ?? '').toLowerCase().includes(signature.toLowerCase()))
      return JSON.stringify({
        exitCode: result.status ?? -1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        denied,
      })
    },
  }))
  const signal = new AbortController().signal
  for (const command of request.commands) {
    const result = await ctx.tools.execute({
      signal,
      callId: ToolCallId(command.callId),
      name: 'trial_exec',
      arguments: { command: command.command },
    })
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
    try {
      // The tool renders its value as JSON text; a string-typed execute value
      // comes out double-encoded, so unwrap once more when needed.
      const parsed: unknown = JSON.parse(text)
      const value = (typeof parsed === 'string' ? JSON.parse(parsed) : parsed) as Omit<DriverResult, 'callId'>
      response.results.push({ callId: command.callId, ...value })
    } catch {
      response.results.push({
        callId: command.callId,
        exitCode: -1,
        stdout: text,
        stderr: result.isError ? result.error.message : '',
        denied: false,
      })
    }
  }
  const ledgerText = readFileSync(request.ledgerPath, 'utf8').trim()
  response.ledger = ledgerText === '' ? [] : ledgerText.split('\n').map(line => JSON.parse(line) as unknown)
  process.stdout.write(`${JSON.stringify(response)}\n`)
  await ctx.fiber.dispose()
}

await main()
