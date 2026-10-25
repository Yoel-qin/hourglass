// Candidate-skill shim for the agent-lane child: registers the
// content-addressed candidate snapshot into ctx.skills DIRECTLY. The child's
// skill-filesystem override (includeDefaultRoots: false, no custom roots)
// yields nothing, so this runtime registration is the child's ONLY skill —
// the P4 evidence: candidate content reaches the model through the snapshot
// and nothing else. Registration beats filesystem providers on priority.
import type { Context } from '@deepseek-ai/cordis'
import { appendFileSync, readFileSync, readdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'candidate-skill'
export const inject = ['skills']

interface ParsedFrontmatter {
  readonly name: string
  readonly description: string
  readonly body: string
}

function parseSkillFile(text: string): ParsedFrontmatter | undefined {
  // CR-tolerant: candidate skill files may be checked out with CRLF on
  // Windows authoring machines (*.md is outside the LF gitattributes set).
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (match === null) return undefined
  const name = /^name:\s*(.+?)\s*$/m.exec(match[1])?.[1]
  const description = /^description:\s*(.+?)\s*$/m.exec(match[1])?.[1]
  if (name === undefined || name === '' || description === undefined) return undefined
  return { name, description, body: match[2].replace(/\r\n/g, '\n') }
}

export function apply(ctx: Context): void {
  const sink = process.env.CARRIER_SKILL_DUMP
  const snapshot = process.env.CARRIER_CANDIDATE_SKILL
  const note = (text: string): void => {
    if (sink !== undefined && sink !== '') {
      try {
        appendFileSync(sink, text + '\n')
      } catch { /* best-effort lens */ }
    }
  }
  if (snapshot === undefined || snapshot === '') {
    note('== candidate-skill: CARRIER_CANDIDATE_SKILL is not set ==')
    return
  }
  try {
    const parsed = parseSkillFile(readFileSync(snapshot, 'utf8'))
    if (parsed === undefined) {
      note('== candidate-skill: unparsable snapshot at ' + snapshot + ' ==')
      return
    }
    ctx.skills.register({ name: parsed.name, description: parsed.description, content: parsed.body })
    note('== candidate-skill: registered ' + parsed.name + ' from ' + dirname(snapshot) + ' (dir: ' + readdirSync(dirname(snapshot)).join(',') + ') ==')
  } catch (error) {
    note('== candidate-skill ERROR: ' + String(error) + ' ==')
  }
}
