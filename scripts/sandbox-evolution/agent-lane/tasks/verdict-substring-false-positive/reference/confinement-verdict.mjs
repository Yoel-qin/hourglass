// Minimal confinement verdict, extracted from a real evidence check: the
// net governance plugin writes a JSONL decision log; confinement held iff
// the child's network attempts were actually DENIED by governance. The
// verdict is derived from the parsed decision RECORDS — a substring
// shortcut over JSON text also matches field names ("denied":false), which
// turns every allowed-only log into a false confinement verdict.
export function confinementVerdict(decisionLogText) {
  let denials = 0
  for (const line of decisionLogText.split('\n')) {
    if (line.trim() === '') continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed !== null && typeof parsed === 'object' && parsed.denied === true) denials += 1
  }
  const confined = denials > 0
  return { confined, evidence: confined ? 'deny-decisions-present' : 'no-deny-decisions', denials }
}
