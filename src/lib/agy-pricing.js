import { estimateCostUsd } from './pricing.js';

import { googleRateClient } from './google-rates.js';

/** Paid Standard API-equivalent estimate, never a CLI subscription invoice. */
export async function estimateAgyCost(model, usage, { at = new Date(), rateClient = googleRateClient } = {}) {
  const unavailable = reason => ({ costStatus: 'unpriced', reason });

  if (!usage || !['inputTokens','cachedInputTokens','outputTokens'].every(k =>
    Number.isSafeInteger(usage[k]) && usage[k] >= 0)) {
    return unavailable('Complete per-run input, cache-read and output counters are required');
  }
  try {
    const card = await rateClient.get(model, at);
    const estimate = await estimateCostUsd({ provider: 'gemini', model: card.canonicalModel,
      response: usage, format: 'paperclip', inputIncludesCache: false, tier: 'standard',
      requireOfficial: true, at: new Date(card.verifiedAt),
      overrides: { [`gemini/${card.canonicalModel}`]: card },
    });
    return {
      costStatus: 'estimated', costUsdExact: estimate.costUsdExact,
      costUsd: Number(estimate.costUsdExact), provider: 'gemini',
      pricingContext: { serviceTier: 'standard' },
      pricingProvenance: {
        source: 'rate_card', version: `google-standard:sha256:${card.sha256}`,
        evidence: `${card.sourceUrl}; verified ${card.verifiedAt}; CLI ${model} mapped to ${card.canonicalModel}; paid Standard text API-equivalent estimate; CLI input excludes cached reads; output counter used as reported, thinking not charged twice; excludes cache storage, grounding, modalities and subscription charges`,
        inputCentsPerMillion: decimalCents(card.ratesPerMillion.input_cost_per_token), cachedInputCentsPerMillion: decimalCents(card.ratesPerMillion.cache_read_input_token_cost),
        outputCentsPerMillion: decimalCents(card.ratesPerMillion.output_cost_per_token), serviceTier: 'standard',
      },
      estimate: { ...estimate, pricingReliability: 'official_dynamic_document', selectedCliModel: model, pricingSha256: card.sha256, rateTimestamp: at.toISOString(),
        assumptions: ['Paid Standard text rates; CLI billing tier is not reported',
          'AGY output counter is used as reported; thinking is not added again'],
      },
    };
  } catch (error) {
    return unavailable(error.message);
  }
}

function decimalCents(value) {
  const [whole, fraction=''] = value.split('.');
  const digits=(whole+fraction).replace(/^0+(?=\d)/,'');
  const scale=fraction.length-2;
  if(scale<=0)return digits+'0'.repeat(-scale);
  const padded=digits.padStart(scale+1,'0');
  return `${padded.slice(0,-scale)}.${padded.slice(-scale)}`.replace(/\.?0+$/,'');
}
