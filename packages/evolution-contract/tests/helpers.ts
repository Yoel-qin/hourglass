import type { CaseOutcome, RunSummary } from '../src/types.ts'

export const LOCK_SHA = 'a'.repeat(64)

/** A fully valid synthetic manifest; tests override single fields. */
export function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'hourglass-evolution-candidate/1',
    candidateId: 'cand-0000000000000000000000000000000000000000',
    proposalId: 'prop-1',
    parentRevision: 'parent-abc123',
    assetKind: 'dsh_skill',
    mutationKind: 'update',
    scope: 'isolated-store',
    payloadSha256: 'b'.repeat(64),
    artifactSha256: 'c'.repeat(64),
    versionsLockSha256: 'd'.repeat(64),
    requestedCapabilities: ['task-input-read', 'trial-workspace-write'],
    riskTier: 'E0',
    createdBy: 'synthetic-proposer',
    createdAt: '2026-10-19T00:00:00.000Z',
    sourceNote: 'synthetic baseline skill text mutation',
    benchmarkId: 'evo-bench-mvp-a',
    benchmarkVersion: 1,
    benchmarkManifestSha256: 'e'.repeat(64),
    environmentFingerprint: 'dsh=d743267;lane=bwrap-container',
    ...overrides,
  }
}

export function baseBenchmark(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'hourglass-evolution-benchmark/1',
    benchmarkId: 'evo-bench-mvp-a',
    version: 1,
    caseIds: ['F-PUB-01', 'F-HID-01', 'S-SEC-01'],
    publicCaseIds: ['F-PUB-01'],
    hiddenCaseIds: ['F-HID-01'],
    securityCaseIds: ['S-SEC-01'],
    inputSha256: {
      'F-PUB-01': '1'.repeat(64),
      'F-HID-01': '2'.repeat(64),
      'S-SEC-01': '3'.repeat(64),
    },
    assertionVersion: 'assert-v1',
    scorerVersion: 'scorer-v1',
    dshCommit: 'd743267',
    lockedAt: '2026-10-19T00:00:00.000Z',
    ...overrides,
  }
}

/** Build a run summary from 0/1 bits plus uniform per-case cost knobs. */
export function runFromBits(
  bits: readonly number[],
  categories: readonly string[],
  runId: string,
  opts: { latencyMs?: number; costTokens?: number } = {},
): RunSummary {
  const cases: CaseOutcome[] = bits.map((bit, index) => ({
    caseId: `case-${index + 1}`,
    category: categories[index] ?? 'core',
    success: bit === 1,
    ...(opts.latencyMs !== undefined ? { latencyMs: opts.latencyMs } : {}),
    ...(opts.costTokens !== undefined ? { costTokens: opts.costTokens } : {}),
  }))
  return { runId, cases }
}

export const CATS8: readonly string[] = ['fs', 'fs', 'net', 'net', 'skill', 'skill', 'prompt', 'prompt']

export function countsOk(n: number): { expected: number; executed: number; skipped: number; blocked: number } {
  return { expected: n, executed: n, skipped: 0, blocked: 0 }
}
