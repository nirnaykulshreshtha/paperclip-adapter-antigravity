/**
 * AI cost estimator — Node.js 18+ ESM, no dependencies.
 *
 * Sources:
 * - LiteLLM's third-party model pricing catalog (downloaded, never assumed official).
 * - Optional reviewed official-source overrides, keyed by exact provider/model.
 *
 * Uses the provider's ACTUAL response usage. Computes token-only USD estimates
 * with base-10 BigInt mathematics. NOT an invoice or actual billed amount.
 *
 * Supported: text-only OpenAI Responses/Chat, Anthropic Messages, Gemini GenerateContent.
 * Inference tool calls, modality-specific billing, cache storage, subscriptions,
 * geography, discounts and negotiated pricing need separate billing records/rules.
 */

import { createHash } from 'node:crypto';

export const LITELLM_PRICING_URL =
    'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const PROVIDERS = new Set(['openai', 'anthropic', 'gemini']);
const TIERS = Object.freeze({ standard: '', batch: '_batches', flex: '_flex', priority: '_priority' });
const RATE_FIELDS = /^(?:input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|input_cost_per_token_cache_hit|cache_creation_input_token_cost(?:_above_1hr)?|output_cost_per_reasoning_token)(?:_above_\d+k_tokens)?(?:_(?:batches|flex|priority))?$/;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function invariant(ok, message) { if (!ok) throw new Error(message); }

