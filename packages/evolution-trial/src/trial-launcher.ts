/**
 * One-shot trial launcher (v3.1 §5, ADR-003 D2): spawns the trial-driver as
 * an INDEPENDENT child process and speaks JSON over stdio. The confinement
 * plugins (audit/net/read/rsrc) are mounted inside that child — never in
 * this process — so the parent (runner/evaluator) never assumes its own
 * decorators bind the trial. The watchdog kills the whole child on timeout;
 * there is no fallback to in-process execution.
 */

import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TrialConfinement } from './confine-trial.ts'

export interface TrialCommand {
  readonly callId: string
  readonly command: string
}

export interface TrialRequest {
  readonly trialId: string
  readonly workspaceRoot: string
  readonly ledgerPath: string
  readonly commands: readonly TrialCommand[]
  readonly confinement: TrialConfinement
  /** Driver override for tests; default resolution is container-first. */
  readonly driverPath?: string
  /**
   * Working directory for the driver process (test hook; the default is the
   * fused DSH workspace when present, else this process's cwd).
   */
  readonly driverCwd?: string
}

export interface TrialCommandResult {
  readonly callId: string
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly denied: boolean
}

export interface TrialResponse {
  readonly ok: boolean
  /** Child-side evidence: the driver process's own PID (EVO-TRIAL-01). */
  readonly driverPid?: number
  readonly results: readonly TrialCommandResult[]
  readonly ledger: readonly unknown[]
  readonly error?: string
  readonly timedOut?: boolean
}

/**
 * Resolve the trial driver. The candidate list is injectable so the
 * not-found throw is testable in an environment where the container paths
 * always exist.
 */
export function resolveDriverPath(explicit?: string, candidatesOverride?: readonly string[]): string {
  const candidates = (candidatesOverride ?? [
    explicit,
    process.env['HOURGLASS_EVOLUTION_DRIVER'],
    // Fused workspace copies (container): resolve @hourglass/@deepseek-ai deps.
    // The sibling layout is the proven one — pnpm links it like the compare
    // driver; the nested evolution-runner/driver copy stays as a fallback.
    '/opt/dsh/packages/hourglass/evolution-driver/trial-driver.ts',
    '/opt/dsh/packages/hourglass/evolution-runner/driver/trial-driver.ts',
    // Repo layout (relative to this package's src/).
    join(dirnameOf(import.meta.url), '..', '..', '..', 'scripts', 'sandbox-evolution', 'driver', 'trial-driver.ts'),
  ]).filter((value): value is string => typeof value === 'string' && value !== '')
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`trial-driver-not-found:${candidates.join(' | ')}`)
}

/** The driver runs from the fused DSH workspace when present, else the cwd. */
export function driverCwd(root = '/opt/dsh'): string {
  return existsSync(root) ? root : process.cwd()
}

export async function runTrial(request: TrialRequest): Promise<TrialResponse> {
  const driverPath = resolveDriverPath(request.driverPath)
  // The rsrc budget's nproc cap is enforced with a setpriv uid downgrade, so
  // the trial (running as an unprivileged uid) must be able to write its own
  // workspace. The launcher owns workspace preparation for exactly this
  // reason — including creating it when the caller has not — while the
  // store, journal and benchmark paths are never touched.
  // Resolve to an absolute path ONCE: this process and the spawned driver
  // may run with different cwds, so a relative root would resolve differently
  // on each side.
  const workspaceRoot = resolve(request.workspaceRoot)
  mkdirSync(workspaceRoot, { recursive: true })
  chmodSync(workspaceRoot, 0o777)
  const payload = JSON.stringify({
    workspaceRoot,
    ledgerPath: request.ledgerPath,
    commands: request.commands,
    net: request.confinement.net,
    ...(request.confinement.readDeny.length > 0 ? { readDeny: request.confinement.readDeny } : {}),
    rsrc: request.confinement.rsrc,
  })
  return await new Promise<TrialResponse>(resolve => {
    const child = spawn(process.execPath, ['--experimental-strip-types', driverPath], {
      cwd: request.driverCwd ?? driverCwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    // Every handler resolves the SAME promise: after the first resolution
    // the rest are no-ops by promise semantics, so no settled flag is needed.
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ ok: false, results: [], ledger: [], error: 'trial-watchdog-timeout', timedOut: true })
    }, request.confinement.watchdogMs)
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ ok: false, results: [], ledger: [], error: `driver-spawn-failed:${error.message}` })
    })
    child.on('close', () => {
      clearTimeout(timer)
      const text = stdout.trim()
      if (text === '') {
        resolve({ ok: false, results: [], ledger: [], error: `driver-no-output:stderr=${stderr.slice(0, 500)}` })
        return
      }
      try {
        // stdout is non-empty here, so split() always yields at least one line.
        const lines = text.split('\n')
        resolve(JSON.parse(lines[lines.length - 1] as string) as TrialResponse)
      } catch (error) {
        resolve({ ok: false, results: [], ledger: [], error: `driver-output-unparseable:${String(error)}` })
      }
    })
    child.stdin.write(payload)
    child.stdin.end()
    // A driver that exits before draining stdin emits EPIPE here; without a
    // listener Node treats it as an uncaught exception and crashes the
    // runner. The close/error handlers already resolve the promise with the
    // real failure, so this listener only contains the stream error.
    child.stdin.on('error', () => {})
  })
}

function dirnameOf(url: string): string {
  const path = fileURLToPath(url)
  return path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
}
