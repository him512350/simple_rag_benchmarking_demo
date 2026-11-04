export const FINISH_REASONS = Object.freeze(['stop', 'length', 'tool_calls', 'content_filter', 'error']);
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function resultMetadata(value) {
  const data = value && typeof value === 'object' ? value : {};
  return {
    elapsedMs: nonnegative(data.elapsedMs),
    usage: data.usage && typeof data.usage === 'object' ? Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].map(key => [key, nonnegative(data.usage[key])])) : null,
    truncated: data.truncated === true,
    finishReason: FINISH_REASONS.includes(data.finishReason) ? data.finishReason : null,
    outputTokens: [1024, 4096].includes(data.outputTokens) ? data.outputTokens : null,
  };
}