// Rational decimals. Finite base-10 decimals stay exact, including multipliers.
// This avoids IEEE-754 money arithmetic and arbitrary 6-decimal truncation.
function decimal(value, label = 'decimal') {
  invariant(typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint', `Invalid ${label}`);
  const raw = String(value);
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  invariant(match !== null, `Invalid nonnegative ${label}: ${raw}`);
  const exponent = Number(match[3] || 0);
  invariant(Number.isSafeInteger(exponent) && Math.abs(exponent) <= 100, `Out-of-range exponent: ${label}`);
  let scale = (match[2]?.length ?? 0) - exponent;
  invariant(Math.abs(scale) <= 200, `Out-of-range precision: ${label}`);
  let numerator = BigInt(match[1] + (match[2] || ''));
  if (scale < 0) { numerator *= 10n ** BigInt(-scale); scale = 0; }
  while (scale && numerator % 10n === 0n) { numerator /= 10n; scale--; }
  return { n: numerator, scale };
}
const zero = () => ({ n: 0n, scale: 0 });
const multiply = (a, b) => ({ n: a.n * b.n, scale: a.scale + b.scale });
const multiplyTokens = (tokens, rate) => ({ n: tokens * rate.n, scale: rate.scale });
function add(a, b) {
  const scale = Math.max(a.scale, b.scale);
  return {
    n: a.n * 10n ** BigInt(scale - a.scale) + b.n * 10n ** BigInt(scale - b.scale),
    scale,
  };
}
function subtractSigned(a, b) {
  const scale = Math.max(a.scale, b.scale);
  const diff = a.n * 10n ** BigInt(scale - a.scale) - b.n * 10n ** BigInt(scale - b.scale);
  return (diff < 0n ? '-' : '') + asString({ n: diff < 0n ? -diff : diff, scale });
}
function asString(v) {
  const digits = v.n.toString().padStart(v.scale + 1, '0');
  if (!v.scale) return digits;
  return `${digits.slice(0, -v.scale)}.${digits.slice(-v.scale)}`.replace(/\.?0+$/, '');
}
export function formatUsd(value, places = 6) {
  invariant(Number.isSafeInteger(places) && places >= 0 && places <= 18, 'Invalid display precision');
  const v = decimal(value, 'amount');
  if (v.scale <= places) return asString(v);
  const divisor = 10n ** BigInt(v.scale - places);
  const rounded = (v.n + divisor / 2n) / divisor;
  return asString({ n: rounded, scale: places });
}
function tokens(value, field, { optional = true } = {}) {
  if (value == null && optional) return 0n;
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return BigInt(value);
  throw new Error(`Invalid or missing token count: ${field}`);
}
function get(o, ...paths) {
  for (const path of paths) {
    let x = o;
    for (const p of path.split('.')) x = x?.[p];
    if (x !== undefined && x !== null) return x;
  }
  return undefined;
}
function normalizeProvider(provider) {
  invariant(PROVIDERS.has(provider), `Unsupported provider: ${String(provider)}`);
  return provider;
}
function normalizeTier(value) {
  if (value == null || value === '' || /^(default|standard)$/i.test(String(value))) return 'standard';
  const t = String(value).toLowerCase();
  invariant(has(TIERS, t), `Unknown or unsupported billing service tier: ${value}`);
  return t;
}

/** Mutually exclusive, exact BigInt token counters. */
export function normalizeUsage(provider, response, options = {}) {
  normalizeProvider(provider);
  invariant(response && typeof response === 'object', 'Missing provider response');
  const u = response.usage ?? response.usageMetadata ?? response;
  let fresh = 0n, cacheRead = 0n, cacheWrite = 0n, cacheWrite5m = 0n, cacheWrite1h = 0n;
  let output = 0n, reasoning = 0n, promptTotal = 0n;

  if (options.format === 'paperclip') {
    invariant(typeof options.inputIncludesCache === 'boolean',
        'Paperclip requires inputIncludesCache: true/false (adapter-dependent)');
    invariant(get(u, 'inputTokens', 'input_tokens') != null &&
        get(u, 'outputTokens', 'output_tokens') != null, 'Missing final Paperclip input/output usage');
    const input = tokens(get(u, 'inputTokens', 'input_tokens'), 'Paperclip input');
    cacheRead = tokens(get(u, 'cachedInputTokens', 'cached_input_tokens', 'cache_read_tokens'), 'Paperclip cached reads');
    output = tokens(get(u, 'outputTokens', 'output_tokens'), 'Paperclip output');
    const writes = get(u, 'cacheWrite5mTokens', 'cacheWrite1hTokens', 'cache_creation_input_tokens');
    invariant(writes == null || tokens(writes, 'Paperclip cache writes') === 0n,
        'Paperclip cache writes need the original provider response');
    fresh = input - (options.inputIncludesCache ? cacheRead : 0n);
    promptTotal = fresh + cacheRead;
  } else if (provider === 'openai') {
    invariant(get(u, 'input_tokens', 'prompt_tokens') != null &&
        get(u, 'output_tokens', 'completion_tokens') != null, 'Missing final OpenAI input/output usage');
    const input = tokens(get(u, 'input_tokens', 'prompt_tokens'), 'OpenAI input');
    cacheRead = tokens(get(u, 'input_tokens_details.cached_tokens', 'prompt_tokens_details.cached_tokens'), 'OpenAI cached');
    cacheWrite = tokens(get(u, 'input_tokens_details.cache_write_tokens', 'prompt_tokens_details.cache_write_tokens'), 'OpenAI cache writes');
    // OpenAI usage includes cache reads AND cache writes in the input total.
    fresh = input - cacheRead - cacheWrite;
    output = tokens(get(u, 'output_tokens', 'completion_tokens'), 'OpenAI output');
    reasoning = tokens(get(u, 'output_tokens_details.reasoning_tokens', 'completion_tokens_details.reasoning_tokens'), 'OpenAI reasoning');
    // Reasoning is ALREADY included in total output tokens.
    promptTotal = input;
  } else if (provider === 'anthropic') {
    invariant(u.input_tokens != null && u.output_tokens != null,
        'Missing final Anthropic input/output usage');
    fresh = tokens(u.input_tokens, 'Claude uncached input');
    cacheRead = tokens(u.cache_read_input_tokens, 'Claude cached read');
    const written = tokens(u.cache_creation_input_tokens, 'Claude cache written');
    const breakdown = u.cache_creation;
    if (breakdown != null) {
      cacheWrite5m = tokens(breakdown.ephemeral_5m_input_tokens, 'Claude 5-minute cache write');
      cacheWrite1h = tokens(breakdown.ephemeral_1h_input_tokens, 'Claude 1-hour cache write');
      invariant(written === cacheWrite5m + cacheWrite1h,
          'Claude cache creation breakdown does not match total');
    } else if (written > 0n) {
      invariant(options.cacheWriteTtl === '5m' || options.cacheWriteTtl === '1h',
          'Claude cache write TTL cannot be inferred; set cacheWriteTtl');
      if (options.cacheWriteTtl === '5m') cacheWrite5m = written;
      else cacheWrite1h = written;
    }
    output = tokens(u.output_tokens, 'Claude output (includes thinking)');
    promptTotal = fresh + cacheRead + cacheWrite5m + cacheWrite1h;
  } else {
    invariant(u.promptTokenCount != null && u.candidatesTokenCount != null,
        'Missing final Gemini prompt/candidate usage');
    const input = tokens(u.promptTokenCount, 'Gemini total prompt');
    cacheRead = tokens(u.cachedContentTokenCount, 'Gemini cached part');
    fresh = input - cacheRead;
    reasoning = tokens(u.thoughtsTokenCount, 'Gemini thinking');
    // Gemini candidates excludes thoughts; bill thoughts at output rate.
    output = tokens(u.candidatesTokenCount, 'Gemini candidates') + reasoning;
    promptTotal = input;
    invariant(tokens(u.toolUsePromptTokenCount, 'Gemini tool prompt') === 0n,
        'Gemini tool-use prompts need an explicit pricing rule');
  }
  invariant(fresh >= 0n && reasoning <= output,
      'Inconsistent usage: cached or reasoning tokens exceed provider totals');
  return { fresh, cacheRead, cacheWrite, cacheWrite5m, cacheWrite1h, output, reasoning, promptTotal };
}

function rejectUnsupportedMetering(provider, response) {
  const u = response?.usage ?? response?.usageMetadata ?? response;
  if (provider === 'openai') {
    invariant(tokens(get(u, 'input_tokens_details.audio_tokens', 'prompt_tokens_details.audio_tokens'), 'audio input') === 0n &&
        tokens(get(u, 'output_tokens_details.audio_tokens', 'completion_tokens_details.audio_tokens'), 'audio output') === 0n,
        'Audio metering is not supported by text-only estimator');
  }
  if (provider === 'gemini') {
    for (const field of ['promptTokensDetails', 'cacheTokensDetails', 'candidatesTokensDetails', 'toolUsePromptTokensDetails']) {
      for (const part of u?.[field] ?? []) {
        invariant(part.modality === 'TEXT' || tokens(part.tokenCount, field) === 0n,
            `Gemini ${part.modality || 'unknown'} modality requires modality-specific rates`);
      }
    }
  }
  if (provider === 'anthropic') {
    for (const tool of ['web_search_requests', 'web_fetch_requests']) {
      invariant(tokens(u?.server_tool_use?.[tool], `Claude ${tool}`) === 0n,
          'Claude server-tool requests require separate charges');
    }
  }
}

function extractRates(entry) {
  const clean = {};
  for (const [field, value] of Object.entries(entry)) {
    if (RATE_FIELDS.test(field) && (typeof value === 'string' || typeof value === 'number')) {
      decimal(value, field); // Validate; never convert a missing value to zero.
      clean[field] = String(value);
    }
  }
  return clean;
}

/** Strict ID matching: no substring heuristics, version guessing, or family defaults. */
export function resolveModelRates(provider, model, catalog) {
  normalizeProvider(provider);
  invariant(typeof model === 'string' && model.trim(), 'Missing actual provider billing model ID');
  const entries = catalog?.models ?? catalog;
  invariant(entries && typeof entries === 'object' && !Array.isArray(entries), 'Missing pricing catalog');
  const raw = model.trim();
  const ids = raw.startsWith(`${provider}/`) ? [raw] : [`${provider}/${raw}`, raw];
  for (const id of ids) {
    const entry = entries[id];
    if (!entry || entry.litellm_provider !== provider) continue;
    if (entry.mode && !['chat', 'completion', 'responses'].includes(entry.mode)) continue;
    const rates = extractRates(entry);
    if (has(rates, 'input_cost_per_token') && has(rates, 'output_cost_per_token')) {
      return { key: id, entry: { ...entry, ...rates } };
    }
  }
  throw new Error(`No exact ${provider} text pricing for model ${raw}`);
}

/**
 * Overrides are manually reviewed against an official provider page.
 * ratesPerMillion keys are LiteLLM-style field names, but USD PER MILLION.
 * Override replaces ALL token-rate fields (never merges unknown community prices).
 */
export function officialOverrideEntry(provider, model, overrides, at = new Date()) {
  normalizeProvider(provider);
  if (!overrides) return null;
  const key = `${provider}/${model}`;
  const override = overrides[key];
  if (override == null) return null;
  const allowedDomains = {
    openai: ['openai.com'],
    anthropic: ['anthropic.com', 'claude.com'],
    gemini: ['google.dev', 'google.com'],
  };
  const src = new URL(override.sourceUrl);
  invariant(src.protocol === 'https:' && allowedDomains[provider].some(d =>
      src.hostname === d || src.hostname.endsWith(`.${d}`)),
      `Override for ${key} must cite an official ${provider} HTTPS page`);
  const verifiedAt = Date.parse(override.verifiedAt);
  const expiresAt = Date.parse(override.expiresAt);
  const now = +new Date(at);
  invariant(Number.isFinite(verifiedAt) && Number.isFinite(expiresAt) && Number.isFinite(now) &&
      verifiedAt <= now && now < expiresAt && verifiedAt < expiresAt,
      `Pricing override expired, future-dated or invalid: ${key}`);
  if (override.effectiveFrom != null) {
    invariant(Date.parse(override.effectiveFrom) <= now, `Pricing override not effective: ${key}`);
  }
  invariant(override.ratesPerMillion && typeof override.ratesPerMillion === 'object',
      `Missing official override rates for ${key}`);
  const converted = {};
  for (const [field, perMillion] of Object.entries(override.ratesPerMillion)) {
    invariant(RATE_FIELDS.test(field), `Unexpected override field: ${field}`);
    const perToken = decimal(perMillion, field);
    converted[field] = asString({ n: perToken.n, scale: perToken.scale + 6 });
  }
  invariant(has(converted, 'input_cost_per_token') && has(converted, 'output_cost_per_token'),
      `Missing base official rates for ${key}`);
  return { key, entry: { litellm_provider: provider, mode: 'chat', ...converted },
    provenance: { kind: 'official_manual_override', sourceUrl: src.href,
      verifiedAt: override.verifiedAt, expiresAt: override.expiresAt } };
}

// A cached, ETag-aware LiteLLM downloader; failed refresh NEVER silently uses stale data.
export function createPricingClient({
                                      url = LITELLM_PRICING_URL, fetchImpl = globalThis.fetch,
                                      ttlMs = 60 * 60_000, timeoutMs = 12_000, now = Date.now,
                                    } = {}) {
  invariant(typeof fetchImpl === 'function', 'fetch is required (Node 18+)');
  invariant(Number.isSafeInteger(ttlMs) && ttlMs >= 0, 'Invalid catalog TTL');
  invariant(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'Invalid catalog timeout');
  let cached = null, pending = null;
  async function refresh() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { accept: 'application/json' };
      if (cached?.etag) headers['if-none-match'] = cached.etag;
      const res = await fetchImpl(url, { headers, signal: controller.signal });
      if (res.status === 304) {
        invariant(cached !== null, 'Received 304 without cached catalog');
        cached = { ...cached, fetchedAt: now() };
        return cached;
      }
      invariant(res.ok, `Price registry HTTP ${res.status}`);
      const contentLength = Number(res.headers?.get?.('content-length'));
      invariant(!Number.isFinite(contentLength) || contentLength <= 15_000_000,
          'Price catalog too large');
      const body = await res.text();
      invariant(body.length < 15_000_000, 'Price catalog too large');
      const models = JSON.parse(body);
      invariant(models && typeof models === 'object' && !Array.isArray(models) &&
          Object.keys(models).length > 100, 'Invalid or incomplete pricing registry');
      cached = { models, source: url, fetchedAt: now(),
        sha256: createHash('sha256').update(body).digest('hex'),
        etag: res.headers?.get?.('etag') ?? null };
      return cached;
    } finally { clearTimeout(timer); }
  }
  async function getCatalog({ force = false } = {}) {
    if (!force && cached && now() - cached.fetchedAt < ttlMs) return cached;
    if (!pending) pending = refresh().finally(() => { pending = null; });
    return pending;
  }
  return { getCatalog, estimate: params => estimateCostUsd({ ...params, loadCatalog: getCatalog }) };
}
const defaultClient = createPricingClient();
export const loadPricingCatalog = options => defaultClient.getCatalog(options);

