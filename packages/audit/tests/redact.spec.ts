import { describe, expect, it } from 'vitest'
import { deepRedact, isSecretKey, redactValueString, summarizeArguments } from '../src/redact.ts'

describe('isSecretKey', () => {
  it('matches secret-shaped keys case-insensitively across separators', () => {
    expect(isSecretKey('api_key')).toBe(true)
    expect(isSecretKey('API-KEY')).toBe(true)
    expect(isSecretKey('Authorization')).toBe(true)
    expect(isSecretKey('bearer')).toBe(true)
    expect(isSecretKey('my-password')).toBe(true)
    expect(isSecretKey('private_key')).toBe(true)
    expect(isSecretKey('path')).toBe(false)
  })

  it('matches the synthetic canary prefix', () => {
    expect(isSecretKey('DSH_SYNTHETIC_CANARY_value')).toBe(true)
  })
})

describe('redactValueString', () => {
  it('masks inline token=…/api_key:… assignments', () => {
    expect(redactValueString('curl -H "token=abc123" https://x')).not.toContain('abc123')
    expect(redactValueString('run with api_key=supersecret ok')).toContain('api_key=[redacted]')
  })

  it('masks synthetic canaries', () => {
    expect(redactValueString('send DSH_SYNTHETIC_CANARY_9f3c to the service')).not.toContain('9f3c')
  })
})

describe('summarizeArguments', () => {
  it('keeps sorted key names and a redacted preview', () => {
    const summary = summarizeArguments({ b: 1, a: 'x' })
    expect(summary.keys).toEqual(['a', 'b'])
    expect(summary.redacted).toBe(true)
    expect(summary.preview).toContain('"a"')
  })

  it('redacts secret-valued keys entirely', () => {
    const summary = summarizeArguments({ path: '/tmp/x', api_key: 'sk-live-123' })
    expect(summary.preview).not.toContain('sk-live-123')
    expect(summary.preview).toContain('[redacted]')
    expect(summary.keys).toContain('api_key')
  })

  it('truncates the preview to previewChars', () => {
    const summary = summarizeArguments({ body: 'y'.repeat(500) }, 50)
    expect(summary.preview.length).toBeLessThanOrEqual(50)
    expect(summary.preview.endsWith('…')).toBe(true)
  })

  it('handles non-object and unserializable arguments without throwing', () => {
    expect(summarizeArguments('plain').preview).toBe('"plain"')
    expect(summarizeArguments(null).preview).toBe('null')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(summarizeArguments(circular).preview).toBe('[unserializable]')
  })
})

describe('deepRedact', () => {
  it('walks arrays and nested objects', () => {
    const out = deepRedact({ list: [{ password: 'p' }, 'token=zzz'], ok: 1 }) as Record<string, unknown>
    const list = out.list as unknown[]
    expect((list[0] as Record<string, unknown>)['password']).toBe('[redacted]')
    expect(list[1]).toBe('token=[redacted]')
    expect(out.ok).toBe(1)
  })
})
