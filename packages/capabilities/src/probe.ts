/**
 * Real back-end probes. Each probe runs the actual confinement mechanism on
 * this host and reports whether it works; a probe that exercises a write
 * denial upgrades the corresponding capability to probe-backed `enforced`.
 * Probes never touch anything outside the system temp directory.
 * @module @hourglass/sandbox-capabilities
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackendProbeResult, SandboxBackendId } from './types.ts'

/** bwrap argv mirroring DSH's read-only profile (dsh-sandbox-local profiles.ts). */
export function bwrapReadonlyArgv(workspaceRoot: string): string[] {
  return [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--unshare-pid',
    '--proc', '/proc',
    '--bind', workspaceRoot, workspaceRoot,
    '--',
  ]
}

/** sandbox-exec profile mirroring DSH's read-only dialect (darwin only). */
export const SEATBELT_READONLY_PROFILE = '(version 1)(allow default)(deny file-write*)'

function probeResult(backend: SandboxBackendId, available: boolean, detail: string): BackendProbeResult {
  return { backend, available, detail, checkedAt: new Date().toISOString() }
}

/**
 * Probe bubblewrap: run `true` under the read-only profile, then prove the
 * write denial for real by writing outside the bind whitelist (into the
 * system temp dir, which bwrap leaves on the host read-only mount).
 */
export function probeBwrap(timeoutMs = 5000): BackendProbeResult {
  const startup = spawnSync('bwrap', [...bwrapReadonlyArgv('/'), 'true'], { timeout: timeoutMs, stdio: 'ignore' })
  if (startup.error !== undefined || startup.status !== 0) {
    return probeResult('bwrap', false, `startup probe failed (status ${String(startup.status)})`)
  }
  const canaryDir = mkdtempSync(join(tmpdir(), 'hourglass-probe-bwrap-'))
  try {
    const canary = join(canaryDir, 'denied.txt')
    const denial = spawnSync(
      'bwrap',
      [...bwrapReadonlyArgv('/'), 'sh', '-c', `printf x > ${JSON.stringify(canary)}`],
      { timeout: timeoutMs, encoding: 'utf8' },
    )
    const blocked = denial.status !== 0 && !existsSync(canary)
    return probeResult(
      'bwrap',
      true,
      blocked
        ? 'startup ok; write outside whitelist denied (EROFS dialect) and no file appeared'
        : 'startup ok but write-denial NOT confirmed — treat capabilities as unproven',
    )
  } finally {
    rmSync(canaryDir, { recursive: true, force: true })
  }
}

/**
 * Probe Seatbelt on darwin: run `true` under a write-deny profile.
 */
export function probeSeatbelt(timeoutMs = 5000): BackendProbeResult {
  const startup = spawnSync(
    'sandbox-exec',
    ['-p', SEATBELT_READONLY_PROFILE, 'true'],
    { timeout: timeoutMs, stdio: 'ignore' },
  )
  if (startup.error !== undefined || startup.status !== 0) {
    return probeResult('seatbelt', false, `startup probe failed (status ${String(startup.status)})`)
  }
  const canaryDir = mkdtempSync(join(tmpdir(), 'hourglass-probe-sb-'))
  try {
    const canary = join(canaryDir, 'denied.txt')
    const denial = spawnSync(
      'sandbox-exec',
      ['-p', SEATBELT_READONLY_PROFILE, 'sh', '-c', `printf x > ${JSON.stringify(canary)}`],
      { timeout: timeoutMs, encoding: 'utf8' },
    )
    const blocked = denial.status !== 0 && !existsSync(canary)
    return probeResult(
      'seatbelt',
      true,
      blocked ? 'startup ok; write denied and no file appeared' : 'startup ok but write-denial NOT confirmed',
    )
  } finally {
    rmSync(canaryDir, { recursive: true, force: true })
  }
}

/**
 * Probe the Windows ACL back-end: it needs the DSH runner entry, which only
 * exists inside a built DSH workspace. Outside one, the probe reports
 * unavailable rather than claiming the backend is broken.
 */
export function probeWindowsAcl(runnerEntry?: string): BackendProbeResult {
  if (process.platform !== 'win32') {
    return probeResult('windows-acl', false, `not probed: platform is ${process.platform}`)
  }
  if (runnerEntry === undefined || !existsSync(runnerEntry)) {
    return probeResult('windows-acl', false, 'not probed: DSH windows-acl runner entry not provided')
  }
  return probeResult('windows-acl', true, 'runner entry present (write-denial semantics per DSH own partial classification)')
}

/**
 * Landlock needs the DSH native launcher (`landlock-run`); hourglass probes it
 * only when the launcher path is available, mirroring how DSH itself probes.
 */
export function probeLandlock(launcherPath?: string, timeoutMs = 5000): BackendProbeResult {
  if (launcherPath === undefined || !existsSync(launcherPath)) {
    return probeResult('landlock', false, 'not probed: DSH landlock launcher not provided')
  }
  const startup = spawnSync(launcherPath, ['--', 'true'], { timeout: timeoutMs, stdio: 'ignore' })
  return probeResult(
    'landlock',
    startup.status === 0,
    startup.status === 0 ? 'launcher startup ok' : `launcher probe failed (status ${String(startup.status)})`,
  )
}
