/**
 * OpenAI Codex adapter. `codex exec` requires OpenAI authentication; the
 * isolated test environment carries no credentials, so every case is
 * reported as not-run with this reason — an honest absence, never a PASS
 * and never a failure attributed to Codex itself.
 */

import type { CompareCase } from '../schema.ts'
import type { RawExecution, RunEnv, SubjectAdapter } from './types.ts'

const NO_CREDENTIALS = 'codex exec requires OpenAI authentication; the isolated test environment carries no credentials (versions.lock.json constraint)'

export const codex: SubjectAdapter = {
  id: 'CODEX',
  async available() {
    if (process.env.OPENAI_API_KEY !== undefined || process.env.CODEX_API_KEY !== undefined) {
      return { ok: true }
    }
    return { ok: false, reason: NO_CREDENTIALS }
  },
  async execute(_caseDefinition, _env): Promise<RawExecution> {
    throw new Error(NO_CREDENTIALS)
  },
}
