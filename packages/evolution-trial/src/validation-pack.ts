/**
 * Validation-pack export (v3.1 §6.2, the ONLY production promotion path):
 * a hash-bound, human-approved, manually-applied pack. Export refuses
 * anything but a full `pass` with complete bindings (via the contract's
 * promotion policy); the written file is never overwritten.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildValidationPack,
  verifyValidationPack,
} from '@hourglass/evolution-contract/src/index.ts'
import type {
  DecisionBindings,
  ExecutionCounts,
  ValidationPack,
} from '@hourglass/evolution-contract/src/index.ts'
import type { AssetKind, Decision } from '@hourglass/evolution-contract/src/index.ts'

export interface ExportPackInput {
  readonly decision: Decision
  readonly reasonCodes: readonly string[]
  readonly bindings: DecisionBindings
  readonly executionCounts: ExecutionCounts
  readonly assetKind: AssetKind
  readonly applySteps: readonly string[]
  readonly rollbackSteps: readonly string[]
  readonly outDir: string
}

export interface ExportedPack {
  readonly pack: ValidationPack
  readonly packPath: string
}

export function exportValidationPack(input: ExportPackInput): ExportedPack {
  const pack = buildValidationPack({
    decision: input.decision,
    reasonCodes: input.reasonCodes,
    bindings: input.bindings,
    executionCounts: input.executionCounts,
    assetKind: input.assetKind,
    applySteps: input.applySteps,
    rollbackSteps: input.rollbackSteps,
  })
  const packPath = packPathFor(input.outDir, pack.bindings.decisionDigest)
  if (existsSync(packPath)) {
    // Idempotent re-export must be byte-identical; anything else is refused.
    const existing: unknown = JSON.parse(readFileSync(packPath, 'utf8'))
    if (JSON.stringify(existing) !== JSON.stringify(pack)) {
      throw new Error(`pack-path-conflict:${packPath}`)
    }
  } else {
    writeFileSync(packPath, `${JSON.stringify(pack, null, 2)}\n`, { flag: 'wx' })
  }
  return { pack, packPath }
}

export function packPathFor(outDir: string, decisionDigest: string): string {
  return join(outDir, `pack-${decisionDigest.slice(0, 16)}.json`)
}

export function loadPack(packPath: string): ValidationPack {
  return JSON.parse(readFileSync(packPath, 'utf8')) as ValidationPack
}

export { verifyValidationPack }
