/**
 * DSH-PLUGIN driver: a real tool pipeline with the hourglass audit plugin.
 * Boots the same core the testkit provides, registers a shell tool whose
 * body runs through ctx.sandbox.confine and whose canonical value stamps the
 * consumer's sandbox facts (the tool-bash contract), then executes calls and
 * prints the audit ledger the plugin wrote.
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

interface PluginDriverRequest {
  commands: { callId: string; tool: string; arguments: Record<string, unknown> }[]
  mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  workspaceRoot: string
  ledgerPath: string
  cwd?: string
  /** Optional network-egress policy: P3 cases run allowlisted, others omit it. */
  net?: { mode: 'allowlist' | 'deny-all' | 'unrestricted'; allowlist?: string[] }
  /** ROB-02: after plugins mount, kill the egress proxy socket; every later confine must refuse. */
  netFail?: boolean
  /** AUD-15: run without any confinement (danger semantics) — the audit trail must still record it. */
  danger?: boolean
  /** ROB-06: attempt a SECOND net-plugin load with a conflicting config; the duplicate must be rejected loudly. */
  doubleNet?: { mode: 'allowlist' | 'deny-all' | 'unrestricted'; allowlist?: string[] }
  /** P2-DENY-READ cases: sensitive paths shadowed by tmpfs inside the sandbox. */
  readDeny?: string[]
  /** P4 cases: kernel-enforced hard caps injected via prlimit. */
  rsrc?: { nproc?: number; asBytes?: number; cpuSeconds?: number; fsizeBytes?: number; nofile?: number }
  /** ROB-01 supports: force a single-rung chain with a missing runner. */
  runnerCommand?: string[]
  forceChain?: string[]
}

interface PluginDriverResponse {
  ok: boolean
  results: { callId: string; isError: boolean; error?: { code?: string; message: string }; stdout: string; stderr: string }[]
  ledger: unknown[]
  error?: string
  /** ROB-06: whether the conflicting second plugin load was rejected. */
  duplicateRejected?: boolean
}

