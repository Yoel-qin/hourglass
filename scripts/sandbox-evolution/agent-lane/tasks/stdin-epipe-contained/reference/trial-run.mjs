// Confined trial runner, minimal extraction: spawns a driver subprocess,
// hands it the payload on stdin, and resolves exactly once with the trial
// outcome. The watchdog bounds drivers that never exit on their own.
import { spawn } from 'node:child_process'

export function runTrial({ driverPath, payload, timeoutMs = 8_000 }) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [driverPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ ok: false, error: `spawn-failed:${error.message}`, timedOut, stdout })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ ok: code === 0 && !timedOut, timedOut, signal, stdout })
    })
    child.stdin.write(payload)
    child.stdin.end()
    // A driver that exits (or destroys its stdin) before draining the
    // payload emits EPIPE on this pipe; without a listener Node treats it
    // as an uncaught exception and crashes the whole runner process. The
    // close/error handlers already resolve the promise with the real
    // outcome, so this listener only contains the stream error.
    child.stdin.on('error', () => {})
  })
}
