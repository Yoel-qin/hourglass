// Hidden judge for task nightly-env-fail-fast. Real regression assertions
// carried over from the original fix: a nightly drill whose cycle-count env
// is garbage or zero must fail fast with a non-zero exit naming the bad
// variable — never run zero cycles and print a green report. A valid value
// must still run exactly that many cycles.
// Protocol: node judge.mjs <workspaceDir>.
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const workspace = process.argv[2]
const checks = []

function record(name, ok, detail) {
  checks.push({ name, ok, detail })
}

function runWithEnv(value) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(workspace, 'nightly-drill.mjs')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DRILL_CYCLES: value },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
  })
}

function isGreen(result) {
  try {
    const report = JSON.parse(result.out.trim().split('\n').pop() ?? '')
    return report.ok === true
  } catch {
    return false
  }
}

try {
  const garbage = await runWithEnv('abc')
  const garbageFails = garbage.code !== 0 && !isGreen(garbage) && garbage.err.includes('DRILL_CYCLES')
  record('garbage-env-fails-fast', garbageFails,
    `exit=${String(garbage.code)} green=${String(isGreen(garbage))} stderr=${garbage.err.trim().slice(0, 200)}`)

  const zero = await runWithEnv('0')
  const zeroFails = zero.code !== 0 && !isGreen(zero)
  record('zero-cycles-rejected', zeroFails,
    `exit=${String(zero.code)} green=${String(isGreen(zero))} stderr=${zero.err.trim().slice(0, 200)}`)

  const trailing = await runWithEnv('3x')
  const trailingFails = trailing.code !== 0 && !isGreen(trailing)
  record('trailing-garbage-rejected', trailingFails,
    `exit=${String(trailing.code)} green=${String(isGreen(trailing))} stderr=${trailing.err.trim().slice(0, 200)}`)

  const valid = await runWithEnv('3')
  let validRuns = valid.code === 0
  let cycles = null
  try {
    const report = JSON.parse(valid.out.trim().split('\n').pop() ?? '')
    cycles = report.cycles
    validRuns = validRuns && report.ok === true && report.cycles === 3
  } catch {
    validRuns = false
  }
  record('valid-env-runs-requested-cycles', validRuns,
    `exit=${String(valid.code)} cycles=${String(cycles)} stdout=${valid.out.trim().slice(0, 200)}`)
} catch (error) {
  record('judge-ran', false, String(error?.stack ?? error))
}

const ok = checks.length > 0 && checks.every(check => check.ok)
console.log(`JUDGE-RESULT: ${JSON.stringify({ ok, checks })}`)
process.exit(ok ? 0 : 1)
