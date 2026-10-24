/**
 * @hourglass/evolution-contract — pure-function contracts for the
 * self-evolution safety sandbox. No runtime dependencies; every export is
 * replayable and golden-testable without a DSH runtime.
 *
 * @module @hourglass/evolution-contract
 */

export {
  ASSET_KINDS,
  CANDIDATE_SCHEMA_VERSION,
  MVP_REQUESTABLE_CAPABILITIES,
  MUTATION_KINDS,
  validateCandidateManifest,
} from './candidate-schema.ts'
export type { ValidationResult } from './candidate-schema.ts'

export {
  TERMINAL_STATES,
  TRANSITIONS,
  canTransition,
  isCandidateState,
  transition,
} from './state-machine.ts'
export type { TransitionResult } from './state-machine.ts'

export {
  BENCHMARK_SCHEMA_VERSION,
  computeManifestSha256,
  validateBenchmarkManifest,
  verifyManifestSha256,
} from './benchmark-manifest.ts'
export type { BenchmarkManifest, ManifestHashResult, ManifestValidationResult } from './benchmark-manifest.ts'

export {
  MVP_A_POLICY,
  computeMetrics,
  evaluate,
  zForConfidence,
} from './evaluator.ts'
export type {
  EvaluationInput,
  EvaluationMetrics,
  EvaluationOutput,
  EvaluatorPolicy,
} from './evaluator.ts'

export {
  buildValidationPack,
  canExportValidationPack,
  decisionDigest,
  verifyValidationPack,
} from './promotion-policy.ts'
export type {
  BuildPackInput,
  DecisionBindings,
  ExportCheckInput,
  ExportCheckResult,
  PackVerifyResult,
  ValidationPack,
} from './promotion-policy.ts'

export { canonicalJson, isSha256, sha256Hex } from './hashes.ts'

export type {
  AssetKind,
  CandidateManifest,
  CandidateState,
  CaseOutcome,
  Decision,
  ExecutionCounts,
  MutationKind,
  RiskTier,
  RunSummary,
  SecurityFinding,
  SecurityFindingKind,
} from './types.ts'
