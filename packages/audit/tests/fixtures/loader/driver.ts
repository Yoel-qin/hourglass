#!/usr/bin/env node
/**
 * Test driver: boot the hourglass-audit Loader composition, register a probe
 * tool, execute it through the real tool registry (one success, one failure,
 * one secret-bearing call), and persist the ledger facts the plugin wrote to
 * ./hourglass-loader-report.json for the spec's inspect step.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('hourglass loader driver requires a config path')

const ctx = await boot('hourglass-audit-loader-smoke', resolveConfigPath(configPath, undefined))
try {
  ctx.tools.register(defineContentToolFixture({
    name: 'probe',
    description: 'loader probe',
    parameters: {},
    async execute() {
      return [{ type: 'text', text: 'ok' }]
    },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'fails',
    description: 'loader failure probe',
    parameters: {},
    async execute() {
      throw new Error('boom')
    },
  }))

  const signal = new AbortController().signal
  await ctx.tools.execute({ signal, callId: ToolCallId('loader-ok'), name: 'probe', arguments: { q: 1 } })
  await ctx.tools.execute({ signal, callId: ToolCallId('loader-secret'), name: 'probe', arguments: { api_key: 'loader-sk-123' } })
  await ctx.tools.execute({ signal, callId: ToolCallId('loader-fail'), name: 'fails', arguments: {} })

  const ledgerText = await readFile('./hourglass-loader-audit.jsonl', 'utf8')
  const records = ledgerText.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  const ends = records.filter(record => record.kind === 'end') as { outcome?: { kind?: string }; backend?: { source?: string } }[]
  const secretBegin = records.find(record => record.kind === 'begin' && record.callId === 'loader-secret') as
    | { argumentsSummary?: { preview?: string } }
    | undefined

  await writeFile('./hourglass-loader-report.json', JSON.stringify({
    totalRecords: records.length,
    outcomeKinds: ends.map(record => record.outcome?.kind),
    backendSource: ends[0]?.backend?.source,
    beginCount: records.filter(record => record.kind === 'begin').length,
    endCount: ends.length,
    secretRedacted: secretBegin?.argumentsSummary?.preview?.includes('loader-sk-123') !== true
      && secretBegin?.argumentsSummary?.preview?.includes('[redacted]') === true,
  }))
} finally {
  await ctx.fiber.dispose()
}
