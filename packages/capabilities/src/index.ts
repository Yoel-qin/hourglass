/**
 * Capability-manifest builder and cordis plugin for
 * @hourglass/sandbox-capabilities.
 *
 * The builder combines the static per-backend matrix with live probe results
 * under one honesty rule: `enforced` survives only with probe or test-result
 * evidence; a statically-present mechanism that was not exercised on this
 * host degrades to `unknown` with its note preserved (AUD-13).
 * @module @hourglass/sandbox-capabilities
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { STATIC_MATRIX } from './static-matrix.ts'
import type { BackendProbeResult, CapabilityEntry, CapabilityKey, CapabilityManifest, SandboxBackendId } from './types.ts'

export const name = 'hourglass-sandbox-capabilities'

export interface Config {
  /** Back-end to describe; defaults to the platform's primary DSH chain head. */
  backend?: SandboxBackendId
}

export const Config: z<Config> = z.object({
  backend: z.union(['bwrap', 'landlock', 'seatbelt', 'windows-acl', 'none']),
})

/** The first rung of DSH's platform chain for a platform (sandbox-local index.ts). */
export function primaryBackend(platform: NodeJS.Platform): SandboxBackendId {
  if (platform === 'linux') return 'bwrap'
  if (platform === 'darwin') return 'seatbelt'
  if (platform === 'win32') return 'windows-acl'
  return 'none'
}

/** Test-result evidence keyed by capability, typically fed from a compare report. */
export type TestedEvidence = Partial<Record<CapabilityKey, { status: CapabilityEntry['status']; evidenceRef: string }>>

/**
 * Apply the honesty rule to one static entry, given this host's probes:
 * `enforced` survives only when a probe exercised the backend here.
 */
function finalizeEntry(
  entry: CapabilityEntry,
  backend: SandboxBackendId,
  probes: readonly BackendProbeResult[],
): CapabilityEntry {
  const probe = probes.find(candidate => candidate.backend === backend)
  if (entry.status !== 'enforced') return entry
  if (probe !== undefined && probe.available) {
    return { ...entry, evidence: 'probe', evidenceRef: `${entry.evidenceRef}; probe: ${probe.detail}` }
  }
  // Mechanism present in source but not exercised here: keep the note, drop the claim.
  return {
    status: 'unknown',
    evidence: 'static-config',
    evidenceRef: entry.evidenceRef,
    note: `${entry.note} — mechanism present in source, not exercised on this host`,
  }
}

/** Build a manifest for one backend. Pure: all environment input is parameters. */
export function buildManifest(options: {
  platform: NodeJS.Platform
  backend?: SandboxBackendId
  probes?: readonly BackendProbeResult[]
  tested?: TestedEvidence
}): CapabilityManifest {
  const backend = options.backend ?? primaryBackend(options.platform)
  const probes = options.probes ?? []
  const tested = options.tested ?? {}
  const staticMatrix = STATIC_MATRIX[backend]
  const capabilities = {} as Record<CapabilityKey, CapabilityEntry>
  for (const key of ['fileRead', 'fileWrite', 'netEgress', 'resourceLimits', 'processControl'] as const) {
    const entry = staticMatrix[key]
    if (entry === undefined) throw new Error(`static matrix missing capability ${key} for backend ${backend}`)
    const test = tested[key]
    if (test !== undefined) {
      capabilities[key] = { status: test.status, evidence: 'test-result', evidenceRef: test.evidenceRef, note: entry.note }
    } else {
      capabilities[key] = finalizeEntry(entry, backend, probes)
    }
  }
  return {
    schema: 'hourglass-capabilities/1',
    generatedAt: new Date().toISOString(),
    platform: options.platform,
    backend,
    probes,
    capabilities,
  }
}

/** Render a manifest as stable, human-readable lines for the query command. */
export function renderManifest(manifest: CapabilityManifest): string {
  const lines = [
    `hourglass capability manifest (${manifest.schema})`,
    `generated ${manifest.generatedAt} on ${manifest.platform}, backend ${manifest.backend}`,
    ...manifest.probes.map(probe => `probe ${probe.backend}: ${probe.available ? 'available' : 'unavailable'} — ${probe.detail}`),
    '',
    ...Object.entries(manifest.capabilities).map(([key, entry]) => (
      `${key.padEnd(16)} ${entry.status.padEnd(8)} [${entry.evidence}] ${entry.note} (${entry.evidenceRef})`
    )),
  ]
  return lines.join('\n')
}

export function apply(ctx: Context, config: Config): void {
  ctx.inject(['commands'], (commandCtx: Context) => {
    commandCtx.commands.register({
      definitionId: '@hourglass/sandbox-capabilities',
      name: 'sandbox-capabilities',
      description: 'Print the hourglass enforcement capability manifest (read-only)',
      input: { hint: '[backend]' },
      handler: ({ rawInput }: { rawInput: string }) => {
        const trimmed = rawInput.trim()
        const backend = (trimmed === '' ? undefined : trimmed) as SandboxBackendId | undefined
        if (backend !== undefined && !(backend in STATIC_MATRIX)) {
          return { kind: 'error' as const, text: `unknown backend ${trimmed}` }
        }
        const manifest = buildManifest({ platform: process.platform, backend: backend ?? config.backend, probes: [] })
        return { kind: 'success' as const, text: renderManifest(manifest) }
      },
    })
  })
}