function lookupRate(entry, base, tier, promptTokens, { optional = false } = {}) {
  const suffix = TIERS[tier];
  invariant(suffix !== undefined, `Unsupported tier: ${tier}`);
  const expr = new RegExp(`^${base}_above_(\\d+)k_tokens${suffix}$`);
  let selected = null;
  for (const key of Object.keys(entry)) {
    const match = expr.exec(key);
    if (!match) continue;
    const threshold = BigInt(match[1]) * 1000n;
    if (promptTokens > threshold && (!selected || threshold > selected.threshold)) {
      selected = { key, threshold };
    }
  }
  const key = selected?.key || `${base}${suffix}`;
  if (!has(entry, key)) {
    if (optional) return null;
    throw new Error(`Missing ${tier} price field ${key}`);
  }
  return { key, value: decimal(entry[key], key) };
}
function claudeCacheWrite(entry, ttl, tier, prompt) {
  const field = ttl === '1h' ? 'cache_creation_input_token_cost_above_1hr' : 'cache_creation_input_token_cost';
  const found = lookupRate(entry, field, tier, prompt, { optional: true });
  if (found) return found;
  // Official Anthropic cache-writing rates: 5m=1.25x input, 1h=2x input.
  // Only derive for standard pricing, never invent other service-tier pricing.
  const base = lookupRate(entry, 'input_cost_per_token', tier, prompt);
  const factor = ttl === '1h' ? decimal('2') : decimal('1.25');
  return { key: `${base.key} * ${ttl === '1h' ? '2' : '1.25'} (Anthropic cache rule)`,
    value: multiply(base.value, factor) };
}

