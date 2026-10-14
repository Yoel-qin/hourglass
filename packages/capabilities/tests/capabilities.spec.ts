import { describe, expect, it } from 'vitest'
import { buildManifest, primaryBackend, renderManifest } from '../src/index.ts'
import { STATIC_MATRIX } from '../src/static-matrix.ts'
import type { BackendProbeResult, CapabilityKey } from '../src/types.ts'

const CAPABILITY_KEYS: readonly CapabilityKey[] = ['fileRead', 'fileWrite', 'netEgress', 'resourceLimits', 'processControl']

const available = (backend: BackendProbeResult['backend'], detail = 'probed'): BackendProbeResult => ({
  backend,
  available: true,
  detail,
  checkedAt: '2026-10-13T00:00:00.000Z',
})

const unavailable = (backend: BackendProbeResult['backend']): BackendProbeResult => ({
  backend,
  available: false,
  detail: 'not on this host',
  checkedAt: '2026-10-13T00:00:00.000Z',
})

describe('static matrix integrity', () => {
  it('covers every backend with all five capabilities and evidence refs', () => {
    for (const [backend, matrix] of Object.entries(STATIC_MATRIX)) {
      for (const key of CAPABILITY_KEYS) {
        const entry = matrix[key]
        expect(entry, `${backend}/${key}`).toBeDefined()
        expect(['enforced', 'partial', 'absent', 'unknown']).toContain(entry!.status)
        expect(['static-config', 'probe', 'backend-report', 'test-result']).toContain(entry!.evidence)
        expect(entry!.evidenceRef.length).toBeGreaterThan(0)
        expect(entry!.note.length).toBeGreaterThan(0)
      }
    }
  })

  it('no backend statically claims netEgress or resourceLimits enforcement', () => {
    for (const matrix of Object.values(STATIC_MATRIX)) {
      expect(matrix.netEgress!.status).toBe('absent')
      expect(matrix.resourceLimits!.status).toBe('absent')
    }
  })
})

describe('primaryBackend', () => {
  it('maps platforms onto the first rung of the DSH chain', () => {
    expect(primaryBackend('linux')).toBe('bwrap')
    expect(primaryBackend('darwin')).toBe('seatbelt')
    expect(primaryBackend('win32')).toBe('windows-acl')
    expect(primaryBackend('freebsd')).toBe('none')
  })
})

describe('buildManifest honesty rules (AUD-13)', () => {
  it('enforced survives only with an available probe; otherwise degrades to unknown with the note kept', () => {
    const probed = buildManifest({ platform: 'linux', backend: 'bwrap', probes: [available('bwrap')] })
    expect(probed.capabilities.fileWrite.status).toBe('enforced')
    expect(probed.capabilities.fileWrite.evidence).toBe('probe')

    const unprobed = buildManifest({ platform: 'linux', backend: 'bwrap', probes: [unavailable('bwrap')] })
    expect(unprobed.capabilities.fileWrite.status).toBe('unknown')
    expect(unprobed.capabilities.fileWrite.note).toContain('not exercised on this host')

    const noProbes = buildManifest({ platform: 'linux', backend: 'bwrap' })
    expect(noProbes.capabilities.fileWrite.status).toBe('unknown')
  })

  it('absent stays absent regardless of probes', () => {
    const manifest = buildManifest({ platform: 'linux', backend: 'bwrap', probes: [available('bwrap')] })
    expect(manifest.capabilities.netEgress.status).toBe('absent')
    expect(manifest.capabilities.fileRead.status).toBe('absent')
  })

  it('partial (windows-acl writes) is reported as partial with the standing note', () => {
    const manifest = buildManifest({ platform: 'win32', backend: 'windows-acl', probes: [] })
    expect(manifest.capabilities.fileWrite.status).toBe('partial')
    expect(manifest.capabilities.fileRead.status).toBe('absent')
  })

  it('test-result evidence overrides both static and probe state', () => {
    const manifest = buildManifest({
      platform: 'linux',
      backend: 'bwrap',
      probes: [available('bwrap')],
      tested: { netEgress: { status: 'enforced', evidenceRef: 'sandbox-compare NET-02 run 2026-10-13' } },
    })
    expect(manifest.capabilities.netEgress).toMatchObject({
      status: 'enforced',
      evidence: 'test-result',
      evidenceRef: 'sandbox-compare NET-02 run 2026-10-13',
    })
  })

  it('danger-full-access / none reports every capability absent', () => {
    const manifest = buildManifest({ platform: 'linux', backend: 'none' })
    for (const key of CAPABILITY_KEYS) {
      expect(manifest.capabilities[key].status, key).toBe('absent')
    }
  })
})

describe('renderManifest', () => {
  it('renders one line per capability plus the probe header', () => {
    const manifest = buildManifest({ platform: 'linux', backend: 'bwrap', probes: [available('bwrap', 'startup ok')] })
    const text = renderManifest(manifest)
    expect(text).toContain('hourglass capability manifest')
    expect(text).toContain('backend bwrap')
    expect(text).toContain('probe bwrap: available')
    for (const key of CAPABILITY_KEYS) {
      expect(text).toContain(key)
    }
  })
})
