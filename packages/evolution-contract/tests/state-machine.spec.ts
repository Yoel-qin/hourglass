import { describe, expect, it } from 'vitest'
import { TERMINAL_STATES, canTransition, isCandidateState, transition } from '../src/index.ts'

describe('candidate state machine (v3.1 §3.2)', () => {
  it('walks the full happy path draft -> stable through legal steps only', () => {
    const path = [
      'draft',
      'sealed',
      'prechecked',
      'queued',
      'trial_running',
      'evaluated',
      'validation_pack_ready',
      'awaiting_human_approval',
      'manually_applied',
      'watching',
      'stable',
    ] as const
    for (let index = 0; index < path.length - 1; index += 1) {
      expect(transition(path[index], path[index + 1]).ok).toBe(true)
    }
  })

  it('cannot skip human approval (evaluated -> manually_applied is illegal)', () => {
    expect(transition('evaluated', 'manually_applied').ok).toBe(false)
    expect(transition('validation_pack_ready', 'manually_applied').ok).toBe(false)
  })

  it('cannot jump from draft to any downstream state', () => {
    expect(transition('draft', 'trial_running').ok).toBe(false)
    expect(transition('draft', 'manually_applied').ok).toBe(false)
    expect(transition('draft', 'stable').ok).toBe(false)
  })

  it('terminal states have no outgoing transitions', () => {
    for (const state of TERMINAL_STATES) {
      expect(canTransition(state, 'draft')).toBe(false)
      expect(transition(state, 'rejected').ok).toBe(false)
    }
  })

  it('rollback only applies to already-applied assets', () => {
    expect(transition('evaluated', 'rollback_pending').ok).toBe(false)
    expect(transition('manually_applied', 'rollback_pending').ok).toBe(true)
    expect(transition('watching', 'rollback_pending').ok).toBe(true)
    expect(transition('stable', 'rollback_pending').ok).toBe(true)
    expect(transition('rollback_pending', 'rolled_back').ok).toBe(true)
    expect(transition('rollback_pending', 'apply_conflict').ok).toBe(true)
  })

  it('apply_conflict is terminal and reachable from approval and rollback paths', () => {
    expect(TERMINAL_STATES).toContain('apply_conflict')
    expect(transition('awaiting_human_approval', 'apply_conflict').ok).toBe(true)
    expect(transition('manually_applied', 'apply_conflict').ok).toBe(true)
    expect(transition('apply_conflict', 'draft').ok).toBe(false)
  })

  it('rejects unknown states with a qualified reason', () => {
    expect(isCandidateState('happy')).toBe(false)
    expect(transition('draft', 'happy' as never).reason).toBe('unknown-state:happy')
    expect(transition('shadow_running' as never, 'draft' as never).reason).toBe('unknown-state:shadow_running')
    expect(transition('draft', 'sealed').reason).toBeUndefined()
  })
})
