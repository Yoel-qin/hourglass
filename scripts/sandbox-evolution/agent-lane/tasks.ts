/**
 * Agent-lane real-task set (ADR-004 D1-2). Every task freezes a REAL defect
 * from hourglass's own development history:
 *   fixture/   — minimal extraction of the defect site (what the child sees)
 *   reference/ — the real fix, in minimal form (selftest discrimination only)
 *   judge/     — the real regression assertions, packaged as a standalone
 *                script the runner executes against the child's workspace
 *   task.json  — id, sanitized prompt, allowed files, origin commit
 *
 * tasks/manifest.json content-addresses every task file (per-file sha256,
 * LF-normalized — the same discipline as evolution.lock.json), and
 * agent-lane.lock.json (next to evolution.lock.json) freezes the manifest
 * plus every file. The shell lane's lock stays byte-identical so already-
 * published v2 reports keep verifying.
 *
 * Runner contract: ONLY fixture/ (plus the task prompt) ever enters the
 * child's workspace. judge/ and reference/ are judgment-side private — the
 * child must never see the hidden verdict or the answer.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export interface AgentTask {
  readonly id: string
  readonly category: string
  readonly title: string
  readonly prompt: string
  readonly allowedFiles: readonly string[]
  readonly dir: string
  readonly fixtureDir: string
  readonly referenceDir: string
  readonly judgePath: string
}

export interface AgentTaskManifestEntry {
  readonly id: string
  readonly category: string
  readonly files: Readonly<Record<string, string>>
}

export interface AgentTaskManifest {
  readonly schema: string
  readonly tasks: readonly AgentTaskManifestEntry[]
}

export interface LoadedAgentTasks {
  readonly tasks: readonly AgentTask[]
  readonly manifestSha256: string
  readonly verifiedFileCount: number
}

export interface JudgeCheck {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

export interface JudgeOutcome {
  readonly ok: boolean
  readonly checks: readonly JudgeCheck[]
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly stdoutTail: string
  readonly stderrTail: string
  readonly error?: string
}

/** LF-normalized sha256 — digests must not depend on checkout platform. */
export function normalizedSha256(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

/**
 * Every file under dir as POSIX-style relative paths (the manifest's key
 * format). Used for set equality: a file PRESENT on disk but ABSENT from
 * the manifest/lock must abort the lane — otherwise an unlisted fixture
 * file would reach the child outside the content-addressed freeze
 * (PR #17 review finding).
 */
function walkFiles(dir: string): string[] {
  const files: string[] = []
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else files.push(child)
    }
  }
  walk('')
  return files.sort()
}

function assertTaskJsonShape(parsed: unknown, dir: string): asserts parsed is {
  id: string; category: string; title: string; prompt: string; allowedFiles: string[]
} {
  if (parsed === null || typeof parsed !== 'object') throw new Error(`task-json-not-object:${dir}`)
  const record = parsed as Record<string, unknown>
  for (const field of ['id', 'category', 'title', 'prompt'] as const) {
    if (typeof record[field] !== 'string' || (record[field] as string) === '') {
      throw new Error(`task-json-field-malformed:${dir}:${field}`)
    }
  }
  if (!Array.isArray(record['allowedFiles']) || (record['allowedFiles'] as unknown[]).length === 0
    || !(record['allowedFiles'] as unknown[]).every(entry => typeof entry === 'string')) {
    throw new Error(`task-json-field-malformed:${dir}:allowedFiles`)
  }
}

/**
 * Load the task set from tasksDir, verifying EVERY manifest entry's
 * content address first (fail closed — a drifted task set must abort the
 * lane, never run half-verified).
 */