/**
 * Estimates the token-only cost in USD. Every calculated amount is an exact
 * DECIMAL STRING, never a JavaScript money Number. No hidden fallback model.
 *
 * @param {{provider:'openai'|'anthropic'|'gemini',model:string,response:object,
 * pricingCatalog?:object,overrides?:object,requireOfficial?:boolean,
 * tier?:string,format?:'paperclip',inputIncludesCache?:boolean,
 * cacheWriteTtl?:'5m'|'1h',loadCatalog?:Function,at?:Date}} params
 */
export async function estimateCostUsd(params) {
  invariant(params && typeof params === 'object', 'Pass an options object');
  const { provider, model, response, pricingCatalog, overrides,
    requireOfficial = false, loadCatalog = loadPricingCatalog,
    at = new Date(), ...options } = params;
  normalizeProvider(provider);
  invariant(typeof model === 'string' && model.trim(), 'Missing actual model ID');
  const reportedTier = provider === 'gemini'
      ? get(response, 'usageMetadata.serviceTier', 'serviceTier')
      : get(response, 'service_tier', 'serviceTier');
  if (options.tier != null && reportedTier != null) {
    invariant(normalizeTier(options.tier) === normalizeTier(reportedTier),
        'Requested service tier conflicts with response tier');
  }
  const tier = normalizeTier(options.tier ?? reportedTier);
  rejectUnsupportedMetering(provider, response);
  const u = normalizeUsage(provider, response, options);
  const manual = officialOverrideEntry(provider, model, overrides, at);
  invariant(!requireOfficial || manual, `An unexpired official-price override is required for ${provider}/${model}`);
  const catalog = manual ? null : pricingCatalog ?? await loadCatalog();
  const matched = manual ?? resolveModelRates(provider, model, catalog);
  const entry = matched.entry;
  const applied = {};
  const lineItems = {};
  let total = zero();
  function line(name, amountTokens, r) {
    if (!amountTokens) return;
    const item = multiplyTokens(amountTokens, r.value);
    total = add(total, item);
    lineItems[name] = { tokens: amountTokens.toString(),
      rateUsdPerToken: asString(r.value), rateField: r.key, costUsdExact: asString(item) };
    applied[r.key] = asString(r.value);
  }
  const input = lookupRate(entry, 'input_cost_per_token', tier, u.promptTotal);
  const out = lookupRate(entry, 'output_cost_per_token', tier, u.promptTotal);
  line('uncachedInput', u.fresh, input);
  if (u.cacheRead) {
    const cached = lookupRate(entry, 'cache_read_input_token_cost', tier, u.promptTotal, { optional: true })
        ?? lookupRate(entry, 'input_cost_per_token_cache_hit', tier, u.promptTotal, { optional: true });
    invariant(cached, `Missing cache-read rate for ${matched.key}`);
    line('cacheRead', u.cacheRead, cached);
  }
  if (u.cacheWrite) {
    line('cacheWrite', u.cacheWrite,
        lookupRate(entry, 'cache_creation_input_token_cost', tier, u.promptTotal));
  }
  if (u.cacheWrite5m) {
    line('cacheWrite5m', u.cacheWrite5m,
        claudeCacheWrite(entry, '5m', tier, u.promptTotal));
  }
  if (u.cacheWrite1h) {
    invariant(provider === 'anthropic', '1-hour cache writes only supported for Anthropic');
    line('cacheWrite1h', u.cacheWrite1h, claudeCacheWrite(entry, '1h', tier, u.promptTotal));
  }
  const specialReasoning = lookupRate(entry, 'output_cost_per_reasoning_token', tier, u.promptTotal,
      { optional: true });
  if (specialReasoning && u.reasoning) {
    line('output', u.output - u.reasoning, out);
    line('reasoningOutput', u.reasoning, specialReasoning);
  } else {
    line('output', u.output, out);
  }
  const result = {
    costUsdExact: asString(total), displayUsd: formatUsd(asString(total)),
    status: 'token_only_estimate',
    pricingReliability: manual ? 'official_manually_verified' : 'third_party_unverified',
    provider, model, pricingKey: matched.key, tier,
    usage: Object.fromEntries(Object.entries(u).map(([k, v]) => [k, v.toString()])),
    lineItems, appliedRates: applied,
    pricingSource: manual ? matched.provenance.sourceUrl : catalog.source ?? 'caller_supplied_catalog',
    pricingFetchedAt: manual ? matched.provenance.verifiedAt : catalog.fetchedAt ?? null,
    pricingSha256: manual ? null : catalog.sha256 ?? null,
    overrideExpiresAt: manual ? matched.provenance.expiresAt : null,
    // Durable per-event snapshot; do not recalculate past calls at today's prices.
    pricingSnapshot: { ...extractRates(entry) },
    caveat: 'Token-only estimate; reconcile actual charges via provider billing.',
  };
  return result;
}

/** Compare an estimate against an externally supplied billed amount. */
export function reconcileCost(estimatedUsdExact, billedUsdExact) {
  const estimate = decimal(estimatedUsdExact, 'estimatedUsdExact');
  const billed = decimal(billedUsdExact, 'billedUsdExact');
  return { estimatedUsdExact: asString(estimate), billedUsdExact: asString(billed),
    billedMinusEstimatedUsdExact: subtractSigned(billed, estimate) };
}