// Minimal confinement verdict, extracted from a real evidence check: the
// net governance plugin writes a JSONL decision log; confinement held iff
// the child's network attempts were actually DENIED by governance.
export function confinementVerdict(decisionLogText) {
  const denials = decisionLogText.includes('denied')
  return { confined: denials, evidence: denials ? 'deny-decisions-present' : 'no-deny-decisions' }
}
