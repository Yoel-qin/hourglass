// Paired-difference gate: decides whether an observed improvement clears
// the lower bound of its confidence interval. Minimal extraction of the
// real gate (same formulas, same contract).

/** Normal quantile for the two-sided 95% interval (large-sample z). */
const Z_95 = 1.959963984540054

export function ciLowerBoundPct(differences, confidence) {
  const n = differences.length
  if (n === 0) throw new Error('differences must be non-empty')
  const mean = differences.reduce((sum, value) => sum + value, 0) / n
  const variance = differences.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n
  const standardError = Math.sqrt(variance / n)
  return (mean - Z_95 * standardError) * 100
}
