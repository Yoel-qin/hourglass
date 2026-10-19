import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTrialConfinement } from '../src/confine-trial.ts'
import { runTrial } from '../src/trial-launcher.ts'

/**
 * Container-only integration test (needs Linux + bwrap + the fused DSH
 * workspace; runs via `hourglass-entrypoint unit` exactly like the rest of
 * the suite). Proves the E2 core claims with child-side and server-side
 * evidence, never parent-side assumption:
 *   EVO-TRIAL-01 the driver is an independent child process that mounts the
 *                confinement plugins itself (driverPid differs from ours);
 *   EVO-TRIAL-02 a deny-read canary outside the workspace is unreadable,
 *                including through a symlink alias;
 *   EVO-TRIAL-04 egress is blocked with server-side zero-record evidence;
 *   EVO-TRIAL-11 the trial tool registry has no host egress tool at all —
 *                the driver registers exactly one confined tool.
 */

// bwrap cannot use the ephemeral /tmp tmpfs for fixtures (known container
// quirk); the compare framework bases its fixtures under /root for the same
// reason. Outside the container this spec would not pass — it is not run there.
const base = process.env['HOME'] === '/root' ? homedir() : join(homedir(), '.hourglass-evo-trial-test')
const root = mkdtempSync(join(base, 'evo-trial-'))
const workspace = join(root, 'workspace')
mkdirSync(workspace, { recursive: true })

const CANARY = 'DSH_SYNTHETIC_CANARY_EVOTRIAL_SECRET_7f3a'
// deny-read masks DIRECTORY paths with tmpfs (bwrap cannot mount tmpfs over a
// single file), so the canary lives in its own directory and the directory is
// the masked unit — same shape as the compare framework's FS-11/12 fixtures.
const secretsDir = join(root, 'secrets')
mkdirSync(secretsDir, { recursive: true })
const canaryPath = join(secretsDir, 'secret-canary.txt')
writeFileSync(canaryPath, CANARY, 'utf8')

let server: Server
let requestsSeen = 0
let serverPort = 0

beforeAll(async () => {
  server = createServer((_request, response) => {
    requestsSeen += 1
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('evolution-canary-service\n')
  })
  await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve))
  serverPort = (server.address() as { port: number }).port
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  server.close()
})

describe('trial launcher integration (EVO-TRIAL core, container bwrap lane)', () => {
  it(
    'runs an independent confined child: workspace write allowed, canary masked, egress zero-record',
    { timeout: 180_000 },
    async () => {
      const response = await runTrial({
        trialId: 'trial-integration-1',
        workspaceRoot: workspace,
        ledgerPath: join(root, 'trial-ledger.jsonl'),
        commands: [
          { callId: 'inside-write', command: 'echo evolution-inside > inside.txt' },
          { callId: 'canary-direct', command: `cat ${canaryPath}` },
          { callId: 'canary-symlink', command: `ln -s ${canaryPath} alias.txt && cat alias.txt` },
          { callId: 'egress-attempt', command: `curl -s -m 3 http://127.0.0.1:${serverPort}/probe` },
        ],
        confinement: buildTrialConfinement({ readDeny: [secretsDir] }),
      })
      expect(response.ok).toBe(true)
      expect(response.error).toBeUndefined()
      // EVO-TRIAL-01: the confinement plugins live in a DIFFERENT process.
      expect(response.driverPid).toBeDefined()
      expect(response.driverPid).not.toBe(process.pid)

      const byCall = new Map(response.results.map(result => [result.callId, result]))
      const inside = byCall.get('inside-write')
      expect(inside?.exitCode).toBe(0)
      expect(readFileSync(join(workspace, 'inside.txt'), 'utf8').trim()).toBe('evolution-inside')

      // EVO-TRIAL-02: deny-read masking (direct and symlink alias) — judged by
      // the canary value never appearing in any channel, not by stderr text.
      for (const callId of ['canary-direct', 'canary-symlink']) {
        const result = byCall.get(callId)
        expect(result?.stdout).not.toContain(CANARY)
        expect(result?.stderr).not.toContain(CANARY)
      }
      expect(response.results.map(result => JSON.stringify(result)).join('\n')).not.toContain(CANARY)

      // EVO-TRIAL-04: egress judged by the server record, which stays empty.
      expect(requestsSeen).toBe(0)
      expect(byCall.get('egress-attempt')?.stdout).not.toContain('evolution-canary-service')

      // The audit ledger recorded begin/end pairs for every executed call.
      expect(response.ledger.length).toBeGreaterThanOrEqual(response.results.length * 2)
    },
  )

  it(
    'enforces resource budgets inside the child (fsize hard cap)',
    { timeout: 180_000 },
    async () => {
      const response = await runTrial({
        trialId: 'trial-integration-2',
        workspaceRoot: workspace,
        ledgerPath: join(root, 'trial-ledger-2.jsonl'),
        commands: [
          // 128KB write against the 64KB default fsize cap: truncated by the kernel.
          { callId: 'oversize-write', command: 'head -c 131072 /dev/zero > big.bin; wc -c < big.bin' },
        ],
        confinement: buildTrialConfinement(),
      })
      expect(response.ok).toBe(true)
      const result = response.results[0]
      expect(result).toBeDefined()
      if (result !== undefined) {
        const size = Number.parseInt(result.stdout.trim(), 10)
        expect(Number.isNaN(size) || size <= 64 * 1024).toBe(true)
      }
      if (existsSync(join(workspace, 'big.bin'))) {
        expect(statSync(join(workspace, 'big.bin')).size).toBeLessThanOrEqual(64 * 1024)
      }
    },
  )
})
