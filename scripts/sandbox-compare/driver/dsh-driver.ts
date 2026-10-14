/**
 * DSH confinement driver, executed inside the built DSH workspace. Reads a
 * JSON request on stdin ({argv, mode, workspaceRoot, cwd, env, timeoutMs,
 * runnerCommand}) and prints one JSON line: either a confined spawn result
 * with the wrap's enforcement facts, or a fail-closed confine error.
 *
 * This mirrors how DSH's own bwrap e2e drives the provider (new Context +
 * ctx.plugin(LocalSandboxProvider) + confine + spawn).
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'

interface DriverRequest {
  argv: string[]
  mode: 'read-only' | 'workspace-write'
  workspaceRoot: string
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  /** When set, LocalSandboxProvider runs with this runnerCommand (ROB-01). */
  runnerCommand?: string[]
  /**
   * Force the provider's platform chain through its SandboxInternals test
   * hook (ROB-01): with a single candidate and a missing runner there is no
   * fallback rung, so confine must fail closed.
   */
  forceChain?: string[]
}

interface DriverResponse {
  ok: boolean
  enforcement?: 'full' | 'partial'
  denialSignatures?: readonly string[]
  status?: number | null
  signal?: NodeJS.Signals | null
  stdout?: string
  stderr?: string
  error?: string
  code?: string
}

async function main(): Promise<void> {
  const request = JSON.parse(readFileSync(0, 'utf8')) as DriverRequest
  const ctx = new Context()
  const config = request.runnerCommand === undefined ? {} : { runnerCommand: request.runnerCommand }
  await ctx.plugin(LocalSandboxProvider, config)
  if (request.forceChain !== undefined) {
    ;(ctx.sandbox as { internals?: { chain?: string[] } }).internals = { chain: request.forceChain }
  }
  let response: DriverResponse
  try {
    const confined = await ctx.sandbox.confine(request.argv, {
      mode: request.mode,
      workspaceRoot: request.workspaceRoot,
    })
    const result = spawnSync(confined.argv[0] as string, confined.argv.slice(1), {
      cwd: request.cwd ?? process.cwd(),
      encoding: 'utf8',
      timeout: request.timeoutMs ?? 30_000,
      env: { ...process.env, ...(request.env ?? {}) },
    })
    response = {
      ok: true,
      enforcement: confined.enforcement,
      denialSignatures: confined.denialSignatures,
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  } catch (error) {
    // fail-closed: confine itself refused — never a passthrough
    response = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: (error as { code?: string }).code,
    }
  }
  process.stdout.write(`${JSON.stringify(response)}\n`)
  await ctx.fiber.dispose()
}

await main()
