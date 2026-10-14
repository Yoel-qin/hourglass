/**
 * Regenerate tests/golden/baseline-replay.golden.json from the frozen
 * fixtures. Run inside the container (or any Node with strip-types):
 *   node --experimental-strip-types tests/generate-golden.mjs
 * The golden must be re-reviewed whenever fixtures or the model change.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { replay } from '../src/index.ts'
import { BASELINE_FIXTURES, SYNTHETIC_WORKSPACE } from './fixtures/policy-fixtures.ts'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, 'golden')
mkdirSync(outDir, { recursive: true })
const decisions = replay(BASELINE_FIXTURES, { configuredMode: 'workspace-write', workspaceRoot: SYNTHETIC_WORKSPACE })
const outPath = join(outDir, 'baseline-replay.golden.json')
writeFileSync(outPath, `${JSON.stringify(decisions, null, 2)}\n`)
console.log(`wrote ${decisions.length} decisions to ${outPath}`)
