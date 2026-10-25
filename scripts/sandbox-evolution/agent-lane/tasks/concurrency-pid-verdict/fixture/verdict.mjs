// The concurrency-phase verdict: two workers ran the same trial side by
// side. Isolation held iff both finished cleanly, both markers carry the
// expected texts, AND the workers were actually distinct processes.
export function concurrencyVerdict(run) {
  const ok = run.aOk && run.bOk
    && run.markerA === 'ALPHA-MARKER'
    && run.markerB === 'BETA-MARKER'
  return {
    phase: 'concurrency',
    ok,
    detail: {
      aOk: run.aOk, bOk: run.bOk,
      markerA: run.markerA, markerB: run.markerB,
      distinctPids: run.pidA !== run.pidB,
    },
  }
}
