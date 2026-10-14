import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuditLedger, AuditLedgerError } from '../src/ledger.ts'
import type { AuditBeginRecord, AuditEndRecord } from '../src/types.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hourglass-ledger-'))
  dirs.push(dir)
  return join(dir, 'audit.jsonl')
}

function beginFixture(callId: string, tool = 'bash'): Omit<AuditBeginRecord, 'runId' | 'seq'> {
  return {
    schema: 'hourglass-audit/1',
    kind: 'begin',
    timestamp: new Date().toISOString(),
    callId,
    tool,
    layer: 'policy_decision',
    policy: { mode: 'read-only', resolvedFrom: 'configured' },
    argumentsSummary: { keys: [], redacted: true, preview: '{}' },
  }
}

function endFixture(callId: string, tool = 'bash'): Omit<AuditEndRecord, 'runId' | 'seq'> {
  return {
    schema: 'hourglass-audit/1',
    kind: 'end',
    timestamp: new Date().toISOString(),
    callId,
    tool,
    layer: 'backend_result',
    outcome: { kind: 'allowed', basis: 'result is success' },
    backend: { source: 'unavailable' },
    osObservation: { status: 'unavailable' },
  }
}

describe('AuditLedger', () => {
  it('appends begin/end records and correlates them by callId', () => {
    const ledger = new AuditLedger({ path: tempLedgerPath() })
    ledger.append(beginFixture('c1'))
    ledger.append(endFixture('c1'))
    const chain = ledger.byCall('c1')
    expect(chain).toHaveLength(2)
    expect(chain[0]!.kind).toBe('begin')
    expect(chain[1]!.kind).toBe('end')
    expect(chain.every(record => record.runId === ledger.runId)).toBe(true)
    expect(chain[1]!.seq).toBeGreaterThan(chain[0]!.seq)
  })

  it('persists to JSONL and reloads after restart, continuing the seq', () => {
    const path = tempLedgerPath()
    const first = new AuditLedger({ path })
    const appended = first.append(beginFixture('c1'))
    const second = new AuditLedger({ path })
    expect(second.byCall('c1')).toHaveLength(1)
    const next = second.append(beginFixture('c2'))
    expect(next.seq).toBe(appended.seq + 1)
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]!).callId).toBe('c2')
  })

  it('drops a torn final line and skips foreign lines on load', () => {
    const path = tempLedgerPath()
    const ledger = new AuditLedger({ path })
    ledger.append(beginFixture('c1'))
    writeFileSync(path, '\n{"schema":"something-else"}\n{"broken json', { flag: 'a' })
    const reloaded = new AuditLedger({ path })
    expect(reloaded.query({}).total).toBe(1)
    const next = reloaded.append(beginFixture('c2'))
    expect(next.seq).toBe(2)
  })

  it('queries by tool, outcome kind, and paginates with totals', () => {
    const ledger = new AuditLedger({ path: tempLedgerPath() })
    ledger.append(beginFixture('c1', 'bash'))
    ledger.append({ ...endFixture('c1', 'bash'), outcome: { kind: 'sandbox-denial', basis: 'result.sandbox.denied = true' } })
    ledger.append(beginFixture('c2', 'fs'))
    ledger.append(endFixture('c2', 'fs'))
    expect(ledger.query({ tool: 'bash' }).total).toBe(2)
    expect(ledger.query({ outcomeKind: 'sandbox-denial' }).total).toBe(1)
    expect(ledger.query({ kind: 'begin' }).total).toBe(2)
    const page = ledger.query({ limit: 2, offset: 2 })
    expect(page.total).toBe(4)
    expect(page.records).toHaveLength(2)
  })

  it('filters by time range', async () => {
    const ledger = new AuditLedger({ path: tempLedgerPath() })
    ledger.append(beginFixture('c1'))
    await new Promise(resolve => setTimeout(resolve, 5))
    const cutoff = new Date().toISOString()
    await new Promise(resolve => setTimeout(resolve, 5))
    ledger.append(beginFixture('c2'))
    expect(ledger.query({ since: cutoff }).total).toBe(1)
    expect(ledger.query({ until: cutoff }).total).toBe(1)
    expect(ledger.query({ until: cutoff }).records[0]!.callId).toBe('c1')
  })

  it('non-strict mode counts drops; strict mode throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hourglass-ledger-'))
    dirs.push(dir)
    const path = join(dir, 'nested', 'missing', 'audit.jsonl')
    const lenient = new AuditLedger({ path })
    lenient.append(beginFixture('c1'))
    expect(lenient.diagnostics().dropped).toBe(1)
    expect(lenient.diagnostics().persisted).toBe(0)
    expect(lenient.diagnostics().lastError).toBeTruthy()
    const strict = new AuditLedger({ path, strict: true })
    expect(() => strict.append(beginFixture('c1'))).toThrow(AuditLedgerError)
  })

  it('rotate writes the full history atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hourglass-ledger-'))
    dirs.push(dir)
    const path = join(dir, 'audit.jsonl')
    const ledger = new AuditLedger({ path })
    ledger.append(beginFixture('c1'))
    ledger.append(endFixture('c1'))
    const target = join(dir, 'rotated.jsonl')
    ledger.rotate(target)
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('a directory path fails loud in strict mode with the cause preserved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hourglass-ledger-'))
    dirs.push(dir)
    try {
      const strict = new AuditLedger({ path: dir, strict: true })
      expect(() => strict.append(beginFixture('c1'))).toThrow(/write failed/)
    } finally {
      mkdirSync(dir, { recursive: true })
    }
  })
})
