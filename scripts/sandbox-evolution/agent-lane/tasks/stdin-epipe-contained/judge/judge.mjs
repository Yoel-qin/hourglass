// Hidden judge for task stdin-epipe-contained. Real regression assertions
// carried over from the original fix, plus the positive path that pins the
// contract's non-degenerate side:
//   epipe   — a driver that destroys its read end and stays alive while an
//             oversized payload keeps being written must yield a RESOLVED
//             (failed, watchdog-timed-out) trial, never an uncaught EPIPE
//             that crashes the runner process;
//   healthy — a driver that drains stdin, reports the drained length and
//             exits 0 must yield ok:true / timedOut:false with its stdout
//             captured (a runTrial stub that resolves without spawning
//             cannot satisfy this).
// The workspace module is exercised in FRESH subprocesses so a crash is
// observed, not suffered. Protocol: node judge.mjs <workspaceDir>.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const workspace = process.argv[2]
const checks = []

function record(name, ok, detail) {
  checks.push({ name, ok, detail })
}

function runHarness(harness, driver, payloadLength, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--no-warnings', harness, driver, String(payloadLength), String(timeoutMs)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ kind: 'judge-timeout', out, err }) }, 25_000)
    child.on('close', code => {
      clearTimeout(timer)
      const line = out.split('\n').find(l => l.startsWith('HARNESS-OUT:'))
      resolve({ kind: 'exited', code, line, out, err })
    })
  })
}

const scratch = mkdtempSync(join(tmpdir(), 'judge-epipe-'))
try {
  // Same driver shape as the real regression test: destroy the read end
  // and STAY alive — the oversized payload keeps writing after the reader
  // is gone, which is what actually produces the EPIPE.
  writeFileSync(join(scratch, 'epipe-driver.mjs'),
    'process.stdin.destroy(); setInterval(() => {}, 1000)\n', 'utf8')
  writeFileSync(join(scratch, 'healthy-driver.mjs'), [
    'let data = ""',
    'process.stdin.setEncoding("utf8")',
    'process.stdin.on("data", chunk => { data += chunk })',
    'process.stdin.on("end", () => { console.log(`DRAINED:${String(data.length)}`); process.exit(0) })',
    '',
  ].join('\n'), 'utf8')
  const harness = join(scratch, 'harness.mjs')
  writeFileSync(harness, [
    `import { runTrial } from ${JSON.stringify(pathToFileURL(join(workspace, 'trial-run.mjs')).href)}`,
    'const response = await runTrial({ driverPath: process.argv[2], payload: "x".repeat(Number(process.argv[3])), timeoutMs: Number(process.argv[4]) })',
    'console.log("HARNESS-OUT:" + JSON.stringify({ ok: response.ok, timedOut: response.timedOut, stdout: String(response.stdout ?? "") }))',
    'process.exit(0)',
    '',
  ].join('\n'), 'utf8')

  const epipe = await runHarness(harness, join(scratch, 'epipe-driver.mjs'), 200_000, 4_000)
  if (epipe.kind === 'judge-timeout' || epipe.code !== 0 || epipe.line === undefined) {
    record('runner-survives-stdin-epipe', false,
      `harness ${epipe.kind === 'judge-timeout' ? 'timed out' : `exit=${String(epipe.code)}`}: ${(epipe.err || epipe.out).slice(0, 400)}`)
  } else {
    record('runner-survives-stdin-epipe', true, 'harness exited cleanly')
    const outcome = JSON.parse(epipe.line.slice('HARNESS-OUT:'.length))
    record('epipe-trial-resolves-with-watchdog-timeout',
      outcome.ok === false && outcome.timedOut === true,
      `ok=${String(outcome.ok)} timedOut=${String(outcome.timedOut)}`)
  }

  const healthy = await runHarness(harness, join(scratch, 'healthy-driver.mjs'), 1_000, 8_000)
  if (healthy.kind === 'judge-timeout' || healthy.code !== 0 || healthy.line === undefined) {
    record('healthy-driver-passes-with-captured-stdout', false,
      `harness ${healthy.kind === 'judge-timeout' ? 'timed out' : `exit=${String(healthy.code)}`}: ${(healthy.err || healthy.out).slice(0, 400)}`)
  } else {
    const outcome = JSON.parse(healthy.line.slice('HARNESS-OUT:'.length))
    record('healthy-driver-passes-with-captured-stdout',
      outcome.ok === true && outcome.timedOut === false && outcome.stdout.includes('DRAINED:1000'),
      `ok=${String(outcome.ok)} timedOut=${String(outcome.timedOut)} stdout=${JSON.stringify(outcome.stdout.slice(0, 120))}`)
  }
} catch (error) {
  record('judge-ran', false, String(error?.stack ?? error))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

const ok = checks.length > 0 && checks.every(check => check.ok)
console.log(`JUDGE-RESULT: ${JSON.stringify({ ok, checks })}`)
process.exit(ok ? 0 : 1)
