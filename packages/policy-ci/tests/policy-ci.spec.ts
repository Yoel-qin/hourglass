import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decide, isPathInside, normalizeHost, hostAllowedByAllowlist, replay, replayDiff, diffDecisions } from '../src/index.ts'
import { BASELINE_FIXTURES, HOST_EDGE_CASES, SYNTHETIC_WORKSPACE } from './fixtures/policy-fixtures.ts'
import type { PolicyFixture, PolicyWorld } from '../src/types.ts'

const here = dirname(fileURLToPath(import.meta.url))

const BASE_WORLD: PolicyWorld = { configuredMode: 'workspace-write', workspaceRoot: SYNTHETIC_WORKSPACE }

describe('policy replay determinism (POL-01)', () => {
  it('replaying the frozen fixtures twice yields byte-identical decisions', () => {
    const first = replay(BASELINE_FIXTURES, BASE_WORLD)
    const second = replay(BASELINE_FIXTURES, BASE_WORLD)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('matches the checked-in golden decision set', () => {
    const golden = JSON.parse(readFileSync(join(here, 'golden', 'baseline-replay.golden.json'), 'utf8')) as unknown[]
    const current = replay(BASELINE_FIXTURES, BASE_WORLD)
    expect(JSON.parse(JSON.stringify(current))).toEqual(golden)
  })
})

describe('base semantics', () => {
  it('mode resolution order: approved > session fold > configured', () => {
    expect(decide({
      caseId: 't1',
      tool: 'bash',
      sandboxModeEvents: ['read-only'],
      approvedMode: 'workspace-write',
      operation: { kind: 'fs-write', path: `${SYNTHETIC_WORKSPACE}/x` },
    }, BASE_WORLD)).toMatchObject({ status: 'decided', decision: 'allow' })

    expect(decide({
      caseId: 't2',
      tool: 'bash',
      sandboxModeEvents: ['workspace-write', 'read-only'],
      operation: { kind: 'fs-write', path: `${SYNTHETIC_WORKSPACE}/x` },
    }, BASE_WORLD)).toMatchObject({ status: 'decided', decision: 'deny' })
  })

  it('containment resolves traversal before deciding', () => {
    expect(isPathInside('/synth/workspace/../../etc/x', '/synth/workspace')).toBe(false)
    expect(isPathInside('/synth/workspace/sub/../a', '/synth/workspace')).toBe(true)
    expect(isPathInside('C:\\synth\\workspace\\a', 'C:/synth/workspace')).toBe(true)
    expect(isPathInside('/synth/workspace-evil/x', '/synth/workspace')).toBe(false)
  })

  it('network is allowed under base policy (honest absence, not a pass)', () => {
    const decision = decide({
      caseId: 't3',
      tool: 'web',
      operation: { kind: 'net-request', host: 'anything.example' },
    }, BASE_WORLD)
    expect(decision).toMatchObject({ status: 'decided', decision: 'allow' })
    if (decision.status === 'decided') expect(decision.reason).toContain('no net extension')
  })
})

describe('policy diff (POL-02..POL-05)', () => {
  it('switching the configured mode to read-only yields allow-to-deny inside the workspace and reason-only drift outside', () => {
    const diff = replayDiff(BASELINE_FIXTURES, BASE_WORLD, { ...BASE_WORLD, configuredMode: 'read-only' })
    const fsb01 = diff.changed.find(entry => entry.caseId === 'FS-B01')!
    expect(fsb01.change).toEqual({ kind: 'allow-to-deny' })
    // Outside-workspace cases stay denied; only their reason drifts.
    const fsb02 = diff.changed.find(entry => entry.caseId === 'FS-B02')!
    expect(fsb02.change).toEqual({ kind: 'reason-only' })
    expect(diff.changed.every(entry => entry.change.kind !== 'deny-to-allow')).toBe(true)
    expect(diff.unchanged).toBe(diff.totalCases - diff.changed.length)
  })

  it('a deny-to-allow change is reported when the mode widens', () => {
    const world: PolicyWorld = { configuredMode: 'read-only', workspaceRoot: SYNTHETIC_WORKSPACE }
    const diff = replayDiff(BASELINE_FIXTURES, world, BASE_WORLD)
    const entry = diff.changed.find(candidate => candidate.caseId === 'FS-B01')
    expect(entry?.change).toEqual({ kind: 'deny-to-allow' })
  })

  it('adding denyRead flips only sensitive reads (POL-03)', () => {
    const diff = replayDiff(
      BASELINE_FIXTURES,
      BASE_WORLD,
      { ...BASE_WORLD, denyRead: ['/synth/home/.ssh'] },
    )
    const entry = diff.changed.find(candidate => candidate.caseId === 'FS-B05')
    expect(entry?.change).toEqual({ kind: 'allow-to-deny' })
    expect(diff.changed.every(candidate => candidate.caseId.startsWith('FS-'))).toBe(true)
  })

  it('adding a net allowlist flips net cases without touching fs cases (POL-04)', () => {
    const diff = replayDiff(
      BASELINE_FIXTURES,
      BASE_WORLD,
      { ...BASE_WORLD, netAllowlist: ['synthetic-allow.example'] },
    )
    expect(diff.changed.map(entry => entry.caseId)).toEqual(['NET-B01', 'NET-B02'])
    const netB02 = diff.changed.find(entry => entry.caseId === 'NET-B02')!
    expect(netB02.change).toEqual({ kind: 'allow-to-deny' })
  })

  it('an empty allowlist means deny-all, never allow-all', () => {
    const decision = decide({
      caseId: 't4',
      tool: 'web',
      operation: { kind: 'net-request', host: 'synthetic-allow.example' },
    }, { ...BASE_WORLD, netAllowlist: [] })
    expect(decision).toMatchObject({ status: 'decided', decision: 'deny' })
  })

  it('malformed fixtures are not-replayable, never a default allow (POL-05)', () => {
    const broken: PolicyFixture = {
      caseId: 'broken',
      description: 'invalid mode event',
      tool: 'bash',
      sandboxModeEvents: ['yolo-mode' as never],
      operation: { kind: 'spawn' },
    }
    expect(decide(broken, BASE_WORLD)).toMatchObject({ status: 'not-replayable' })
    const noId: PolicyFixture = {
      caseId: '',
      description: 'missing id',
      tool: 'bash',
      operation: { kind: 'spawn' },
    }
    expect(decide(noId, BASE_WORLD)).toMatchObject({ status: 'not-replayable' })
  })

  it('diff flags not-replayable transitions in both directions', () => {
    const before = replay(BASELINE_FIXTURES, BASE_WORLD)
    const after = [
      ...before.slice(0, 1),
      { caseId: BASELINE_FIXTURES[1]!.caseId, status: 'not-replayable', reason: 'field missing in new schema' },
    ] as typeof before
    const diff = diffDecisions(BASELINE_FIXTURES, before, after)
    expect(diff.changed.find(entry => entry.caseId === BASELINE_FIXTURES[1]!.caseId)?.change)
      .toEqual({ kind: 'to-not-replayable' })
  })
})

describe('host normalization edges (NET-09 at the policy layer)', () => {
  it('every edge case normalizes and matches as pinned', () => {
    for (const edge of HOST_EDGE_CASES) {
      const normalized = normalizeHost(edge.input)
      expect(normalized, `normalizeHost(${JSON.stringify(edge.input)})`).toBe(edge.normalized)
      if (normalized !== undefined) {
        expect(hostAllowedByAllowlist(normalized, ['allow.example']), `allowlist(${normalized})`).toBe(edge.allowed)
      }
    }
  })

  it('an invalid allowlist entry is ignored, not treated as a wildcard', () => {
    expect(hostAllowedByAllowlist('allow.example', ['bad host!'])).toBe(false)
    expect(hostAllowedByAllowlist('allow.example', ['allow.example.', 'bad host!'])).toBe(true)
  })
})
