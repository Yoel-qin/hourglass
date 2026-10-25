// Paired-difference gate: decides whether an observed improvement clears
// the lower bound of its confidence interval. Minimal extraction of the
// real gate (same formulas, same contract).

/**
 * Two-sided normal quantile derived from the LOCKED confidence level.
 * Inverse-normal CDF via the Acklam approximation (about 9 significant
 * digits) — no runtime dependency, pure and replayable. A two-sided level
 * maps p = 1-(1-c)/2 into (0.5, 1), so only the central and upper-tail
 * branches are reachable; the lower-tail branch of the general
 * approximation is unreachable by construction and omitted.
 */
export function zForConfidence(confidence) {
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new Error(`ciConfidence must be in (0,1), got ${String(confidence)}`)
  }
  const p = 1 - (1 - confidence) / 2
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const pHigh = 1 - 0.02425
  if (p <= pHigh) {
    const q = p - 0.5
    const r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  }
  const q = Math.sqrt(-2 * Math.log(1 - p))
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
}

export function ciLowerBoundPct(differences, confidence) {
  const n = differences.length
  if (n === 0) throw new Error('differences must be non-empty')
  const mean = differences.reduce((sum, value) => sum + value, 0) / n
  const variance = differences.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n
  const standardError = Math.sqrt(variance / n)
  const z = zForConfidence(confidence)
  return (mean - z * standardError) * 100
}
