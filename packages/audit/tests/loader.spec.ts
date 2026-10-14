/**
 * REAL-composition tier (packages/AGENTS.md): boot the hourglass-audit
 * fixture through the same Loader/app-boot path a deployment uses, execute
 * real tool calls through the registry, and assert what the audit ledger
 * actually recorded: begin/end correlation, outcome classification, backend
 * source honesty, and argument redaction.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/loader/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/loader/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

interface HourglassLoaderReport {
  totalRecords: number
  outcomeKinds: string[]
  backendSource: string
  beginCount: number
  endCount: number
  secretRedacted: boolean
}

describe('hourglass-sandbox-audit through a real Loader composition', () => {
  const processTimeoutMs = 90_000
  it('records every executed call with classified outcomes and redacted arguments', async () => {
    let report: HourglassLoaderReport | undefined
    const { stderr } = await runLoaderSmoke({
      label: 'hourglass-audit loader smoke',
      tempDirPrefix: 'hourglass-audit-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      processTimeoutMs,
      inspect: async cwd => {
        report = JSON.parse(await readFile(join(cwd, 'hourglass-loader-report.json'), 'utf8')) as HourglassLoaderReport
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(report).toBeDefined()
    expect(report!.totalRecords).toBe(6) // three calls × (begin + end)
    expect(report!.beginCount).toBe(3)
    expect(report!.endCount).toBe(3)
    expect(report!.outcomeKinds).toContain('allowed')
    expect(report!.outcomeKinds.filter(kind => kind === 'ordinary-failure')).toHaveLength(1)
    expect(report!.backendSource).toBe('unavailable') // fs-fixture tools publish no sandbox facts
    expect(report!.secretRedacted).toBe(true)
  }, processTimeoutMs + 15_000)
})
