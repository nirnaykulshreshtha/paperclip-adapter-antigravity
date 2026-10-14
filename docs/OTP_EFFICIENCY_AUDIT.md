# OTP adapter efficiency audit — 14 October 2026

Ten saved YourClientDesk execution traces contain 593 tool starts and 167 exact repeated requests (28%). Exact repeats compare tool name and all parameters, including file ranges. They are an investigation signal, not proof that every repeat was avoidable: tests may need rerunning after changes. In one successful run, 33 of 96 calls repeated, two files were read seven and six times, and one test command ran four times. These traces do not establish subscription-window consumption or dollar cost.

## Fixes

- Normalize newer `paperclipWake.issue` assignments into the prompt and stable task digest. Nested requirement changes now invalidate the context fingerprint and reach resumed conversations. Explicit host fields retain precedence.
- Include the verified checkout and branch in full and resumed prompts. State that task identity and assignment are already supplied; avoid environment dumps, process inspection and repeated issue GETs just to rediscover them.
- Default to a cooperative initial investigation budget of 12 tool calls, then require a concrete change, verification result or named blocker. Batch targeted reads, reuse known results, and reserve broad regressions for relevant changes and integration gates. This is prompt guidance, not a hard token cap or cancellation policy.
- Record `resultJson.efficiency` on completed and failed CLI runs: call counts, exact repeats, unchanged repeated outputs, failures and output bytes. Emit a diagnostic at the third identical request/result. Legitimate changed outputs do not trigger that warning; duplicate lifecycle events do not inflate counts.
- Tag new journals with task and agent identity so future audits can attribute work without inspecting private transcripts. Refresh older conversations once for the updated protocol.

## Limits and next verification

Paperclip was not listening on localhost:3100 during this audit. Read-only database inspection shows 10 completed children, with BUC-11 and BUC-14 blocked after `process_lost` runs; BUC-1 remains blocked. Eighteen recorded runs comprise 11 succeeded, five failed and two interrupted. Recorded successful-run input counts include 124,310–336,260 tokens in the displayed recent sample, alongside millions of cached input tokens. These are stored run counters, not an independent measure of subscription-window consumption. Host rollout and live execution could not be verified. The installed local adapter is a symlink to this repository; the new code loads on the next host start/reload. Do not restart a worker with active tasks just to refresh it.

Measure the next representative runs using actual CLI usage together with efficiency counters, elapsed time, fresh/resumed prompt mode, retries and completed acceptance criteria. Do not infer token savings from the percentage of repeated calls or shorten required security/QA checks. CLI history replay and provider quota policy remain outside the adapter's control.
