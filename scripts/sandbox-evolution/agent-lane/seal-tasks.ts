/**
 * Seal (or re-seal) the agent-lane task set: regenerate tasks/manifest.json
 * (content addresses for every task file) and agent-lane.lock.json (the
 * freeze over the manifest plus every file). Manual tooling for adding or
 * revising tasks — CI and the selftest only VERIFY, never regenerate.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizedSha256 } from './tasks.ts'

const BASE_DIR = dirname(fileURLToPath(import.meta.url))
const TASKS_DIR = join(BASE_DIR, 'tasks')
const LOCK_PATH = join(BASE_DIR, '..', 'agent-lane.lock.json')

function listTaskFiles(taskDir: string): string[] {
  const files: string[] = []
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(taskDir, relative), { withFileTypes: true })) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else files.push(child)
    }
  }
  walk('')
  return files.sort()
}

function main(): void {
  const taskDirs = readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== 'node_modules')
    .map(entry => {
      // A task directory without a parseable task.json must ABORT the seal,
      // not be silently dropped from the benchmark (PR #17 review).
      try {
        JSON.parse(readFileSync(join(TASKS_DIR, entry.name, 'task.json'), 'utf8')) as unknown
      } catch (error) {
        throw new Error(`task directory without a parseable task.json: ${entry.name}: ${String(error)}`)
      }
      return entry.name
    })
    .sort()
  if (taskDirs.length === 0) throw new Error('no task directories with a parseable task.json found')

  const manifestTasks: Array<{ id: string; category: string; files: Record<string, string> }> = []
  const lockFiles: Record<string, string> = {}
  const hashFile = (path: string): string => normalizedSha256(readFileSync(path, 'utf8'))

  for (const id of taskDirs) {
    const taskDir = join(TASKS_DIR, id)
    const files: Record<string, string> = {}
    for (const relative of listTaskFiles(taskDir)) {
      files[relative] = hashFile(join(taskDir, relative))
      lockFiles[`agent-lane/tasks/${id}/${relative}`] = files[relative]!
    }
    const task = JSON.parse(readFileSync(join(taskDir, 'task.json'), 'utf8')) as { id?: string; category?: string }
    if (task.id !== id) throw new Error(`task.json id mismatch: dir=${id} id=${String(task.id)}`)
    if (typeof task.category !== 'string' || task.category === '') throw new Error(`task.json category malformed: ${id}`)
    manifestTasks.push({ id, category: task.category, files })
  }

  const manifest = {
    schema: 'hourglass-agent-benchmark/1',
    lockedAt: new Date().toISOString(),
    lockReason: 'ADR-004 D1-2 real task set: every task freezes a real hourglass development-history defect (fixture = defect site, reference = the real fix, judge = the real regression assertions). Content-addressed with LF-normalized sha256; frozen by agent-lane.lock.json.',
    tasks: manifestTasks,
  }
  const manifestPath = join(TASKS_DIR, 'manifest.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  lockFiles['agent-lane/tasks/manifest.json'] = hashFile(manifestPath)
  const lock = {
    schema: 'hourglass-agent-lane-lock/1',
    lockedAt: new Date().toISOString(),
    lockReason: 'Freezes the agent-lane real-task benchmark (manifest + every task file) with the same LF-normalized sha256 discipline as evolution.lock.json. evolution.lock.json itself stays untouched so published shell-lane reports keep verifying.',
    files: Object.fromEntries(Object.entries(lockFiles).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  }
  writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')

  console.log(`[agent-tasks-seal] sealed ${String(manifestTasks.length)} tasks, ${String(Object.keys(lockFiles).length)} locked files`)
  console.log(`[agent-tasks-seal] manifest sha256=${lockFiles['agent-lane/tasks/manifest.json']}`)
  console.log(`[agent-tasks-seal] lock sha256=${hashFile(LOCK_PATH)}`)
}

main()
