import { describe, expect, it } from 'vitest'
import { canonicalJson, isSha256, sha256Hex } from '../src/index.ts'

describe('hash primitives', () => {
  it('canonicalJson maps undefined to the null literal', () => {
    expect(canonicalJson(undefined)).toBe('null')
  })

  it('canonicalJson sorts keys recursively and drops undefined values', () => {
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: [{ z: 1, y: undefined }] })).toBe('{"a":[{"z":1}],"b":{"c":2,"d":1}}')
  })

  it('isSha256 accepts only lowercase 64-hex digests', () => {
    expect(isSha256('a'.repeat(64))).toBe(true)
    expect(isSha256('A'.repeat(64))).toBe(false)
    expect(isSha256('a'.repeat(63))).toBe(false)
    expect(isSha256(42)).toBe(false)
  })

  it('sha256Hex is stable for identical input', () => {
    expect(sha256Hex('hourglass')).toBe(sha256Hex('hourglass'))
    expect(sha256Hex('hourglass')).toMatch(/^[0-9a-f]{64}$/u)
  })
})
