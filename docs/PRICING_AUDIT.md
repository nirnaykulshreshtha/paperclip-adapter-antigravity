# Gemini pricing audit — 2026-10-14

The successful executor previously hardcoded `costStatus: unpriced` and did not call the pricing calculator. v0.5.2 dynamically fetches Google's official pricing page and connects its parsed rates to Paperclip's existing `estimated` receipt contract, without reporting an invented provider invoice.

## Reviewed evidence

- Official model code and supported thinking settings: https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash
- Official Standard pricing: https://ai.google.dev/gemini-api/docs/pricing#gemini-3.8-flash
- Live `agy models` on this host returned `gemini-3.8-flash-{low,medium,high}`, labelled Gemini 3.8 Flash with the corresponding thinking level. The parser matches the exact official model section, stripping only a thinking-level suffix when needed; it does not substitute another generation or provider.
- Reviewed USD per million tokens: uncached input 0.75, cache reads 0.075, output 3.75. The promotional period ends December 31, 2026. These numbers are the audit snapshot, not embedded runtime rates. The parser selects the applicable dated price for the run timestamp, including the published January 1, 2027 transition. Successful official documents are cached for one hour; refresh failures never reuse stale prices. Ambiguous modality, context-tier, or missing rows remain unpriced.

## Recorded BUC-15 replay

Run `4d27c975-b1fc-4a5a-95af-c84879bc0f22`, selected model `gemini-3.8-flash-medium`:

| Component | Per-run tokens | USD per million | Exact USD |
| --- | ---: | ---: | ---: |
| Uncached input | 27,350 | 0.75 | 0.0205125 |
| Cache reads | 645,937 | 0.075 | 0.048445275 |
| Reported output | 1,699 | 3.75 | 0.00637125 |
| Total | | | 0.075329025 |

AGY input excludes cache reads; cached tokens must not be subtracted from uncached input. Resumed conversation totals are first reduced to per-run deltas. The output counter is used as reported; thinking breakdowns are not added a second time. Recorded step events report totals equal to input plus output, with a separate thinking breakdown. This is a stated counter assumption, not a provider invoice audit.

## Limits and durable accounting

This is a paid Standard text API-equivalent token estimate. AGY does not report its billing tier or account's actual per-run charge. Cache storage duration, grounding/tool charges, modalities, subscription allowances, discounts and taxes are excluded. Unknown models, incomplete deltas and expired cards remain unpriced with a reason. Historical receipts are corrected through Paperclip's audited adjustment API. Original provider values remain retained, while effective costs, statuses and spend projections are updated transactionally. Backfill requires proven per-run counters and exclusive-cache semantics, and checks correction history for idempotency. Missing evidence is skipped. The reusable script is `scripts/backfill-model-costs.mjs` (`--receipts`, `--company`, `--report`; preview by default, `--apply` writes through the API).

The adapter emits `costStatus: estimated`, `costUsdExact`, `pricingContext` and `pricingProvenance` in the supported accounting result, plus the full rate/line-item snapshot in `resultJson.pricingEstimate`. Provider is Gemini; biller remains Antigravity and billing type stays unknown because a rate estimate does not prove the account's charge model.

## Applied backfill

Company `4ea0f1ae-bac9-42bc-8a0c-76d2bd2c5819`: 37 existing receipts received audited rate-card adjustments totalling USD 9.015382125. The cost summary confirms 37 estimated events and 2 unpriced events, with exact spend 901.5382125 cents. The two skipped runs (`5dbb9de7-b03b-4f9a-b8aa-3e8b7e49818d`, `71aa1d2c-ac9e-4517-8eaf-b9c1260a71f9`) lack proven per-run/exclusive-cache semantics. No agent turns were replayed. Earlier activity messages and raw run usage retain their original historical content; effective ledger valuations are corrected through linked adjustment records.
