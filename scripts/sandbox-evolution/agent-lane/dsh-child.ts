/**
 * Shared one-shot DSH child launcher for the agent lane (ADR-004 D1): the
 * proven carrier-probe recipe, parameterized. Builds a FRESH cordis context
 * stack (SessionStore → AgentRegistry → workingDirectory stub →
 * SubagentRuntime → SdkProvider), spawns a full `sdk`-profile child via
 * subagent-dsh-sdk against a caller-provided one-shot profile patch, and
 * resolves with the child's stop reason plus the child PIDs observed while
 * it ran.
 *
 * The caller owns everything stateful: the profile patch (broker route,
 * workspace, plugin mounts), the mock/broker lifecycle, and the evidence
 * files (ledger, net decision log, stderr lens).
 *
 * @module @hourglass/evolution-runner
 */

import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// DSH imports resolve to the workspace's BUILT lib (strip-only node cannot
// parse the parameter properties in DSH sources — the session-1 lesson).
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SdkProvider from '@deepseek-ai/dsh-subagent-dsh-sdk'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import LoggerConsole from '@deepseek-ai/cordis-plugin-logger-console'

export interface DshChildOptions {
  readonly label: string
  readonly promptText: string
  /** The child agent's working directory (the trial workspace). */
  readonly workspace: string
  /** One-shot child DSH home for this launch. */
  readonly dshHome: string
  /** One-shot profile patch path (buildChildPatchYaml output). */
  readonly patchPath: string
  /** Where the stderr-wrap lens tees the child's stderr. */
  readonly stderrLog: string
  /** Route model id — must match the patch's agent-loop model. */
  readonly modelId: string
  /**
   * Candidate skill snapshot INSIDE the workspace (SKILL.md); the child's
   * skill shim registers it at runtime. Omit for baseline arms.
   */
  readonly candidateSkillPath?: string
  /** Where the skill shim notes what it registered (lens only). */
  readonly skillDumpLog?: string
  /** Hard wall clock for the whole activation (default 180s). */
  readonly timeoutMs?: number
  /** Surface the provider's ctx.logger diagnostics (debugging only). */
  readonly verbose?: boolean
}

export interface DshChildOutcome {
  readonly stopReason: string
  readonly diagnostic?: string
  readonly childPids: readonly number[]
  readonly durationMs: number
  /** Set when the launch itself threw (provider composition, registration). */
  readonly error?: string
  readonly timedOut: boolean
}

function childPidsReferencing(homePath: string): number[] {
  const pids: number[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(entry)) continue
    const pid = Number(entry)
    if (pid === process.pid) continue
    try {
      // DSH_HOME travels in the environment, not argv; same-container root
      // can read /proc/PID/environ.
      const environ = readFileSync(join('/proc', entry, 'environ'), 'utf8')
      if (environ.includes(`DSH_HOME=${homePath}`)) pids.push(pid)
    } catch {
      // process exited between readdir and read — not evidence
    }
  }
  return pids
}

/**
 * Minimal workingDirectory service (the same surface the DSH orchestration
 * fixtures use) — the full runtime tree is not needed to drive an
 * out-of-process SDK child.
 */
class WorkingDirectoryStub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workingDirectory')
  }
  get(session: { header?: { cwd?: string } }): string {
    return session?.header?.cwd ?? process.cwd()
  }
  async ensure(agent: { session: { header?: { cwd?: string } } }, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    return this.get(agent.session)
  }
  async set(agent: { session: { header?: { cwd?: string } } }, path: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    return resolve(this.get(agent.session), path)
  }
}

/** Launch one DSH child and await its completion. Never throws. */
export async function runDshChild(options: DshChildOptions): Promise<DshChildOutcome> {
  const startedAt = Date.now()
  const timeoutMs = options.timeoutMs ?? 180_000
  const ctx = new Context()
  if (options.verbose === true) await ctx.plugin(LoggerConsole)
  let activation: { result: Promise<{ stopReason: string; diagnostic?: string }>; dispose(): Promise<void> } | undefined
  const childPids = new Set<number>()
  const poll = setInterval(() => {
    for (const pid of childPidsReferencing(options.dshHome)) childPids.add(pid)
  }, 100)
  let timedOut = false
  const controller = new AbortController()
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    if (ctx.get('workingDirectory') === undefined) await ctx.plugin(WorkingDirectoryStub)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SdkProvider, {
      providerName: 'dsh-sdk',
      profile: 'sdk',
      patches: [options.patchPath],
      dshHome: options.dshHome,
      // stderr lens: a dshBin wrapper that tees the child's stderr into the
      // run output (composition warnings + runtime errors — the provider's
      // safe diagnostics hide them).
      dshBin: join(dirname(fileURLToPath(import.meta.url)), 'stderr-wrap.mjs'),
      provider: 'deepseek-official',
      model: options.modelId,
      env: {
        // The apiKeyEnv patch override does not reach the volatile
        // credential-ref field, so the child's DeepSeek adapter reads its
        // DEFAULT ambient ref: satisfy it with the dummy — the host-side
        // broker strips client credentials and injects the real upstream
        // key (ADR-004 D2 boundary; the dummy is not a secret).
        DEEPSEEK_API_KEY: 'hourglass-broker-dummy-not-a-secret',
        DSH_TELEMETRY_DISABLED: '1',
        CARRIER_CHILD_STDERR: options.stderrLog,
        CARRIER_REAL_DSH_ENTRY: '/opt/dsh/apps/cli/lib/bin.js',
        ...(options.candidateSkillPath === undefined ? {} : { CARRIER_CANDIDATE_SKILL: options.candidateSkillPath }),
        ...(options.skillDumpLog === undefined ? {} : { CARRIER_SKILL_DUMP: options.skillDumpLog }),
      },
      shutdownTimeoutMs: 2000,
      disposeEofGraceMs: 3000,
      disposeGraceMs: 3000,
    })
    const session = ctx.sessions.create(SessionId(randomUUID()), { meta: { cwd: options.workspace } })
    const inbox = createInboxStub()
    const parent: Agent = {
      id: session.id,
      session,
      ctx,
      options: {},
      status: 'idle',
      inbox,
      send: (message, target) => {
        inbox.append(target, message)
      },
      followup: message => {
        inbox.append('next-turn', message)
      },
      steer: message => {
        inbox.append('next-step', message)
      },
      inject: message => {
        inbox.append('next-step', message)
      },
      cancel: (_cause, cancelOptions) => {
        if (cancelOptions?.keepInbox !== true) inbox.clear()
      },
      whenIdle: () => Promise.resolve(),
      runMaintenance: task => task(new AbortController().signal),
    }
    await ctx.agents.register(parent)
    activation = await ctx.subagents.startActivation({
      provider: 'dsh-sdk',
      label: options.label,
      request: {
        prompt: [{ type: 'text', text: options.promptText }],
        parent,
        cwd: options.workspace,
      },
      signal: controller.signal,
      delivery: 'caller',
    })
    const result = await activation.result
    return {
      stopReason: result.stopReason,
      diagnostic: result.diagnostic,
      childPids: [...childPids].sort((a, b) => a - b),
      durationMs: Date.now() - startedAt,
      timedOut,
    }
  } catch (error) {
    return {
      stopReason: 'launch-failed',
      childPids: [...childPids].sort((a, b) => a - b),
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      timedOut,
    }
  } finally {
    clearTimeout(timer)
    clearInterval(poll)
    if (activation !== undefined) await activation.dispose().catch(() => undefined)
    await ctx.fiber.dispose().catch(() => undefined)
  }
}
