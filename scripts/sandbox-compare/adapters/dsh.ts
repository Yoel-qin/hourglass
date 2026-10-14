/**
 * DSH adapters (DSH-BASE and DSH-PLUGIN). Both drive the real
 * LocalSandboxProvider through the driver script inside the built DSH
 * workspace; the plugin variant additionally runs a real tool pipeline with
 * the hourglass audit plugin for AUD cases.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CompareCase, SubjectId } from '../schema.ts'
import { renderAction, renderToolArguments } from '../cases.ts'
import { ALLOW_HOST } from '../net-service.ts'
import type { RawExecution, RunEnv, SubjectAdapter } from './types.ts'

const DSH_ROOT = process.env.HG_DSH_ROOT ?? '/opt/dsh'
const DRIVER = join(DSH_ROOT, 'packages', 'hourglass', 'driver', 'dsh-driver.ts')
const PLUGIN_DRIVER = join(DSH_ROOT, 'packages', 'hourglass', 'driver', 'dsh-plugin-driver.ts')

/** Map compare profiles onto DSH SandboxMode values (vocabulary is file-effects only). */
function dshMode(profile: CompareCase['profile']): 'read-only' | 'workspace-write' {
  // P2-DENY-READ maps to workspace-write: DSH has no denyRead mechanism, so
  // FS-11/FS-12 under DSH report the honest gap (read succeeds) rather than
  // pretending a mechanism exists.
  return profile === 'P0-READONLY' ? 'read-only' : 'workspace-write'
}

/** Per-case hard caps the rsrc plugin applies under P4-RESOURCE-LIMITS. */
const RES_QUOTAS: Record<string, { nproc?: number; asBytes?: number; nofile?: number }> = {
  'RES-03': { asBytes: 100 * 1024 * 1024 },
  'RES-04': { nproc: 8 },
  'RES-06': { nofile: 32 },
}

function runNode(script: string, input: unknown, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<RawExecution> {
  const startedAt = Date.now()
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--experimental-strip-types', script], {
      cwd: DSH_ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
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
    child.stdin.write(`${JSON.stringify(input)}\n`)
    child.stdin.end()
  })
}

/**
 * NET-14 two-phase run: phase A spawns a detached curl (tagged -OLD) under NO
 * egress policy — the "pre-existing process"; phase B runs the case's own
 * command (tagged -NEW) under the allowlist. The verdict keys on -NEW; what
 * the -OLD process manages to reach is a disclosed lifecycle boundary, not a
 * silent bypass.
 */
async function runNet14(caseId: string, newCommand: string, env: RunEnv): Promise<RawExecution> {
  const startedAt = Date.now()
  const baseRequest = {
    mode: 'workspace-write' as const,
    workspaceRoot: env.context.workspace,
    cwd: env.context.workspace,
  }
  const oldSpawn = {
    ...baseRequest,
    ledgerPath: '/tmp/hourglass-net14-old.jsonl',
    commands: [{
      callId: `net14-old-${caseId}`,
      tool: 'sh',
      arguments: {
        command: `nohup sh -c 'sleep 6; curl -sS --max-time 4 ${env.context.denyUrl} -d ${env.context.canary}-OLD' >/dev/null 2>&1 & echo OLD_SPAWNED`,
      },
    }],
  }
  const newRun = {
    ...baseRequest,
    ledgerPath: '/tmp/hourglass-net14-new.jsonl',
    net: { mode: 'allowlist' as const, allowlist: [ALLOW_HOST] },
    commands: [{ callId: `net14-new-${caseId}`, tool: 'sh', arguments: { command: newCommand } }],
  }
  await runNode([PLUGIN_DRIVER], oldSpawn, env.env, 60_000)
  await new Promise(resolve => setTimeout(resolve, 1_000))
  const raw = await runNode([PLUGIN_DRIVER], newRun, env.env, 60_000)
  // Give the detached OLD process its window before the runner snapshots.
  await new Promise(resolve => setTimeout(resolve, 10_000))
  return {
    ...raw,
    durationMs: Date.now() - startedAt,
    notes: [
      'NET-14 phase A: pre-policy detached process spawned (canary -OLD)',
      'NET-14 phase B: case command under allowlist (canary -NEW)',
      'the -OLD process reaching the deny endpoint is a disclosed boundary; the verdict keys on -NEW',
    ],
  }
}

