import { describe, expect, it } from 'vitest'
import { classifyOutcome, extractSandboxFacts } from '../src/classify.ts'

describe('classifyOutcome', () => {
  it('a success result classifies as allowed', () => {
    expect(classifyOutcome({ isError: false })).toEqual({ kind: 'allowed', basis: 'result is success' })
  })

  it('SANDBOX_UNAVAILABLE is a runner failure, not a denial', () => {
    const outcome = classifyOutcome({ isError: true, errorCode: 'SANDBOX_UNAVAILABLE', errorMessage: 'bwrap missing' })
    expect(outcome.kind).toBe('runner-failure')
  })

  it('abort codes classify as cancelled', () => {
    expect(classifyOutcome({ isError: true, errorCode: 'ABORTED' }).kind).toBe('cancelled')
    expect(classifyOutcome({ isError: true, errorCode: 'ABORTED_BEFORE_DISPATCH' }).kind).toBe('cancelled')
  })

  it('result.sandbox.runnerFailed outranks a generic error message', () => {
    const outcome = classifyOutcome({ isError: true, errorMessage: 'boom', sandbox: { runnerFailed: true } })
    expect(outcome.kind).toBe('runner-failure')
    expect(outcome.basis).toContain('runnerFailed')
  })

  it('result.sandbox.denied classifies as sandbox-denial', () => {
    const outcome = classifyOutcome({ isError: true, errorMessage: 'x', sandbox: { denied: true, enforcement: 'full' } })
    expect(outcome.kind).toBe('sandbox-denial')
    expect(outcome.basis).toContain('result.sandbox.denied')
  })

  it('FS_SANDBOX_DENIED is a harness policy denial (the fs fence)', () => {
    const outcome = classifyOutcome({ isError: true, errorCode: 'FS_SANDBOX_DENIED', errorMessage: 'denied' })
    expect(outcome.kind).toBe('policy-deny')
    expect(outcome.basis).toContain('FS_SANDBOX_DENIED')
  })

  it('the escalation rejection marker classifies as approval-deny', () => {
    const outcome = classifyOutcome({
      isError: true,
      errorMessage: 'the user rejected escalating this operation to "workspace-write"; it stays denied',
    })
    expect(outcome.kind).toBe('approval-deny')
  })

  it('a plain error with no structured signal is an ordinary failure', () => {
    const outcome = classifyOutcome({ isError: true, errorMessage: 'command not found' })
    expect(outcome.kind).toBe('ordinary-failure')
  })

  it('a backend-dialect stderr fragment alone never becomes a sandbox denial', () => {
    const outcome = classifyOutcome({ isError: true, errorMessage: 'bash: line 1: /x: Read-only file system' })
    expect(outcome.kind).toBe('ordinary-failure')
  })
})

describe('extractSandboxFacts', () => {
  it('returns undefined for absent or non-object meta', () => {
    expect(extractSandboxFacts(undefined)).toBeUndefined()
    expect(extractSandboxFacts(null)).toBeUndefined()
    expect(extractSandboxFacts('x')).toBeUndefined()
    expect(extractSandboxFacts({})).toBeUndefined()
    expect(extractSandboxFacts({ sandbox: 'nope' })).toBeUndefined()
    expect(extractSandboxFacts({ sandbox: { mode: 'read-only' } })).toBeUndefined()
  })

  it('extracts only the published boolean/enforcement fields', () => {
    expect(extractSandboxFacts({ sandbox: { denied: true } })).toEqual({ denied: true })
    expect(extractSandboxFacts({ sandbox: { runnerFailed: false, enforcement: 'partial' } }))
      .toEqual({ runnerFailed: false, enforcement: 'partial' })
  })
})
