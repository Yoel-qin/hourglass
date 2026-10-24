import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildTrialConfinement, driverCwd, ignoreStreamError, resolveDriverPath, runTrial } from '../src/index.ts'

/**
 * Launcher edge paths that do NOT need bwrap: driver resolution failures,
 * watchdog timeout, silent/garbage driver output, and spawn errors. The
 * drivers here are throwaway .mjs scripts standing in for the real
 * trial-driver; no real trial code runs.
 */

const root = mkdtempSync(join(tmpdir(), 'evo-launcher-edge-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const quick = buildTrialConfinement({ watchdogMs: 2_000 })

function trialRequest(overrides: Record<string, unknown>) {
  return {
    trialId: 'edge',
    workspaceRoot: join(root, 'ws'),
    ledgerPath: join(root, 'edge-ledger.jsonl'),
    commands: [{ callId: 'c1', command: 'true' }],
    confinement: quick,
    ...overrides,
  }
}

describe('driver resolution', () => {
  it('throws when no candidate exists', () => {
    expect(() => resolveDriverPath('/definitely/missing', ['/also/missing'])).toThrow(/trial-driver-not-found/)
  })

  it('picks the first existing candidate', () => {
    const driver = join(root, 'fake-driver.mjs')
    writeFileSync(driver, 'process.exit(0)\n', 'utf8')
    expect(resolveDriverPath('/definitely/missing', ['/also/missing', driver])).toBe(driver)
  })

  it('driverCwd falls back to the process cwd for a missing root', () => {
    expect(driverCwd('/definitely/missing-root')).toBe(process.cwd())
    expect(driverCwd()).toBe(driverCwd('/opt/dsh'))
  })

  it('ignoreStreamError is a callable no-op (the EPIPE containment listener)', () => {
    expect(() => ignoreStreamError()).not.toThrow()
  })
})

describe('launcher failure modes', () => {
  it('times out and kills a hanging driver', { timeout: 15_000 }, async () => {
    const driver = join(root, 'hang.mjs')
    writeFileSync(driver, 'setInterval(() => {}, 1000)\n', 'utf8')
    const response = await runTrial(trialRequest({ driverPath: driver }) as never)
    expect(response.ok).toBe(false)
    expect(response.timedOut).toBe(true)
    expect(response.error).toBe('trial-watchdog-timeout')
  })

  it('reports a driver that exits without output', { timeout: 15_000 }, async () => {
    const driver = join(root, 'silent.mjs')
    writeFileSync(driver, 'process.exit(0)\n', 'utf8')
    const response = await runTrial(trialRequest({ driverPath: driver }) as never)
    expect(response.ok).toBe(false)
    expect(response.error).toMatch(/^driver-no-output:/)
  })

  it('reports unparseable driver output', { timeout: 15_000 }, async () => {
    const driver = join(root, 'garbage.mjs')
    writeFileSync(driver, "console.error('driver noise on stderr'); process.stdout.write('this is not json{')\n", 'utf8')
    const response = await runTrial(trialRequest({ driverPath: driver }) as never)
    expect(response.ok).toBe(false)
    expect(response.error).toMatch(/^driver-output-unparseable:/)
  })

  it('contains an EPIPE on stdin instead of crashing the runner', { timeout: 15_000 }, async () => {
    const driver = join(root, 'epipe.mjs')
    // Destroy the read end and STAY alive: the oversized payload keeps
    // writing after the reader is gone, which is what actually produces
    // the EPIPE the stdin error listener must contain.
    writeFileSync(driver, 'process.stdin.destroy(); setInterval(() => {}, 1000)\n', 'utf8')
    const oversized = 'x'.repeat(200_000)
    const response = await runTrial(trialRequest({
      driverPath: driver,
      commands: [{ callId: 'big', command: oversized }],
    }) as never)
    expect(response).toBeDefined()
    expect(response.ok).toBe(false)
    // The driver never exits on its own: the watchdog is what resolves.
    expect(response.timedOut).toBe(true)
  })

  it('reports a spawn failure (missing working directory)', { timeout: 15_000 }, async () => {
    const driver = join(root, 'any.mjs')
    writeFileSync(driver, 'process.exit(0)\n', 'utf8')
    const response = await runTrial(trialRequest({ driverPath: driver, driverCwd: '/definitely/missing-cwd' }) as never)
    expect(response.ok).toBe(false)
    expect(response.error).toMatch(/^driver-spawn-failed:/)
  })
})
