// Hidden judge for task stdin-epipe-contained. Real regression assertion
// carried over from the original fix: a driver that destroys its read end
// and stays alive while an oversized payload keeps being written must yield
// a resolved (failed, watchdog-timed-out) trial — not an uncaught EPIPE
// that crashes the runner process. The workspace module is exercised in a
// FRESH subprocess so a crash is observed, not suffered.
// Protocol: node judge.mjs <workspaceDir>.
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

const scratch = mkdtempSync(join(tmpdir(), 'judge-epipe-'))
try {
  // Same driver shape as the real regression test: destroy the read end
  // and STAY alive — the oversized payload keeps writing after the reader
  // is gone, which is what actually produces the EPIPE.
  const driver = join(scratch, 'epipe-driver.mjs')
  writeFileSync(driver, 'process.stdin.destroy(); setInterval(() => {}, 1000)\n', 'utf8')
  const harness = join(scratch, 'harness.mjs')
  writeFileSync(harness, [
    `import { runTrial } from ${JSON.stringify(pathToFileURL(join(workspace, 'trial-run.mjs')).href)}`,
    'const response = await runTrial({ driverPath: process.argv[2], payload: "x".repeat(200_000), timeoutMs: 4_000 })',
    'console.log("HARNESS-OUT:" + JSON.stringify({ ok: response.ok, timedOut: response.timedOut, error: response.error ?? null }))',
    'process.exit(0)',
    '',
  ].join('\n'), 'utf8')

  const child = spawn(process.execPath, ['--no-warnings', harness, driver], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', chunk => { out += chunk })
  child.stderr.on('data', chunk => { err += chunk })
  const exit = await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('judge-timeout') }, 20_000)
    child.on('close', code => { clearTimeout(timer); resolve(`exit:${String(code)}`) })
  })

  const crash = exit !== 'exit:0'
  record('runner-survives-stdin-epipe', !crash,
    crash ? `harness ${exit}: ${err.slice(0, 400)}` : 'harness exited cleanly')
  if (!crash) {
    const line = out.split('\n').find(l => l.startsWith('HARNESS-OUT:'))
    if (line === undefined) {
      record('trial-resolved-with-watchdog-timeout', false, `no HARNESS-OUT line; stdout=${out.slice(0, 200)}`)
    } else {
      const outcome = JSON.parse(line.slice('HARNESS-OUT:'.length))
      record('trial-resolved-with-watchdog-timeout',
        outcome.ok === false && outcome.timedOut === true,
        `ok=${String(outcome.ok)} timedOut=${String(outcome.timedOut)} error=${String(outcome.error)}`)
    }
  }
} catch (error) {
  record('judge-ran', false, String(error?.stack ?? error))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

const ok = checks.length > 0 && checks.every(check => check.ok)
console.log(`JUDGE-RESULT: ${JSON.stringify({ ok, checks })}`)
process.exit(ok ? 0 : 1)
