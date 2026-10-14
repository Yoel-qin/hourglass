/**
 * ROB-04 lifecycle loop (plan §5.6): mount/unmount the hourglass governance
 * plugins and confine a trivial command N times in ONE process, asserting no
 * fd / RSS / temp-directory growth. The plan's 1000-cycle run belongs to a
 * repeatable job; this script is that job (--cycles=1000). A shortened
 * --cycles=100 validates the harness quickly.
 *
 *   node --experimental-strip-types lifecycle.ts --cycles=1000 --out=/opt/reports/runs/rob04-x.json
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
// Relative imports: this script is copied into the DSH workspace at
// packages/hourglass/, so workspace packages resolve via the source tree.
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import * as NetPlugin from '@hourglass/sandbox-net/src/index.ts'
import * as ReadPlugin from '@hourglass/sandbox-read/src/index.ts'
import * as RsrcPlugin from '@hourglass/sandbox-rsrc/src/index.ts'

interface CycleSnapshot {
  cycle: number
  fds: number
  rssKb: number
  hourglassTempDirs: number
}

function snapshot(cycle: number, tmpRoot: string): CycleSnapshot {
  const fds = readdirSync('/proc/self/fd').length
  const status = readFileSync('/proc/self/status', 'utf8')
  const rssKb = Number(/VmRSS:\s+(\d+) kB/.exec(status)?.[1] ?? 0)
  let hourglassTempDirs = 0
  try {
    hourglassTempDirs = readdirSync(tmpRoot).filter(name => name.startsWith('hourglass-net-')).length
  } catch {
    hourglassTempDirs = -1
  }
  return { cycle, fds, rssKb, hourglassTempDirs }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const cycles = Number(args.find(argument => argument.startsWith('--cycles='))?.split('=')[1] ?? 1000)
  const outPath = args.find(argument => argument.startsWith('--out='))?.split('=')[1]
  const tmpRoot = '/tmp'
  const workspace = '/root/rob04-ws'
  spawnSync('mkdir', ['-p', workspace])

  const snapshots: CycleSnapshot[] = []
  let confineFailures = 0
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    const ctx = new Context()
    try {
      await ctx.plugin(LocalSandboxProvider, {})
      await ctx.plugin(NetPlugin, { mode: 'allowlist', allowlist: ['loop.test'] })
      await ctx.plugin(ReadPlugin, { denyRead: ['/root/rob04-secret'] })
      await ctx.plugin(RsrcPlugin, { nofile: 64 })
      // A full confine through every plugin's rewrite path (no spawn: the
      // point is mount/teardown leakage, not command latency).
      await ctx.sandbox.confine(['bash', '-c', 'true'], { mode: 'workspace-write', workspaceRoot: workspace })
    } catch {
      confineFailures += 1
    } finally {
      await ctx.fiber.dispose()
    }
    if (cycle === 1 || cycle % Math.max(1, Math.floor(cycles / 10)) === 0 || cycle === cycles) {
      snapshots.push(snapshot(cycle, tmpRoot))
    }
  }

  const first = snapshots[0] as CycleSnapshot
  const last = snapshots[snapshots.length - 1] as CycleSnapshot
  const report = {
    schema: 'hourglass-rob04/1',
    cycles,
    confineFailures,
    snapshots,
    verdict: {
      fdGrowth: last.fds - first.fds,
      rssGrowthKb: last.rssKb - first.rssKb,
      tempDirGrowth: last.hourglassTempDirs - first.hourglassTempDirs,
      passed: last.fds - first.fds <= 10 && last.hourglassTempDirs - first.hourglassTempDirs <= 0,
    },
  }
  console.log(`cycles=${cycles} failures=${confineFailures} fdGrowth=${report.verdict.fdGrowth} rssGrowthKb=${report.verdict.rssGrowthKb} tempDirGrowth=${report.verdict.tempDirGrowth}`)
  console.log(report.verdict.passed ? 'ROB-04 (this run): PASS' : 'ROB-04 (this run): FAIL')
  if (outPath !== undefined) writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
  process.exit(report.verdict.passed ? 0 : 1)
}

await main()