function baseAdapter(id: SubjectId): SubjectAdapter {
  return {
    id,
    async available() {
      return { ok: true }
    },
    async execute(caseDefinition, env): Promise<RawExecution> {
      const mode = dshMode(caseDefinition.profile)
      const command = renderAction(caseDefinition.action, env.context)
      const request = {
        argv: ['bash', '-lc', command],
        mode,
        workspaceRoot: env.context.workspace,
        cwd: env.context.workspace,
        env: { HG_PORT: String(env.context.port), HG_CANARY: env.context.canary, ...env.env },
        timeoutMs: 30_000,
        ...(caseDefinition.id === 'ROB-01'
          ? { runnerCommand: ['/nonexistent/hourglass-rob-runner'], forceChain: ['bwrap'] }
          : {}),
      }
      const raw = await runNode([DRIVER], request, env.env, 45_000)
      return {
        ...raw,
        notes: [`driver: ${DRIVER}`, `mode: ${mode}`],
      }
    },
  }
}

export const dshBase: SubjectAdapter = baseAdapter('DSH-BASE')

export const dshPlugin: SubjectAdapter = {
  ...baseAdapter('DSH-PLUGIN'),
  supportsAudit: true,
  async execute(caseDefinition, env): Promise<RawExecution> {
    // The plugin subject always runs the full governance composition (audit
    // ledger + optional net policy) through a real tool pipeline, so its
    // results demonstrate the plugins' semantics end-to-end.
    const command = caseDefinition.action.kind === 'tool'
      ? ''
      : renderAction(caseDefinition.action, env.context)
    const ledgerDir = mkdtempSync(join(tmpdir(), 'hourglass-aud-'))
    const ledgerPath = join(ledgerDir, 'audit.jsonl')
    const net = caseDefinition.profile === 'P3-NET-ALLOWLIST'
      ? { mode: 'allowlist' as const, allowlist: caseDefinition.id === 'NET-10' ? [] : [ALLOW_HOST] }
      : undefined
    const quota = caseDefinition.profile === 'P4-RESOURCE-LIMITS' ? RES_QUOTAS[caseDefinition.id] : undefined
    const readDeny = caseDefinition.profile === 'P2-DENY-READ'
      ? [env.context.sensitive]
      : undefined
    const request = {
      commands: caseDefinition.action.kind === 'tool'
        ? [{
            callId: `aud-${caseDefinition.id}`,
            tool: caseDefinition.action.tool,
            arguments: renderToolArguments(caseDefinition.action, env.context),
          }]
        : [
            { callId: `aud-${caseDefinition.id}`, tool: 'sh', arguments: { command } },
            ...(caseDefinition.category === 'aud'
              ? [{ callId: `aud-${caseDefinition.id}-failing`, tool: 'sh-fails', arguments: {} }]
              : []),
          ],
      mode: dshMode(caseDefinition.profile),
      workspaceRoot: env.context.workspace,
      ledgerPath,
      cwd: env.context.workspace,
      ...(net === undefined ? {} : { net }),
      ...(readDeny === undefined ? {} : { readDeny }),
      ...(quota === undefined ? {} : { rsrc: quota }),
      ...(caseDefinition.id === 'ROB-01'
        ? { runnerCommand: ['/nonexistent/hourglass-rob-runner'], forceChain: ['bwrap'] }
        : {}),
    }
    const raw = caseDefinition.id === 'NET-14'
      ? await runNet14(caseDefinition.id, command, env)
      : await runNode([PLUGIN_DRIVER], request, env.env, 90_000)
    return {
      ...raw,
      notes: [
        `driver: ${PLUGIN_DRIVER}`,
        `ledger: ${ledgerPath}`,
        ...(net === undefined ? [] : [`net: ${JSON.stringify(net)}`]),
      ...(quota === undefined ? [] : [`rsrc: ${JSON.stringify(quota)}`]),
      ],
    }
  },
}