async function main(): Promise<void> {
  const request = JSON.parse(readFileSync(0, 'utf8')) as PluginDriverRequest
  const ctx = new Context()
  const response: PluginDriverResponse = { ok: true, results: [], ledger: [] }
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalSandboxProvider, request.runnerCommand === undefined ? {} : { runnerCommand: request.runnerCommand })
  if (request.forceChain !== undefined) {
    ;(ctx.sandbox as { internals?: { chain?: string[] } }).internals = { chain: request.forceChain }
  }
  await ctx.plugin(AuditPlugin, { ledgerPath: request.ledgerPath })
  if (request.net !== undefined) {
    await ctx.plugin(NetPlugin, {
      mode: request.net.mode,
      allowlist: request.net.allowlist ?? [],
      decisionLog: `${request.ledgerPath}.net-decisions.jsonl`,
    })
  }
  if (request.readDeny !== undefined && request.readDeny.length > 0) {
    await ctx.plugin(ReadPlugin, { denyRead: request.readDeny })
  }
  if (request.rsrc !== undefined) {
    await ctx.plugin(RsrcPlugin, request.rsrc)
  }
  if (request.doubleNet !== undefined) {
    // ROB-06: a second, conflicting load must throw — never a silent second
    // provider. The rejection is recorded and the FIRST instance keeps its
    // semantics.
    try {
      await ctx.plugin(NetPlugin, {
        mode: request.doubleNet.mode,
        allowlist: request.doubleNet.allowlist ?? [],
        decisionLog: `${request.ledgerPath}.dup-decisions.jsonl`,
      })
      response.duplicateRejected = false
    } catch {
      response.duplicateRejected = true
    }
  }
  if (request.netFail === true && request.net !== undefined) {
    // Phase 1 confine reveals the proxy socket path (the --ro-bind whose
    // TARGET is the in-sandbox proxy socket); removing the source simulates a
    // dead egress provider. Every later confine must fail closed.
    const probe = await ctx.sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: request.workspaceRoot })
    const targetIndex = probe.argv.indexOf('/tmp/.hourglass/proxy.sock')
    const socketPath = targetIndex > 0 ? probe.argv[targetIndex - 1] : undefined
    if (socketPath !== undefined && !socketPath.startsWith('/dev') && socketPath !== '/') {
      const { rmSync } = await import('node:fs')
      rmSync(socketPath, { force: true })
    }
  }
  ctx.tools.register(defineTool({
    name: 'sh',
    description: 'sandboxed shell (hourglass compare driver)',
    parameters: {
      command: { type: 'string', required: true },
    } as never,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exitCode: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          sandbox: {
            type: 'object',
            additionalProperties: false,
            properties: {
              mode: { type: 'string' },
              denied: { type: 'boolean' },
              enforcement: { type: 'string' },
              runnerFailed: { type: 'boolean' },
            },
          },
        },
      } as never,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const command = (args as { command: string }).command
      // danger-full-access skips confine entirely (the DSH contract: danger
      // is the no-confinement mode); the call still flows through the audit
      // pipeline, which is what AUD-15 verifies.
      let argv: string[]
      let denialSignatures: readonly string[]
      if (request.mode === 'danger-full-access') {
        argv = ['bash', '-c', command]
        denialSignatures = []
      } else {
        const confined = await ctx.sandbox.confine(['bash', '-c', command], {
          mode: request.mode,
          workspaceRoot: request.workspaceRoot,
        })
        argv = confined.argv
        denialSignatures = confined.denialSignatures
      }
      // Asynchronous spawn is load-bearing: the host-side egress proxy lives
      // in THIS process, and a synchronous spawn would freeze the event loop
      // the proxy needs to answer the sandbox through the bridge.
      const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
        const child = spawn(argv[0] as string, argv.slice(1), {
          cwd: request.cwd ?? process.cwd(),
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
        && denialSignatures.some(signature => (result.stderr ?? '').toLowerCase().includes(signature.toLowerCase()))
      return {
        exitCode: result.status ?? -1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        sandbox: {
          mode: request.mode,
          denied,
          ...(request.mode === 'danger-full-access' ? {} : { enforcement: 'full' as const }),
        },
      }
    },
  }))
  // A harness-mediated fetch tool (NET-13): like the real web-fetch tool it
  // runs INSIDE the harness process — no confine, no sandbox. Whether its
  // traffic is bound by any policy is exactly what NET-13 measures.
  ctx.tools.register(defineTool({
    name: 'web_fetch',
    description: 'harness-mediated fetch (hourglass compare driver)',
    parameters: {
      url: { type: 'string', required: true },
      canary: { type: 'string' },
    } as never,
    output: {
      schema: { type: 'string' } as never,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const { url, canary } = args as { url: string; canary?: string }
      try {
        const response = await fetch(url, { method: 'POST', body: canary ?? '', signal: AbortSignal.timeout(10_000) })
        const body = await response.text()
        return `status=${response.status} body=${body.slice(0, 120)}`
      } catch (error) {
        return `fetch-failed: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  }))
  // A tool that always fails by throwing — the honest "ordinary failure"
  // signal for AUD classification (a non-zero bash exit is a *successful*
  // tool result carrying exitCode in its value, per the bash-sandbox contract).
  ctx.tools.register(defineTool({
    name: 'sh-fails',
    description: 'always-failing probe (hourglass compare driver)',
    parameters: {} as never,
    output: {
      schema: { type: 'string' } as never,
      render: () => [{ type: 'text', text: 'failed' }],
    },
    async execute() {
      throw new Error('hourglass: deliberate ordinary failure')
    },
  }))
  const signal = new AbortController().signal
  for (const command of request.commands) {
    const result = await ctx.tools.execute({
      signal,
      callId: ToolCallId(command.callId),
      name: command.tool,
      arguments: command.arguments,
    })
    response.results.push({
      callId: command.callId,
      isError: result.isError,
      ...(result.isError
        ? { error: { code: result.error.info?.code, message: result.error.message } }
        : {}),
      stdout: result.content.map(block => block.type === 'text' ? block.text : '').join(''),
      stderr: '',
    })
  }
  const ledgerText = readFileSync(request.ledgerPath, 'utf8').trim()
  response.ledger = ledgerText === '' ? [] : ledgerText.split('\n').map(line => JSON.parse(line) as unknown)
  process.stdout.write(`${JSON.stringify(response)}\n`)
  await ctx.fiber.dispose()
}

await main()
