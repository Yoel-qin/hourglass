/**
 * Evolution lifecycle journal (v3.1 §3.3): an append-only SHA-256 hash chain
 * mirroring the technique of packages/audit/src/ledger.ts (GENESIS -> prevHash
 * -> hash over the record). Tampering with any field breaks the chain at the
 * first affected seq; deleting or reordering lines breaks the link. Like the
 * audit ledger this is detection, not resistance: it does not stop an actor
 * with write access to the file from destroying it, which is why trials never
 * receive a write path to the journal.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { canonicalJson, sha256Hex } from '@hourglass/evolution-contract/src/index.ts'

export const GENESIS_HASH = '0'.repeat(64)

export interface JournalRefs {
  readonly candidateId?: string
  readonly trialId?: string
  readonly callId?: string
}

export interface JournalEvent extends JournalRefs {
  readonly seq: number
  readonly at: string
  readonly kind: string
  readonly detail?: Record<string, unknown>
  readonly prevHash: string
  readonly hash: string
}

export interface JournalVerifyResult {
  readonly ok: boolean
  readonly firstBadSeq?: number
  readonly reason?: string
}

export class EvolutionJournal {
  private readonly path: string
  private readonly strict: boolean

  constructor(path: string, options: { strict?: boolean } = {}) {
    this.path = path
    this.strict = options.strict === true
  }

  append(kind: string, refs: JournalRefs = {}, detail: Record<string, unknown> = {}): JournalEvent {
    const events = this.events()
    const prevHash = events.length === 0 ? GENESIS_HASH : events[events.length - 1].hash
    const event: Omit<JournalEvent, 'hash'> = {
      seq: events.length + 1,
      at: new Date().toISOString(),
      kind,
      ...refs,
      ...(Object.keys(detail).length === 0 ? {} : { detail }),
      prevHash,
    }
    const hash = sha256Hex(`${event.prevHash}\n${canonicalJson(event)}`)
    const full: JournalEvent = { ...event, hash }
    try {
      appendFileSync(this.path, `${JSON.stringify(full)}\n`, 'utf8')
    } catch (error) {
      if (this.strict) throw error
    }
    return full
  }

  events(): JournalEvent[] {
    if (!existsSync(this.path)) return []
    const text = readFileSync(this.path, 'utf8').trim()
    if (text === '') return []
    return text.split('\n').map(line => JSON.parse(line) as JournalEvent)
  }

  verify(): JournalVerifyResult {
    const events = this.events()
    let prevHash = GENESIS_HASH
    for (const event of events) {
      if (event.prevHash !== prevHash) {
        return { ok: false, firstBadSeq: event.seq, reason: `chain-broken-at:${event.seq}` }
      }
      const { hash: _hash, ...withoutHash } = event
      const expected = sha256Hex(`${event.prevHash}\n${canonicalJson(withoutHash)}`)
      if (event.hash !== expected) {
        return { ok: false, firstBadSeq: event.seq, reason: `record-content-does-not-match-its-recorded-hash:${event.seq}` }
      }
      prevHash = event.hash
    }
    return { ok: true }
  }
}
