/**
 * The pure policy semantics model. It mirrors — deliberately as a model, not
 * a copy — the resolution order of DSH's `SandboxPolicyService.resolve()`
 * (approved > session fold > configured) and the confinement semantics of the
 * fs fence (mode-scoped writable roots, lexical containment). Network and
 * deny-read are hourglass extension axes with their own deterministic rules;
 * illegal inputs (bad hosts, malformed paths) are rejected, never loosely
 * matched.
 * @module @hourglass/policy-ci
 */

import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { PolicyFixture, PolicyOperation, PolicyWorld, ReplayDecision } from './types.ts'

export const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

/** Resolve the effective mode for one fixture (approved > session fold > configured). */
export function resolveMode(fixture: PolicyFixture, world: PolicyWorld): SandboxMode {
  if (fixture.approvedMode !== undefined) return fixture.approvedMode
  const events = fixture.sandboxModeEvents ?? []
  if (events.length > 0) return events[events.length - 1] as SandboxMode
  return world.configuredMode
}

/**
 * Lexical containment under a root: resolves `..` segments without touching
 * the filesystem (the model is pure), then compares path prefixes. Windows
 * separators are normalized to `/`.
 */
export function isPathInside(path: string, root: string): boolean {
  const normalize = (value: string): string => {
    const withSlashes = value.replaceAll('\\', '/')
    const resolved: string[] = []
    for (const segment of withSlashes.split('/')) {
      if (segment === '' || segment === '.') continue
      if (segment === '..') {
        resolved.pop()
        continue
      }
      resolved.push(segment)
    }
    return resolved.join('/')
  }
  const normalizedPath = normalize(path)
  const normalizedRoot = normalize(root)
  if (normalizedRoot === '') return true
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
}

const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/
const IPV6_PATTERN = /^\[[0-9a-f:.]+]$|^[0-9a-f:]*:[0-9a-f:]*$/i

/**
 * Normalize a host per NET-09: strip a trailing dot, drop userinfo, lowercase
 * ASCII, reject NUL/control characters, invalid IPv4 octets, and malformed
 * IPv6. Returns `undefined` for input that must be rejected outright.
 */
export function normalizeHost(input: string): string | undefined {
  if (input.includes('\0')) return undefined
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(input)) return undefined
  let host = input
  if (host.includes('://')) return undefined
  const atSign = host.lastIndexOf('@')
  if (atSign >= 0) host = host.slice(atSign + 1)
  if (host.startsWith('[')) {
    return IPV6_PATTERN.test(host) ? host.toLowerCase() : undefined
  }
  host = host.replace(/[.]$/u, '').toLowerCase()
  if (host === '') return undefined
  if (IPV4_PATTERN.test(host)) {
    const octets = host.split('.').map(Number)
    if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined
    return host
  }
  if (host.includes(':')) return undefined
  if (!/^[a-z0-9.-]+$/u.test(host)) return undefined
  return host
}

/** Suffix-subdomain allowlist match: `example.com` admits `a.b.example.com` but not `evil-example.com`. */
export function hostAllowedByAllowlist(normalizedHost: string, allowlist: readonly string[]): boolean {
  return allowlist.some(entry => {
    const normalizedEntry = normalizeHost(entry)
    if (normalizedEntry === undefined) return false
    return normalizedHost === normalizedEntry || normalizedHost.endsWith(`.${normalizedEntry}`)
  })
}

/** Extract a prefix summary of an operation for reason strings. */
function describe(operation: PolicyOperation): string {
  switch (operation.kind) {
    case 'fs-write': return `write ${operation.path}`
    case 'fs-read': return `read ${operation.path}`
    case 'fs-delete': return `delete ${operation.path}`
    case 'fs-rename': return `rename ${operation.from} -> ${operation.to}`
    case 'net-request': return `net ${operation.host}${operation.port === undefined ? '' : `:${operation.port}`}`
    case 'spawn': return 'spawn subprocess'
  }
}

