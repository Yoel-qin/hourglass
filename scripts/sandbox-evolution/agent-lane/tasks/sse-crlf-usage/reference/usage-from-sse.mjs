// Usage metering for an SSE chat-completions stream, minimal extraction:
// the chunk carrying a `usage` object (emitted last when usage streaming is
// on); the last usage-bearing chunk wins; `[DONE]` terminates the stream.

export function extractUsageFromJson(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const usage = parsed.usage
  if (usage === null || typeof usage !== 'object') return undefined
  const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined
  const completionTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined
  const totalTokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined
  if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) return undefined
  return { promptTokens, completionTokens, totalTokens }
}

export function extractUsageFromSse(bodyText) {
  let found
  for (const line of bodyText.split('\n')) {
    // CR-tolerant: CRLF-terminated frames are valid SSE (non-Node gateways).
    const match = /^data: (.+)\r?$/.exec(line)
    if (match === null || match[1] === '[DONE]') continue
    const candidate = extractUsageFromJson(match[1])
    if (candidate !== undefined) found = candidate
  }
  return found
}
