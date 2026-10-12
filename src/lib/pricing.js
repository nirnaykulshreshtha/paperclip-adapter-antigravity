/**
 * Model token rates ($ / 1,000,000 tokens)
 * Gemini models:
 *   - Flash: $0.10 input, $0.025 cached input, $0.40 output
 *   - Pro:   $1.25 input, $0.3125 cached input, $5.00 output
 * Claude models:
 *   - Sonnet: $3.00 input, $0.30 cached input, $15.00 output
 *   - Haiku:  $0.80 input, $0.08 cached input, $4.00 output
 *   - Opus:   $15.00 input, $1.50 cached input, $75.00 output
 * OpenAI models:
 *   - GPT-4o:      $2.50 input, $1.25 cached input, $10.00 output
 *   - GPT-4o-mini: $0.15 input, $0.075 cached input, $0.60 output
 */

export const MODEL_RATES_PER_MILLION = {
  // Gemini Pro family (e.g. gemini-3.1-pro-high, gemini-3.1-pro-low, gemini-2.5-pro, gemini-1.5-pro)
  'gemini-pro': { input: 1.25, cached: 0.3125, output: 5.00 },
  // Gemini Flash family (e.g. gemini-3.8-flash-high, gemini-3.8-flash-low, gemini-3.5-flash, gemini-2.0-flash)
  'gemini-flash': { input: 0.10, cached: 0.025, output: 0.40 },
  // Claude family
  'claude-sonnet': { input: 3.00, cached: 0.30, output: 15.00 },
  'claude-haiku': { input: 0.80, cached: 0.08, output: 4.00 },
  'claude-opus': { input: 15.00, cached: 1.50, output: 75.00 },
  // GPT models
  'gpt-4o': { input: 2.50, cached: 1.25, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, cached: 0.075, output: 0.60 },
};

/**
 * Resolves token rate per million for a given model identifier.
 */
export function resolveModelRates(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('opus')) return MODEL_RATES_PER_MILLION['claude-opus'];
  if (m.includes('sonnet')) return MODEL_RATES_PER_MILLION['claude-sonnet'];
  if (m.includes('haiku')) return MODEL_RATES_PER_MILLION['claude-haiku'];
  if (m.includes('pro')) return MODEL_RATES_PER_MILLION['gemini-pro'];
  if (m.includes('gpt-4o-mini')) return MODEL_RATES_PER_MILLION['gpt-4o-mini'];
  if (m.includes('gpt-4o') || m.includes('gpt-4')) return MODEL_RATES_PER_MILLION['gpt-4o'];
  // Default to Gemini Flash rates
  return MODEL_RATES_PER_MILLION['gemini-flash'];
}

/**
 * Estimates USD inference cost from token counts and model pricing rates.
 * Accepts usage in camelCase (Paperclip style) or snake_case (CLI raw style).
 * Returns rounded USD amount (to 6 decimals) or null if usage is invalid.
 */
export function estimateCostUsd(model, usage) {
  if (!usage || typeof usage !== 'object') return null;

  const input = Number(usage.inputTokens ?? usage.input_tokens ?? 0);
  const cached = Number(usage.cachedInputTokens ?? usage.cache_read_tokens ?? usage.cached_input_tokens ?? 0);
  const output = Number(usage.outputTokens ?? usage.output_tokens ?? 0);

  const safeInput = Number.isFinite(input) && input >= 0 ? input : 0;
  const safeCached = Number.isFinite(cached) && cached >= 0 ? cached : 0;
  const safeOutput = Number.isFinite(output) && output >= 0 ? output : 0;

  if (safeInput === 0 && safeCached === 0 && safeOutput === 0) return 0;

  const rates = resolveModelRates(model);
  const cost = (safeInput * rates.input + safeCached * rates.cached + safeOutput * rates.output) / 1e6;

  return Math.round(cost * 1e6) / 1e6;
}