/**
 * Decide one fixture against the world. Structural validation problems make
 * the case `not-replayable` — never a default allow (POL-05).
 */
export function decide(fixture: PolicyFixture, world: PolicyWorld): ReplayDecision {
  if (typeof fixture.caseId !== 'string' || fixture.caseId === '') {
    return { caseId: '<missing>', status: 'not-replayable', reason: 'fixture has no caseId' }
  }
  if (fixture.approvedMode !== undefined && !SANDBOX_MODES.includes(fixture.approvedMode)) {
    return { caseId: fixture.caseId, status: 'not-replayable', reason: `invalid approvedMode ${String(fixture.approvedMode)}` }
  }
  for (const mode of fixture.sandboxModeEvents ?? []) {
    if (!SANDBOX_MODES.includes(mode)) {
      return { caseId: fixture.caseId, status: 'not-replayable', reason: `invalid sandbox/mode event ${String(mode)}` }
    }
  }
  if (!SANDBOX_MODES.includes(world.configuredMode)) {
    return { caseId: fixture.caseId, status: 'not-replayable', reason: `invalid configuredMode ${String(world.configuredMode)}` }
  }

  const mode = resolveMode(fixture, world)
  const operation = fixture.operation
  const fail = (reason: string): ReplayDecision => ({ caseId: fixture.caseId, status: 'decided', decision: 'deny', mode, reason })

  if (mode === 'danger-full-access') {
    return { caseId: fixture.caseId, status: 'decided', decision: 'allow', mode, reason: 'danger-full-access: no confinement' }
  }

  switch (operation.kind) {
    case 'fs-write':
    case 'fs-delete': {
      const path = operation.kind === 'fs-write' ? operation.path : operation.path
      if (mode === 'read-only') return fail(`read-only denies ${describe(operation)}`)
      if (!isPathInside(path, world.workspaceRoot)) return fail(`${describe(operation)} outside workspace root`)
      return { caseId: fixture.caseId, status: 'decided', decision: 'allow', mode, reason: 'workspace-write inside root' }
    }
    case 'fs-rename': {
      if (mode === 'read-only') return fail(`read-only denies ${describe(operation)}`)
      if (!isPathInside(operation.from, world.workspaceRoot) || !isPathInside(operation.to, world.workspaceRoot)) {
        return fail(`${describe(operation)} outside workspace root`)
      }
      return { caseId: fixture.caseId, status: 'decided', decision: 'allow', mode, reason: 'workspace-write inside root' }
    }
    case 'fs-read': {
      for (const denied of world.denyRead ?? []) {
        if (isPathInside(operation.path, denied)) {
          return fail(`denyRead covers ${operation.path}`)
        }
      }
      return { caseId: fixture.caseId, status: 'decided', decision: 'allow', mode, reason: 'read not restricted by base policy' }
    }
    case 'net-request': {
      if (world.netAllowlist === undefined || world.netAllowlist === 'unrestricted') {
        return { caseId: fixture.caseId, status: 'decided', decision: 'allow', mode, reason: 'no net extension configured (DSH base)' }
      }
      const normalized = normalizeHost(operation.host)
      if (normalized === undefined) {
        return fail(`invalid host literal ${JSON.stringify(operation.host)} rejected`)
      }
      if (world.netAllowlist.length === 0) {
        return fail('empty allowlist means deny-all')
      }
      if (!hostAllowedByAllowlist(normalized, world.netAllowlist)) {
        return fail(`host ${normalized} not in allowlist`)
      }
      return { caseId: fixture.caseId, status: 'decided', decision: 'allow', mode, reason: `host ${normalized} allowlisted` }
    }
    case 'spawn': {
      return { caseId: fixture.caseId, status: 'decided', decision: 'allow', mode, reason: 'subprocess allowed; fs rules still apply to its writes' }
    }
  }
}
