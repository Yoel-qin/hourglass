// dshBin wrapper for the carrier probe: runs the BUILT dsh CLI (the same
// executable the provider's own launch resolves) with stdin/stdout piped
// through transparently (the JSON-RPC wire) while the child's stderr is BOTH
// inherited (visible in the probe's log) and appended to
// $CARRIER_CHILD_STDERR — the only lens into the child's composition
// warnings and runtime errors, which the provider's safe diagnostics hide.
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const entry = process.env.CARRIER_REAL_DSH_ENTRY ?? '/opt/dsh/apps/cli/lib/bin.js'
const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
})
const sink = process.env.CARRIER_CHILD_STDERR
child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk)
  if (sink !== undefined && sink !== '') {
    try {
      appendFileSync(sink, chunk)
    } catch { /* best-effort lens */ }
  }
})
child.stdout.pipe(process.stdout)
process.stdin.pipe(child.stdin)
child.on('exit', code => process.exit(code ?? 0))
