/**
 * hourglass sandbox-audit plugin. Observes the tool pipeline and writes an
 * append-only structured audit ledger: a policy-decision record at
 * `tools/pre-execute` and a correlated outcome record at `tools/result`.
 *
 * The plugin is a pure observer: it never allows, denies, or rewrites a call.
 * Backend enforcement facts are recorded only when a consumer actually
 * published them (`result.sandbox`); every other call carries
 * `source: 'unavailable'` rather than a guessed value. The OS-observation
 * layer is recorded as unavailable until a real observer exists.
 * @module @hourglass/sandbox-audit
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { AuditLedger } from './ledger.ts'
import { classifyOutcome, extractSandboxFacts } from './classify.ts'
import { summarizeArguments } from './redact.ts'
import type { AuditEndRecord, AuditPolicySnapshot } from './types.ts'

export const name = 'hourglass-sandbox-audit'

export interface Config {
  /** JSONL ledger location. */
  ledgerPath?: string
  /**
   * Strict mode: ledger write failures throw instead of being counted as
   * dropped. Either way sandbox enforcement is untouched — the ledger never
   * gates execution.
   */
  strict?: boolean
  /** Maximum characters of the redacted arguments preview (default 200). */
  previewChars?: number
}

export const Config: z<Config> = z.object({
  ledgerPath: z.string().default('hourglass-audit.jsonl'),
  strict: z.boolean().default(false),
  previewChars: z.number().default(200),
})

/** Resolve the policy snapshot for one execution without throwing. */
function policySnapshot(ctx: Context, exec: ToolExecution): AuditPolicySnapshot {
  const policy = ctx.get('sandboxPolicy')
  const sessions = ctx.get('sessions')
  const agent = exec.agent
  if (policy === undefined) return { resolvedFrom: 'unavailable' }
  try {
    const session = agent !== undefined ? sessions?.get(agent.id) : undefined
    if (session !== undefined) {
      const resolved = policy.resolve({ session })
      const overridden = policy.overrideOf(session)
      return {
        mode: resolved.mode,
        resolvedFrom: overridden !== undefined ? 'session' : 'configured',
      }
    }
    const resolved = policy.resolve()
    return { mode: resolved.mode, resolvedFrom: 'configured' }
  } catch {
    return { resolvedFrom: 'unavailable' }
  }
}

interface BeginState {
  readonly at: number
}

export function apply(ctx: Context, config: Config): void {
  const ledger = new AuditLedger({ path: config.ledgerPath ?? 'hourglass-audit.jsonl', strict: config.strict === true })
  const begins = new Map<string, BeginState>()

  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<unknown>) => {
    ledger.append({
      schema: 'hourglass-audit/1',
      kind: 'begin',
      timestamp: new Date().toISOString(),
      ...(exec.agent === undefined ? {} : { sessionId: String(exec.agent.id) }),
      callId: String(exec.callId),
      ...(exec.rootCallId === undefined ? {} : { rootCallId: String(exec.rootCallId) }),
      tool: exec.name,
      layer: 'policy_decision',
      policy: policySnapshot(ctx, exec),
      argumentsSummary: summarizeArguments(exec.arguments, config.previewChars),
    })
    begins.set(String(exec.callId), { at: Date.now() })
    return next() as never
  })

  ctx.on('tools/result', (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined => {
    const callId = String(exec.callId)
    const begin = begins.get(callId)
    begins.delete(callId)
    const signals = {
      isError: result.isError,
      ...(result.isError
        ? {
            errorCode: result.error.info?.code,
            errorMessage: result.error.message,
          }
        : {}),
      ...(() => {
        // Consumers stamp sandbox facts on the canonical value (tool-bash's
        // contract); meta is a fallback for other consumers.
        const fromValue = extractSandboxFacts(result.isError ? undefined : result.value)
        const fromMeta = extractSandboxFacts(result.meta)
        const facts = fromValue ?? fromMeta
        return facts === undefined ? {} : { sandbox: facts, sandboxSource: fromValue !== undefined ? 'tools/result/value.sandbox' : 'tools/result/meta.sandbox' }
      })(),
    }
    const outcome = classifyOutcome(signals)
    const end: Omit<AuditEndRecord, 'runId' | 'seq'> = {
      schema: 'hourglass-audit/1',
      kind: 'end',
      timestamp: new Date().toISOString(),
      ...(exec.agent === undefined ? {} : { sessionId: String(exec.agent.id) }),
      callId,
      ...(exec.rootCallId === undefined ? {} : { rootCallId: String(exec.rootCallId) }),
      tool: exec.name,
      layer: 'backend_result',
      outcome,
      backend: {
        ...(signals.sandbox?.enforcement === undefined ? {} : { enforcement: signals.sandbox.enforcement }),
        ...(signals.sandbox?.denied === undefined ? {} : { denied: signals.sandbox.denied }),
        ...(signals.sandbox?.runnerFailed === undefined ? {} : { runnerFailed: signals.sandbox.runnerFailed }),
        source: signals.sandbox === undefined ? 'unavailable' : (signals.sandboxSource ?? 'tools/result/value.sandbox'),
      },
      osObservation: { status: 'unavailable' },
      ...(begin === undefined ? {} : { durationMs: Date.now() - begin.at }),
      ...(result.isError && result.error.info !== undefined
        ? {
            error: {
              name: result.error.info.name,
              ...(result.error.info.code === undefined ? {} : { code: result.error.info.code }),
              ...(result.error.info.reason === undefined ? {} : { reason: result.error.info.reason }),
            },
          }
        : {}),
    }
    ledger.append(end)
    return undefined
  })

  ctx.inject(['commands'], (commandCtx: Context) => {
    commandCtx.commands.register({
      definitionId: '@hourglass/sandbox-audit',
      name: 'sandbox-audit',
      description: 'Query the hourglass sandbox audit ledger (read-only)',
      input: { hint: '[JSON query filter, e.g. {"tool":"bash","outcomeKind":"sandbox-denial"}]' },
      handler: ({ rawInput }: { rawInput: string }) => {
        const trimmed = rawInput.trim()
        if (trimmed === '') {
          const diagnostics = ledger.diagnostics()
          const recent = ledger.query({ limit: 20 })
          return {
            kind: 'success' as const,
            text: `ledger ${diagnostics.path}: ${diagnostics.persisted} persisted, ${diagnostics.dropped} dropped\n`
              + `${recent.records.map(record => `${record.timestamp} ${record.kind} ${record.tool} ${record.callId}`
                + (record.kind === 'end' ? ` -> ${record.outcome.kind}` : '')).join('\n')}`,
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
        const source = parsed as Record<string, unknown>
        const page = ledger.query({
          ...(typeof source.sessionId === 'string' ? { sessionId: source.sessionId } : {}),
          ...(typeof source.callId === 'string' ? { callId: source.callId } : {}),
          ...(typeof source.tool === 'string' ? { tool: source.tool } : {}),
          ...(source.kind === 'begin' || source.kind === 'end' ? { kind: source.kind } : {}),
          ...(typeof source.outcomeKind === 'string' ? { outcomeKind: source.outcomeKind as never } : {}),
          ...(typeof source.limit === 'number' ? { limit: source.limit } : {}),
          ...(typeof source.offset === 'number' ? { offset: source.offset } : {}),
        })
        return {
          kind: 'success' as const,
          text: `${page.total} match(es), showing ${page.records.length}\n`
            + page.records.map(record => JSON.stringify(record)).join('\n'),
        }
      },
    })
  })
}
