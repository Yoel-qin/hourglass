/**
 * Build an evidence-backed capability manifest from a compare run: each
 * capability's status is derived from the subject's actual case results
 * (test-result evidence), never from intentions. Usage:
 *   node --experimental-strip-types manifest-from-compare.ts <compare.json> DSH-PLUGIN
 */

import { readFileSync, writeFileSync } from 'node:fs'
// Relative import: this script is copied into the DSH workspace at
// packages/hourglass/, next to the capabilities package.
import { buildManifest } from './capabilities/src/index.ts'
import type { CapabilityStatus } from './capabilities/src/types.ts'

/** Minimal shapes of a compare report (kept local so the script stands alone). */
interface CompareResult { readonly subject: string; readonly caseId: string; readonly status: string }
interface RunReport { readonly runId: string; readonly smokeFile: string; readonly startedAt: string; readonly results: readonly CompareResult[] }

const [, , reportPath, subject] = process.argv as [string, string, string, string]
if (reportPath === undefined || subject === undefined) {
  console.error('usage: manifest-from-compare.ts <compare.json> <subject>')
  process.exit(1)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8')) as RunReport
const results = report.results.filter(result => result.subject === subject)

const statusFrom = (caseIds: readonly string[]): CapabilityStatus => {
  const relevant = results.filter(result => caseIds.includes(result.caseId))
  if (relevant.length === 0) return 'unknown'
  if (relevant.every(result => result.status === 'pass')) return 'enforced'
  if (relevant.some(result => result.status === 'pass')) return 'partial'
  if (relevant.every(result => result.status === 'fail')) return 'absent'
  return 'unknown'
}

const manifest = buildManifest({
  platform: 'linux',
  backend: subject === 'DSH-BASE' ? 'bwrap' : 'bwrap',
  probes: [{ backend: 'bwrap', available: true, detail: `derived from ${report.runId} (${report.smokeFile})`, checkedAt: report.startedAt }],
  tested: {
    fileWrite: { status: statusFrom(['FS-02', 'FS-03', 'FS-04', 'FS-05', 'FS-06']), evidenceRef: `${report.runId}: FS-02..06` },
    fileRead: { status: statusFrom(['FS-11', 'FS-12']), evidenceRef: `${report.runId}: FS-11/12` },
    netEgress: { status: statusFrom(['NET-02', 'NET-03', 'NET-05', 'NET-06', 'NET-10']), evidenceRef: `${report.runId}: NET deny matrix` },
    resourceLimits: { status: statusFrom(['RES-03', 'RES-06']), evidenceRef: `${report.runId}: RES-03/06 (RES-04 nproc exempted by userns CAP_SYS_ADMIN)` },
    processControl: { status: 'absent', evidenceRef: 'RES-04: RLIMIT_NPROC is kernel-exempted under userns CAP_SYS_ADMIN; cgroup pids is the future hard path' },
  },
})

const out = `${reportPath.replace(/compare\.json$/, '')}capability-manifest-${subject}.json`
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`wrote ${out}`)
for (const [key, entry] of Object.entries(manifest.capabilities)) {
  console.log(`${key.padEnd(16)} ${entry.status.padEnd(8)} [${entry.evidence}]`)
}