export function loadAgentTasks(tasksDir: string): LoadedAgentTasks {
  const manifestPath = join(tasksDir, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error('agent-task-manifest-missing')
  const manifestRaw = readFileSync(manifestPath, 'utf8')
  const manifestSha256 = normalizedSha256(manifestRaw)
  let manifest: AgentTaskManifest
  try {
    manifest = JSON.parse(manifestRaw) as AgentTaskManifest
  } catch {
    throw new Error('agent-task-manifest-unparseable')
  }
  if (manifest.schema !== 'hourglass-agent-benchmark/1') throw new Error(`agent-task-manifest-schema:${String(manifest.schema)}`)
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0) throw new Error('agent-task-manifest-empty')

  const tasks: AgentTask[] = []
  let verifiedFileCount = 0
  for (const entry of manifest.tasks) {
    const dir = join(tasksDir, entry.id)
    if (!existsSync(dir)) throw new Error(`agent-task-dir-missing:${entry.id}`)
    for (const [relative, expected] of Object.entries(entry.files)) {
      const target = join(dir, relative)
      if (!existsSync(target)) throw new Error(`agent-task-file-missing:${entry.id}:${relative}`)
      const actual = normalizedSha256(readFileSync(target, 'utf8'))
      if (actual !== expected) throw new Error(`agent-task-hash-mismatch:${entry.id}:${relative}`)
      verifiedFileCount += 1
    }
    // Set equality with the freeze: additions to a task directory are as
    // much drift as mutations (materializeTaskWorkspace copies the whole
    // fixture tree, so an unlisted file would reach the child unhashed).
    const unlisted = walkFiles(dir).filter(relative => entry.files[relative] === undefined)
    if (unlisted.length > 0) throw new Error(`agent-task-unlisted-file:${entry.id}:${unlisted.join(',')}`)
    const taskJsonPath = join(dir, 'task.json')
    if (entry.files['task.json'] === undefined || entry.files['judge/judge.mjs'] === undefined) {
      throw new Error(`agent-task-missing-core-files:${entry.id}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(taskJsonPath, 'utf8'))
    } catch {
      throw new Error(`agent-task-json-unparseable:${entry.id}`)
    }
    assertTaskJsonShape(parsed, entry.id)
    if (parsed.id !== entry.id) throw new Error(`agent-task-id-mismatch:${entry.id}:${parsed.id}`)
    if (parsed.category !== entry.category) throw new Error(`agent-task-category-mismatch:${entry.id}`)
    tasks.push({
      id: parsed.id,
      category: parsed.category,
      title: parsed.title,
      prompt: parsed.prompt,
      allowedFiles: parsed.allowedFiles,
      dir,
      fixtureDir: join(dir, 'fixture'),
      referenceDir: join(dir, 'reference'),
      judgePath: join(dir, 'judge', 'judge.mjs'),
    })
  }
  return { tasks, manifestSha256, verifiedFileCount }
}

/** Verify agent-lane.lock.json (files map, LF-normalized sha256 each). */
export function verifyAgentLaneLock(lockPath: string): { ok: boolean; errors: readonly string[]; lockSha256: string } {
  if (!existsSync(lockPath)) return { ok: false, errors: ['agent-lane-lock-missing'], lockSha256: '' }
  const raw = readFileSync(lockPath, 'utf8')
  const lockSha256 = normalizedSha256(raw)
  let parsed: { schema?: string; files?: Record<string, string> }
  try {
    parsed = JSON.parse(raw) as { schema?: string; files?: Record<string, string> }
  } catch {
    return { ok: false, errors: ['agent-lane-lock-unparseable'], lockSha256 }
  }
  if (parsed.schema !== 'hourglass-agent-lane-lock/1') return { ok: false, errors: [`agent-lane-lock-schema:${String(parsed.schema)}`], lockSha256 }
  if (parsed.files === undefined || Object.keys(parsed.files).length === 0) {
    return { ok: false, errors: ['agent-lane-lock-files-empty'], lockSha256 }
  }
  const errors: string[] = []
  const baseDir = join(lockPath, '..')
  for (const [relative, expected] of Object.entries(parsed.files)) {
    const target = join(baseDir, relative)
    if (!existsSync(target)) {
      errors.push(`agent-lane-locked-file-missing:${relative}`)
      continue
    }
    if (normalizedSha256(readFileSync(target, 'utf8')) !== expected) {
      errors.push(`agent-lane-locked-hash-mismatch:${relative}`)
    }
  }
  // Set equality again: every file under agent-lane/tasks/ must be locked,
  // so nothing can be added to the task set outside the freeze.
  for (const onDisk of walkFiles(join(baseDir, 'agent-lane', 'tasks'))) {
    if (parsed.files[`agent-lane/tasks/${onDisk}`] === undefined) {
      errors.push(`agent-lane-unlocked-file:${onDisk}`)
    }
  }
  return { ok: errors.length === 0, errors, lockSha256 }
}

/** Materialize a task's fixture (or reference) tree into a fresh workspace. */
export function materializeTaskWorkspace(sourceDir: string, workspaceDir: string): void {
  if (!existsSync(sourceDir)) throw new Error(`task-source-missing:${sourceDir}`)
  mkdirSync(workspaceDir, { recursive: true })
  cpSync(sourceDir, workspaceDir, { recursive: true })
}

function tail(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(text.length - max)}…` : text
}

/**
 * Run one hidden judge against a materialized workspace. Judges print a
 * final `JUDGE-RESULT: {json}` line and mirror ok in their exit code; the
 * runner trusts NEITHER alone — ok is the parsed verdict, and a missing,
 * unparsable, or timeout-killed verdict is a fail with its reason.
 */
export function runJudge(judgePath: string, workspaceDir: string, timeoutMs = 90_000): Promise<JudgeOutcome> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [judgePath, workspaceDir], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ ok: false, checks: [], exitCode: null, timedOut, stdoutTail: tail(stdout), stderrTail: tail(stderr), error: `spawn-failed:${error.message}` })
    })
    child.on('close', code => {
      clearTimeout(timer)
      const line = stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('JUDGE-RESULT:')).pop()
      if (line === undefined) {
        resolve({ ok: false, checks: [], exitCode: code, timedOut, stdoutTail: tail(stdout), stderrTail: tail(stderr), error: timedOut ? 'judge-timed-out' : 'judge-result-line-missing' })
        return
      }
      try {
        const parsed = JSON.parse(line.slice('JUDGE-RESULT:'.length)) as { ok?: unknown; checks?: unknown }
        const checks = Array.isArray(parsed.checks)
          ? (parsed.checks as Array<Record<string, unknown>>).map(check => ({
            name: String(check['name'] ?? 'unnamed'),
            ok: check['ok'] === true,
            detail: String(check['detail'] ?? ''),
          }))
          : []
        resolve({ ok: parsed.ok === true && code === 0, checks, exitCode: code, timedOut, stdoutTail: tail(stdout), stderrTail: tail(stderr) })
      } catch (error) {
        resolve({ ok: false, checks: [], exitCode: code, timedOut, stdoutTail: tail(stdout), stderrTail: tail(stderr), error: `judge-result-unparseable:${String(error)}` })
      }
    })
  })
}

/** Fresh scratch workspace for one judge invocation; caller removes it. */
export function makeScratchWorkspace(parent: string, label: string): string {
  const dir = join(parent, label)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}
