import { readFileSync } from 'node:fs';
import { createGoogleRateClient, parseGoogleRates } from '../src/lib/google-rates.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateAgyCost } from '../src/lib/agy-pricing.js';
import { usageSince } from '../src/lib/usage.js';

const html=readFileSync(new URL('./google-pricing-fixture.html',import.meta.url),'utf8');
const rateClient=createGoogleRateClient({fetchImpl:async()=>({ok:true,text:async()=>html}),now:()=>Date.parse('2026-10-14T06:12:05Z')});
const at = new Date('2026-10-14T06:12:05Z');
test('replays actual BUC-15 recorded counters with official rates and exact decimals', async () => {
  const result = await estimateAgyCost('gemini-3.8-flash-medium',
    { inputTokens: 27350, cachedInputTokens: 645937, outputTokens: 1699 }, { at, rateClient });
  assert.equal(result.costStatus, 'estimated');
  assert.equal(result.costUsdExact, '0.075329025');
  assert.equal(result.estimate.lineItems.cacheRead.costUsdExact, '0.048445275');
  assert.equal(result.estimate.lineItems.uncachedInput.costUsdExact, '0.0205125');
  assert.equal(result.estimate.lineItems.output.costUsdExact, '0.00637125');
  assert.equal(result.pricingProvenance.source, 'rate_card');
});
test('prices resumed per-run deltas, not the cumulative conversation twice', async () => {
  const { usage } = usageSince({ input_tokens: 200, cache_read_tokens: 500, output_tokens: 50 },
    { input_tokens: 100, cache_read_tokens: 300, output_tokens: 30 }, { isResume: true });
  const result = await estimateAgyCost('gemini-3.8-flash-high', usage, { at, rateClient });
  assert.equal(result.costUsdExact, '0.000165');
});
test('does not add a thinking breakdown to reported output a second time', async () => {
  const result = await estimateAgyCost('gemini-3.8-flash-low',
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 100, thinkingTokens: 40 }, { at, rateClient });
  assert.equal(result.costUsdExact, '0.000375');
});
test('rejects unknown models and incomplete usage, selects dated prices dynamically', async () => {
  const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 };
  for (const model of ['gemini-3.8-flash-preview', 'gemini-3.7-flash', 'claude-opus-4-6-thinking']) {
    assert.equal((await estimateAgyCost(model, usage, { at, rateClient })).costStatus, 'unpriced');
  }
  assert.equal((await estimateAgyCost('gemini-3.8-flash', { inputTokens: 1, outputTokens: 1 }, { at, rateClient })).costStatus, 'unpriced');
  assert.equal((await estimateAgyCost('gemini-3.8-flash', usage,
    { at: new Date('2027-01-01T00:00:00Z'), rateClient })).costUsdExact, '0.000009');
  assert.equal(parseGoogleRates(html.replace('$0.75 through', '$0.90 through'),'gemini-3.8-flash',at).ratesPerMillion.input_cost_per_token,'0.90');
});

test('refreshes official values after TTL and does not use stale rates on fetch failure', async () => {
  let clock=Date.parse('2026-10-14T06:12:05Z'), calls=0, fail=false;
  const client=createGoogleRateClient({now:()=>clock,ttlMs:1000,fetchImpl:async()=>{
    calls++;
    if(fail) throw new Error('source offline');
    return {ok:true,text:async()=>html.replace('$0.75 through',calls===1?'$0.75 through':'$0.90 through')};
  }});
  assert.equal((await client.get('gemini-3.8-flash',at)).ratesPerMillion.input_cost_per_token,'0.75');
  await client.get('gemini-3.8-flash',at); assert.equal(calls,1);
  clock+=1001;
  assert.equal((await client.get('gemini-3.8-flash',at)).ratesPerMillion.input_cost_per_token,'0.90');
  clock+=1001;fail=true;
  await assert.rejects(client.get('gemini-3.8-flash',at),/source offline/);
});
