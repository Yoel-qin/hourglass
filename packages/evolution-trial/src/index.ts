/**
 * hourglass evolution-trial plugin. Read-only operator surface: the
 * `sandbox-evolution` command queries candidate-store and journal state.
 * The plugin never gates execution, never mounts the trial in-process, and
 * never calls the approval service (human approval lives in the validation
 * pack flow, not in a slash command — approval.request() requires an open
 * model turn, which commands do not create).
 *
 * @module @hourglass/evolution-trial
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { CandidateStore } from './candidate-store.ts'
import { EvolutionJournal } from './evolution-journal.ts'

export const name = 'hourglass-evolution-trial'

export interface Config {
  /** Root directory for the candidate store and the evolution journal. */
  rootDir?: string
}

export const Config: z<Config> = z.object({
  rootDir: z.string().default('hourglass-evolution'),
})

/** Rendering for thrown values of any shape (Errors carry their message). */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function apply(ctx: Context, config: Config): void {
  // config.rootDir is always a string here: the schemastery Config schema
  // fills the 'hourglass-evolution' default before apply sees it.
  const store = new CandidateStore(join(config.rootDir, 'candidates'))
  const journal = new EvolutionJournal(join(config.rootDir, 'evolution-journal.jsonl'))

  ctx.inject(['commands'], (commandCtx: Context) => {
    commandCtx.commands.register({
      definitionId: '@hourglass/evolution-trial',
      name: 'sandbox-evolution',
      description: 'Query the hourglass evolution trial state (read-only)',
      input: { hint: '[{"candidateId":"cand-..."}] or empty for a summary' },
      handler: ({ rawInput }: { rawInput: string }) => {
        const trimmed = rawInput.trim()
        if (trimmed === '') {
          const events = journal.events()
          const chain = journal.verify()
          return {
            kind: 'success' as const,
            text: `journal ${chain.ok ? 'chain-ok' : `CHAIN-BROKEN:${chain.reason}`}: `
              + `${events.length} event(s), last=${events.length === 0 ? '(empty)' : events[events.length - 1].kind}\n`
              + 'recent: ' + events.slice(-5).map(event => `${event.seq}:${event.kind}`).join(', '),
          }
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          return { kind: 'error' as const, text: 'query filter must be a JSON object' }
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { kind: 'error' as const, text: 'query filter must be a JSON object' }
        }
        const filter = parsed as { candidateId?: string }
        if (typeof filter.candidateId !== 'string' || filter.candidateId === '') {
          return { kind: 'error' as const, text: 'filter must carry a candidateId' }
        }
        try {
          const manifest = store.load(filter.candidateId)
          const verification = store.verifyArtifact(filter.candidateId)
          return {
            kind: 'success' as const,
            text: `${JSON.stringify(manifest)}\nartifact: ${verification.ok ? 'verified' : `BROKEN:${verification.reason}`}`,
          }
        } catch (error) {
          return { kind: 'error' as const, text: errorText(error) }
        }
      },
    })
  })
}

export { CandidateStore } from './candidate-store.ts'
export { EvolutionJournal, GENESIS_HASH } from './evolution-journal.ts'
export type { JournalEvent, JournalRefs, JournalVerifyResult } from './evolution-journal.ts'
export { buildTrialConfinement, TRIAL_RSRC_DEFAULTS } from './confine-trial.ts'
export type { TrialConfinement, TrialRsrcBudget } from './confine-trial.ts'
export { driverCwd, ignoreStreamError, resolveDriverPath, runTrial } from './trial-launcher.ts'
export type { TrialCommand, TrialRequest, TrialResponse, TrialCommandResult } from './trial-launcher.ts'
export { exportValidationPack, loadPack, packPathFor, verifyValidationPack } from './validation-pack.ts'
export type { ExportPackInput, ExportedPack } from './validation-pack.ts'
export {
  capViolation, ensureStreamUsageOption, errorDetail, extractUsageFromJson, extractUsageFromMessagesJson,
  extractUsageFromMessagesSse, extractUsageFromSse, parseRequestUrl, portOf, startLlmBroker,
} from './llm-broker.ts'
export type { LlmBroker, LlmBrokerConfig, UsageCaps, UsageCounts, UsageRecord, UsageReport } from './llm-broker.ts'
export { pickArgumentProperty, startMockLlmServer } from './mock-llm-server.ts'
export type { MockLlmConfig, MockLlmRequest, MockLlmServer, ScriptedResponse } from './mock-llm-server.ts'
