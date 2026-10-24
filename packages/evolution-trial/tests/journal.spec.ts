import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { EvolutionJournal, GENESIS_HASH } from '../src/evolution-journal.ts'

const root = mkdtempSync(join(tmpdir(), 'evo-journal-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function journalPath(name: string): string {
  return join(root, `${name}.jsonl`)
}

describe('EvolutionJournal (hash-chain lifecycle events)', () => {
  it('builds a verifiable chain from genesis', () => {
    const journal = new EvolutionJournal(journalPath('ok'))
    journal.append('proposal-created', { candidateId: 'cand-1' }, { source: 'synthetic' })
    journal.append('trial-started', { candidateId: 'cand-1', trialId: 'trial-1' })
    journal.append('decision-recorded', { trialId: 'trial-1' }, { decision: 'pass' })
    const events = journal.events()
    expect(events).toHaveLength(3)
    expect(events[0].prevHash).toBe(GENESIS_HASH)
    expect(events[1].prevHash).toBe(events[0].hash)
    expect(journal.verify().ok).toBe(true)
  })

  it('detects field tampering at the first affected record', () => {
    const path = journalPath('tamper')
    const journal = new EvolutionJournal(path)
    journal.append('proposal-created', { candidateId: 'cand-1' })
    journal.append('decision-recorded', { trialId: 'trial-1' }, { decision: 'pass' })
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    const poisoned = JSON.parse(lines[1] as string) as { detail: { decision: string } }
    poisoned.detail.decision = 'reject'
    lines[1] = JSON.stringify(poisoned)
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
    const result = new EvolutionJournal(path).verify()
    expect(result.ok).toBe(false)
    expect(result.firstBadSeq).toBe(2)
    expect(result.reason).toMatch(/does-not-match-its-recorded-hash/)
  })

  it('detects line removal as a broken chain', () => {
    const path = journalPath('removal')
    const journal = new EvolutionJournal(path)
    journal.append('a')
    journal.append('b')
    journal.append('c')
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    lines.splice(1, 1)
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
    const result = new EvolutionJournal(path).verify()
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/chain-broken-at/)
  })

  it('correlates events by candidateId/trialId/callId', () => {
    const journal = new EvolutionJournal(journalPath('refs'))
    journal.append('tool-call-observed', { candidateId: 'cand-9', trialId: 'trial-9', callId: 'call-42' })
    const event = journal.events().find(item => item.callId === 'call-42')
    expect(event?.trialId).toBe('trial-9')
    expect(event?.candidateId).toBe('cand-9')
  })

  it('treats an empty journal file as zero events', () => {
    const path = journalPath('empty')
    writeFileSync(path, '', 'utf8')
    expect(new EvolutionJournal(path).events()).toEqual([])
  })

  it('strict mode throws on append failure while non-strict swallows it', () => {
    const missingDir = join(root, 'no-such-dir', 'j.jsonl')
    const strict = new EvolutionJournal(missingDir, { strict: true })
    expect(() => strict.append('boom')).toThrow()
    const lenient = new EvolutionJournal(missingDir, { strict: false })
    const event = lenient.append('boom')
    expect(event.kind).toBe('boom')
    expect(lenient.events()).toEqual([])
  })
})
