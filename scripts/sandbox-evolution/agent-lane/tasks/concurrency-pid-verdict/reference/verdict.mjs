// The concurrency-phase verdict: two workers ran the same trial side by
// side. Isolation held iff both finished cleanly, both markers carry the
// expected texts, AND the workers were actually distinct processes — the
// same pid for both means no true concurrency was observed.
export function concurrencyVerdict(run) {
  const distinctPids = run.pidA !== run.pidB
  const ok = run.aOk && run.bOk
    && run.markerA === 'ALPHA-MARKER'
    && run.markerB === 'BETA-MARKER'
    && distinctPids
  return {
    phase: 'concurrency',
    ok,
    detail: {
      aOk: run.aOk, bOk: run.bOk,
      markerA: run.markerA, markerB: run.markerB,
      distinctPids,
    },
  }
}
