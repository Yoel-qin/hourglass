/**
 * Append-only audit ledger: JSONL persistence plus an in-memory query index.
 *
 * Writes append one JSON line per record; the index rebuilds from the file on
 * construction so a restarted session can still query its history (AUD-08).
 * Ledger failure policy is decoupled from sandbox enforcement by design: this
 * plugin never participates in allow/deny decisions, so a ledger error cannot
 * open a security hole; in `strict` mode a begin-write failure surfaces loudly
 * instead of being swallowed (AUD-06).
 * @module @hourglass/sandbox-audit
 */

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { AuditQuery, AuditQueryResult, AuditRecord } from './types.ts'

/** Raised in strict mode when the ledger cannot persist a record. */
export class AuditLedgerError extends Error {
  readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'AuditLedgerError'
    if (cause !== undefined) this.cause = cause
  }
}

export interface AuditLedgerOptions {
  /** JSONL file path; the file is created on first append. */
  readonly path: string
  /**
   * Strict mode: ledger write failures throw (fail-loud) instead of being
   * counted as dropped. Security behavior is identical either way — the
   * ledger never gates execution.
   */
  readonly strict?: boolean
  /** Stamp for every record written by this ledger instance. */
  readonly runId?: string
}

/** Diagnostics for a ledger that dropped records in non-strict mode. */
export interface LedgerDiagnostics {
  readonly path: string
  readonly runId: string
  readonly persisted: number
  readonly dropped: number
  readonly lastError?: string
}

interface WritableAuditRecord {
  schema: string
  kind: string
  runId: string
  seq: number
}

function isAuditRecord(value: unknown): value is AuditRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Partial<WritableAuditRecord>
  return record.schema === 'hourglass-audit/1'
    && (record.kind === 'begin' || record.kind === 'end')
    && typeof record.runId === 'string'
    && typeof record.seq === 'number'
}

export class AuditLedger {
  readonly runId: string
  private readonly options: AuditLedgerOptions
  private readonly strict: boolean
  private readonly records: AuditRecord[] = []
  private nextSeq = 1
  private dropped = 0
  private lastError?: string

  constructor(options: AuditLedgerOptions) {
    this.options = options
    this.strict = options.strict === true
    this.runId = options.runId ?? randomUUID()
    this.load()
  }

  /** Identity of this ledger instance (one plugin load). */
  get path(): string {
    return this.options.path
  }

  /** Rebuild the index from the JSONL file, tolerating a torn final line or an unreadable path. */
  private load(): void {
    if (!existsSync(this.options.path)) return
    let content: string
    try {
      content = readFileSync(this.options.path, 'utf8')
    } catch {
      return
    }
    const lines = content.split('\n')
    // A crashed process can leave a torn last line; drop it on load.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    for (const line of lines) {
      if (line === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (isAuditRecord(parsed)) {
        this.records.push(parsed)
        if (parsed.seq >= this.nextSeq) this.nextSeq = parsed.seq + 1
      }
    }
  }

  /**
   * Append one record. In strict mode a write failure throws
   * {@link AuditLedgerError}; otherwise the drop is counted and surfaced via
   * {@link diagnostics}.
   */
  append(record: Omit<AuditRecord, 'runId' | 'seq'>): AuditRecord {
    const full = { ...record, runId: this.runId, seq: this.nextSeq++ } as AuditRecord
    const line = `${JSON.stringify(full)}\n`
    try {
      appendFileSync(this.options.path, line, { encoding: 'utf8' })
      this.records.push(full)
    } catch (error) {
      this.dropped += 1
      this.lastError = error instanceof Error ? error.message : String(error)
      if (this.strict) throw new AuditLedgerError(`audit ledger write failed: ${this.lastError}`, error)
    }
    return full
  }

  /** Records for one call ordered begin-first — the fact chain for AUD-10. */
  byCall(callId: string): readonly AuditRecord[] {
    return this.records.filter(record => record.callId === callId)
  }

  /** Query with filter, offset/limit pagination, and the total match count. */
  query(query: AuditQuery = {}): AuditQueryResult {
    const filtered = this.records.filter(record => this.matches(record, query))
    const offset = query.offset ?? 0
    const limit = query.limit ?? 50
    return { total: filtered.length, offset, limit, records: filtered.slice(offset, offset + limit) }
  }

  private matches(record: AuditRecord, query: AuditQuery): boolean {
    if (query.sessionId !== undefined && record.sessionId !== query.sessionId) return false
    if (query.callId !== undefined && record.callId !== query.callId) return false
    if (query.tool !== undefined && record.tool !== query.tool) return false
    if (query.kind !== undefined && record.kind !== query.kind) return false
    if (query.outcomeKind !== undefined) {
      if (record.kind !== 'end' || record.outcome.kind !== query.outcomeKind) return false
    }
    if (query.since !== undefined && record.timestamp < query.since) return false
    if (query.until !== undefined && record.timestamp > query.until) return false
    return true
  }

  /** Current health of the ledger instance. */
  diagnostics(): LedgerDiagnostics {
    return {
      path: this.options.path,
      runId: this.runId,
      persisted: this.records.length,
      dropped: this.dropped,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    }
  }

  /**
   * Atomically rotate the ledger file to `target` and reset the in-memory
   * index. Used by maintenance tooling; normal operation only appends.
   */
  rotate(target: string): void {
    writeFileSync(target, this.records.map(record => JSON.stringify(record)).join('\n') + '\n', { encoding: 'utf8' })
    renameSync(target, this.options.path)
  }
}
