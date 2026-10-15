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
function dshMode(profile: CompareCase['profile']): 'read-only' | 'workspace-write' | 'danger-full-access' {
  // P2-DENY-READ maps to workspace-write: DSH has no denyRead mechanism, so
  // FS-11/FS-12 under DSH report the honest gap (read succeeds) rather than
  // pretending a mechanism exists.
  if (profile === 'P0-READONLY') return 'read-only'
  if (profile === 'DANGER-FULL-ACCESS') return 'danger-full-access'
  return 'workspace-write'
}

/** Per-case hard caps the rsrc plugin applies under P4-RESOURCE-LIMITS. */
const RES_QUOTAS: Record<string, { nproc?: number; asBytes?: number; nofile?: number; cpuSeconds?: number; fsizeBytes?: number }> = {
  'RES-02': { cpuSeconds: 2 },
  'RES-03': { asBytes: 100 * 1024 * 1024 },
  'RES-04': { nproc: 8 },
  'RES-05': { fsizeBytes: 64 * 1024 },
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
 * RES-07: spawn the sleeper command, SIGTERM the driver child mid-flight,
 * and report; the verdict converges the process tree via pgrep.
 */
async function runRes07(command: string, env: RunEnv): Promise<RawExecution> {
  const startedAt = Date.now()
  const request = {
    commands: [{ callId: 'res-07', tool: 'sh', arguments: { command } }],
    mode: 'workspace-write' as const,
    workspaceRoot: env.context.workspace,
    cwd: env.context.workspace,
    ledgerPath: '/tmp/hourglass-res07.jsonl',
  }
  const raw = await new Promise<RawExecution>(resolve => {
    const child = spawn(process.execPath, ['--experimental-strip-types', PLUGIN_DRIVER], {
      cwd: DSH_ROOT,
      env: { ...process.env, ...env.env },
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
    child.stdin.write(`${JSON.stringify(request)}\n`)
    child.stdin.end()
    const term = setTimeout(() => child.kill('SIGTERM'), 3_000)
    const hardKill = setTimeout(() => child.kill('SIGKILL'), 15_000)
    child.on('close', () => {
      clearTimeout(term)
      clearTimeout(hardKill)
      resolve({ exitCode: child.exitCode, stdout, stderr, durationMs: Date.now() - startedAt, notes: ['RES-07: driver SIGTERMed 3s into a 30s command'] })
    })
  })
  // Let any survivor show itself before the verdict greps.
  await new Promise(resolve => setTimeout(resolve, 1_500))
  return raw
}

/**
 * RES-08: session A (no caps) and session B (100MB RLIMIT_AS) run the same
 * 200MB allocation concurrently; A must succeed while B is refused.
 */
async function runRes08(command: string, env: RunEnv): Promise<RawExecution> {
  const startedAt = Date.now()
  const base = {
    mode: 'workspace-write' as const,
    workspaceRoot: env.context.workspace,
    cwd: env.context.workspace,
  }
  const sessionA = { ...base, ledgerPath: '/tmp/hourglass-res08-a.jsonl', commands: [{ callId: 'res-08-a', tool: 'sh', arguments: { command } }] }
  const sessionB = {
    ...base,
    ledgerPath: '/tmp/hourglass-res08-b.jsonl',
    rsrc: { asBytes: 100 * 1024 * 1024 },
    commands: [{ callId: 'res-08-b', tool: 'sh', arguments: { command } }],
  }
  const [a, b] = await Promise.all([
    runNode([PLUGIN_DRIVER], sessionA, env.env, 60_000),
    runNode([PLUGIN_DRIVER], sessionB, env.env, 60_000),
  ])
  // The refusal signature (MemoryError) sits in the FRONT of B's driver JSON
  // (the results array), not the tail (ledger records) — extract it here so
  // the verdict does not depend on JSON layout.
  const bRefused = /MemoryError|Cannot allocate/.test(b.stdout) || /MemoryError|Cannot allocate/.test(b.stderr)
  return {
    ...a,
    durationMs: Date.now() - startedAt,
    notes: [
      `RES-08 session A (uncapped) exit=${String(a.exitCode)}`,
      `RES-08 session B (100MB cap) exit=${String(b.exitCode)} memoryRefused=${bRefused} head=${b.stdout.slice(0, 160)}`,
    ],
  }
}

/**
 * ROB-05: driver 1 mounts the net plugin (runtime created) and sleeps;
 * SIGKILL leaves the runtime behind. Driver 2 then starts normally — its
 * plugin sweep must remove the orphan and confine cleanly.
 */
async function runRob05(command: string, env: RunEnv): Promise<RawExecution> {
  const startedAt = Date.now()
  const base = {
    mode: 'workspace-write' as const,
    workspaceRoot: env.context.workspace,
    cwd: env.context.workspace,
    net: { mode: 'allowlist' as const, allowlist: [ALLOW_HOST] },
  }
  const victim = {
    ...base,
    ledgerPath: '/tmp/hourglass-rob05-1.jsonl',
    commands: [{ callId: 'rob05-victim', tool: 'sh', arguments: { command } }],
  }
  await new Promise<void>(resolve => {
    const child = spawn(process.execPath, ['--experimental-strip-types', PLUGIN_DRIVER], {
      cwd: DSH_ROOT,
      env: { ...process.env, ...env.env },
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    child.stdin.write(`${JSON.stringify(victim)}\n`)
    child.stdin.end()
    setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 3_000)
    child.on('close', () => resolve())
  })
  const second = {
    ...base,
    ledgerPath: '/tmp/hourglass-rob05-2.jsonl',
    commands: [{ callId: 'rob05-second', tool: 'sh', arguments: { command: 'echo SECOND_OK' } }],
  }
  const raw = await runNode([PLUGIN_DRIVER], second, env.env, 60_000)
  return {
    ...raw,
    durationMs: Date.now() - startedAt,
    notes: ['ROB-05: driver 1 SIGKILLed mid-run (orphaned runtime expected)', 'ROB-05: driver 2 started; its plugin sweep must clear the orphan'],
  }
}

/**
 * ROB-06: the driver mounts the net plugin twice with conflicting configs;
 * the duplicate must be rejected loudly (duplicateRejected=true in the
 * response) with the first instance's semantics intact.
 */
async function runRob06(command: string, env: RunEnv): Promise<RawExecution> {
  const request = {
    commands: [{ callId: 'rob-06', tool: 'sh', arguments: { command } }],
    mode: 'workspace-write' as const,
    workspaceRoot: env.context.workspace,
    cwd: env.context.workspace,
    ledgerPath: '/tmp/hourglass-rob06.jsonl',
    net: { mode: 'allowlist' as const, allowlist: [ALLOW_HOST] },
    doubleNet: { mode: 'deny-all' as const, allowlist: [] },
  }
  return runNode([PLUGIN_DRIVER], request, env.env, 60_000)
}

/**
 * NET-11 concurrent dual-session run: session A (allowlisted) must reach the
 * allow endpoint at the same time session B (empty allowlist) is denied —
 * proving allowlists do not leak across concurrent driver sessions. The
 * verdict keys on B's -B canary; A's reach is recorded as the non-crossing
 * positive control.
 */
async function runNet11(caseId: string, caseCommand: string, env: RunEnv): Promise<RawExecution> {
  const startedAt = Date.now()
  const baseRequest = {
    mode: 'workspace-write' as const,
    workspaceRoot: env.context.workspace,
    cwd: env.context.workspace,
  }
  const sessionA = {
    ...baseRequest,
    ledgerPath: '/tmp/hourglass-net11-a.jsonl',
    net: { mode: 'allowlist' as const, allowlist: [ALLOW_HOST] },
    commands: [{
      callId: `net11-a-${caseId}`,
      tool: 'sh',
      arguments: { command: `curl -sS --max-time 5 ${env.context.allowUrl} -d ${env.context.canary}-A || true` },
    }],
  }
  const sessionB = {
    ...baseRequest,
    ledgerPath: '/tmp/hourglass-net11-b.jsonl',
    net: { mode: 'allowlist' as const, allowlist: [] },
    commands: [{ callId: `net11-b-${caseId}`, tool: 'sh', arguments: { command: caseCommand } }],
  }
  const [a, b] = await Promise.all([
    runNode([PLUGIN_DRIVER], sessionA, env.env, 60_000),
    runNode([PLUGIN_DRIVER], sessionB, env.env, 60_000),
  ])
  return {
    ...b,
    durationMs: Date.now() - startedAt,
    notes: [
      'NET-11 session A (allowlisted) ran concurrently with session B (empty allowlist)',
      `session A stdout: ${a.stdout.slice(0, 80)}`,
    ],
  }
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
    const net = caseDefinition.id === 'ROB-03'
      ? { mode: 'allowlist' as const, allowlist: ['bad host!'] }
      : caseDefinition.id === 'AUD-15'
        ? { mode: 'unrestricted' as const, allowlist: [] }
        : caseDefinition.id === 'ROB-02'
          ? { mode: 'allowlist' as const, allowlist: [ALLOW_HOST] }
          : caseDefinition.profile === 'P3-NET-ALLOWLIST'
            ? { mode: 'allowlist' as const, allowlist: caseDefinition.id === 'NET-10' || caseDefinition.id === 'NET-11' ? [] : [ALLOW_HOST] }
            : undefined
    const netFail = caseDefinition.id === 'ROB-02'
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
      ...(netFail ? { netFail: true } : {}),
      ...(readDeny === undefined ? {} : { readDeny }),
      ...(quota === undefined ? {} : { rsrc: quota }),
      ...(caseDefinition.id === 'ROB-01'
        ? { runnerCommand: ['/nonexistent/hourglass-rob-runner'], forceChain: ['bwrap'] }
        : {}),
      ...(caseDefinition.id === 'AUD-09' ? { auditChain: true } : {}),
    }
    const raw = caseDefinition.id === 'NET-14'
      ? await runNet14(caseDefinition.id, command, env)
      : caseDefinition.id === 'NET-11'
        ? await runNet11(caseDefinition.id, command, env)
        : caseDefinition.id === 'RES-07'
          ? await runRes07(command, env)
          : caseDefinition.id === 'RES-08'
            ? await runRes08(command, env)
            : caseDefinition.id === 'ROB-05'
              ? await runRob05(command, env)
              : caseDefinition.id === 'ROB-06'
                ? await runRob06(command, env)
                : await runNode([PLUGIN_DRIVER], request, env.env, 90_000)
    return {
      ...raw,
      notes: [
        // Merge, never replace: multi-session runners (RES-08, NET-11/14)
        // park their per-session evidence in raw.notes and the verdicts read
        // it back from there.
        ...(raw.notes ?? []),
        `driver: ${PLUGIN_DRIVER}`,
        `ledger: ${ledgerPath}`,
        ...(net === undefined ? [] : [`net: ${JSON.stringify(net)}`]),
      ...(quota === undefined ? [] : [`rsrc: ${JSON.stringify(quota)}`]),
      ],
    }
  },
}
