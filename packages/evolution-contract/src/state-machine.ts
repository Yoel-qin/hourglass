/**
 * Candidate lifecycle state machine (v3.1 plan §3.2).
 *
 * Transitions are an explicit allow-list; anything not listed is refused.
 * `watching`/`stable` are manual-observation states in the MVP: no production
 * auto-watcher exists and none may be implied by this table.
 */

import type { CandidateState } from './types.ts'

export const TERMINAL_STATES: readonly CandidateState[] = [
  'rejected',
  'inconclusive',
  'blocked',
  'cancelled',
  'expired',
  'apply_conflict',
  'rolled_back',
]

export const TRANSITIONS: Readonly<Record<CandidateState, readonly CandidateState[]>> = {
  draft: ['sealed', 'rejected', 'blocked', 'cancelled', 'expired'],
  sealed: ['prechecked', 'rejected', 'blocked', 'cancelled', 'expired'],
  prechecked: ['queued', 'rejected', 'blocked', 'cancelled', 'expired'],
  queued: ['trial_running', 'rejected', 'blocked', 'cancelled', 'expired'],
  trial_running: ['evaluated', 'blocked', 'cancelled', 'expired'],
  evaluated: ['validation_pack_ready', 'rejected', 'inconclusive', 'blocked', 'cancelled', 'expired'],
  validation_pack_ready: ['awaiting_human_approval', 'rejected', 'cancelled', 'expired'],
  awaiting_human_approval: ['manually_applied', 'rejected', 'cancelled', 'expired', 'apply_conflict'],
  manually_applied: ['watching', 'apply_conflict', 'rollback_pending', 'cancelled', 'expired'],
  watching: ['stable', 'rollback_pending', 'cancelled', 'expired'],
  stable: ['rollback_pending'],
  rollback_pending: ['rolled_back', 'apply_conflict', 'blocked'],
  rejected: [],
  inconclusive: [],
  blocked: [],
  cancelled: [],
  expired: [],
  apply_conflict: [],
  rolled_back: [],
}

export interface TransitionResult {
  readonly ok: boolean
  readonly next?: CandidateState
  readonly reason?: string
}

export function isCandidateState(value: unknown): value is CandidateState {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TRANSITIONS, value)
}

export function canTransition(from: CandidateState, to: CandidateState): boolean {
  return TRANSITIONS[from].includes(to)
}

export function transition(from: CandidateState, to: CandidateState): TransitionResult {
  if (!isCandidateState(from)) {
    return { ok: false, reason: `unknown-state:${String(from)}` }
  }
  if (!isCandidateState(to)) {
    return { ok: false, reason: `unknown-state:${String(to)}` }
  }
  if (!canTransition(from, to)) {
    return { ok: false, reason: `illegal-transition:${from}->${to}` }
  }
  return { ok: true, next: to }
}
