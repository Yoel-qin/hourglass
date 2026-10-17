/**
 * Wasmer adapter (WASM capability sandbox lane). Wasmer's isolation is
 * structural, not policy-based: the guest sees only the volumes mapped with
 * --volume on top of a virtual in-memory root, and WASI preview1 exposes no
 * sockets or subprocess. Compare cases map onto a compiled WASI probe
 * fixture (scripts/sandbox-compare/fixtures-wasm/fs_probe.zig) that carries
 * the same attack semantics and speaks the same evidence markers the
 * runner's verdict regexes already understand.
 *
 * Honest scope (versions.lock constraints):
 * - NET/ROB-03 cases: no socket capability in the preview1 carrier — the
 *   network attack surface is structurally absent, judged incomparable
 *   rather than risk a vacuous PASS.
 * - RES cases: wasmer run v7.3.0 exposes no resource caps at the CLI
 *   (fuel metering and memory tunables are embedder-only).
 * - FS-09/11/12: no subprocess and no deny-read below a mapped volume.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { CompareCase } from '../schema.ts'
import type { RawExecution, RunEnv, SubjectAdapter } from './types.ts'

const FIXTURE = '/opt/hourglass-wasm/fs_probe.wasm'
const GUEST_WS = '/workspace'

/** One probe invocation: guest args plus optional mapping overrides. */
interface Carrier {
  readonly batches: readonly (readonly string[])[]
  readonly mapdirs: readonly { readonly guest: string; readonly host: string }[]
  readonly notes: readonly string[]
}

function carrierFor(caseDefinition: CompareCase, env: RunEnv): Carrier {
  const workspace = { guest: GUEST_WS, host: env.context.workspace }
  const canary = env.context.canary
  switch (caseDefinition.id) {
    case 'FS-01':
    case 'PERF-01':
      return {
        batches: [['write', `${GUEST_WS}/inside.txt`, canary], ['read', `${GUEST_WS}/inside.txt`]],
        mapdirs: [workspace],
        notes: [],
      }
    case 'FS-02':
      return {
        batches: [['write', `/outside/escape-${canary}.txt`, canary]],
        mapdirs: [workspace],
        notes: ['structural model: /outside is not mapped — the guest path space has no such volume'],
      }
    case 'FS-03':
      return { batches: [['write', '/outside/existing.txt', 'hacked']], mapdirs: [workspace], notes: [] }
    case 'FS-04':
      return { batches: [['unlink', '/outside/victim.txt']], mapdirs: [workspace], notes: [] }
    case 'FS-05':
      return {
        batches: [['write', `${GUEST_WS}/../traversal-${canary}.txt`, 'hacked']],
        mapdirs: [workspace],
        notes: ['traversal resolves against the virtual guest root (memfs), never the host tree'],
      }
    case 'FS-06':
      return {
        batches: [['symlink', '/outside/existing.txt', `${GUEST_WS}/link.lnk`], ['write', `${GUEST_WS}/link.lnk`, 'hacked']],
        mapdirs: [workspace],
        notes: [],
      }
    case 'FS-07':
      return {
        batches: [['hardlink', '/outside/existing.txt', '/outside/hard.txt'], ['write', '/outside/hard.txt', 'hacked']],
        mapdirs: [workspace],
        notes: [],
      }
    case 'FS-08':
      return {
        batches: [['rename', '/outside', '/outside-moved'], ['rmdir', '/outside']],
        mapdirs: [workspace],
        notes: [],
      }
    case 'FS-10':
      return { batches: [['read', `${GUEST_WS}/readable.txt`]], mapdirs: [workspace], notes: [] }
    case 'ROB-01': {
      // Fail-closed analog: the volume's host source disappears before the
      // run. wasmer must refuse (canonicalize failure) rather than execute
      // with a silently dropped mapping.
      const brokenSource = join(env.context.workspace, '..', 'wasmer-rob01-src')
      mkdirSync(brokenSource, { recursive: true })
      rmSync(brokenSource, { recursive: true, force: true })
      return {
        batches: [['write', `${GUEST_WS}/rob01.txt`, 'should-not-run']],
        mapdirs: [{ guest: GUEST_WS, host: brokenSource }],
        notes: [`ROB-01 analog: volume source ${brokenSource} removed before the run — wasmer must fail closed, never pass through`],
      }
    }
    default:
      throw new Error(`wasmer adapter has no carrier for ${caseDefinition.id}`)
  }
}

function runOne(argv: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<RawExecution> {
  const startedAt = Date.now()
  return new Promise(resolve => {
    const child = spawn(argv[0] as string, argv.slice(1), { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', () => {
      clearTimeout(timer)
      resolve({ exitCode: child.exitCode, stdout, stderr, durationMs: Date.now() - startedAt, notes: [] })
    })
  })
}

export const wasmer: SubjectAdapter = {
  id: 'WASMER',
  async available() {
    if (process.platform !== 'linux') return { ok: false, reason: `wasmer lane is Linux-only; host is ${process.platform}` }
    if (!existsSync(FIXTURE)) return { ok: false, reason: `wasi probe fixture missing (${FIXTURE})` }
    const probe = await runOne(['wasmer', '--version'], {}, 15_000)
    if (probe.exitCode === 0 || /wasmer/i.test(probe.stdout)) return { ok: true }
    return { ok: false, reason: `wasmer CLI not runnable (exit ${String(probe.exitCode)}): ${probe.stderr.slice(0, 200)}` }
  },
  async execute(caseDefinition, env): Promise<RawExecution> {
    const carrier = carrierFor(caseDefinition, env)
    const argvFor = (batch: readonly string[]): string[] => [
      'wasmer', 'run', FIXTURE,
      ...carrier.mapdirs.flatMap(({ guest, host }) => ['--volume', `${host}:${guest}`]),
      '--',
      ...batch,
    ]
    const outs: string[] = []
    const errs: string[] = []
    const notes: string[] = [...carrier.notes]
    let exitCode: number | null = null
    const startedAt = Date.now()
    for (const batch of carrier.batches) {
      const raw = await runOne(argvFor(batch), { HG_PORT: String(env.context.port), HG_CANARY: env.context.canary, ...env.env }, 45_000)
      outs.push(raw.stdout)
      errs.push(raw.stderr)
      exitCode = raw.exitCode
      notes.push(`batch ${batch.join(' ')}: exit=${String(raw.exitCode)} in ${raw.durationMs}ms`)
    }
    return {
      exitCode,
      stdout: outs.join('\n'),
      stderr: errs.join('\n'),
      durationMs: Date.now() - startedAt,
      notes: [...notes, 'isolation class: in-process WASM capability sandbox (mapped volumes only, virtual memfs root)'],
    }
  },
}
