/** Cumulative AGY CLI usage -> per-run deltas. Never fabricate a zero for missing fields. */
const FIELDS = ['input_tokens','output_tokens','cache_read_tokens','thinking_tokens','total_tokens'];
const KEYS = ['inputTokens','outputTokens','cachedInputTokens','thinkingTokens','totalTokens'];
export function extractUsageTotals(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const totals = {};
  for (const key of FIELDS) {
    const v = raw[key];
    if (v == null) continue;
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`Invalid AGY usage: ${key}`);
    totals[key] = v;
  }
  return 'input_tokens' in totals && 'output_tokens' in totals ? totals : null;
}
export function usageSince(raw, previousTotals = null, {isResume = false} = {}) {
  const current = extractUsageTotals(raw);
  if (!current) return {usage:null,usageBasis:'unavailable',usageTotals:null};
  const previous = previousTotals && typeof previousTotals === 'object' ? previousTotals : null;
  if (isResume && !previous) return {usage:null,usageBasis:'cumulative_without_baseline',usageTotals:current};
  const delta = {};
  for (let i = 0; i < FIELDS.length; i++) {
    const key = FIELDS[i], out = KEYS[i];
    if (!(key in current)) continue;
    if (isResume && !(key in previous)) continue;
    const d = isResume ? current[key] - previous[key] : current[key];
    if (d < 0) throw new Error(`AGY cumulative usage counter decreased: ${key}`);
    delta[out] = d;
  }
  return {usage:delta,usageBasis:'turn_delta',usageTotals:current};
}
