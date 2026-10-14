# Antigravity adapter for Paperclip — v0.6.0

A local external adapter using AGY stream-JSON and Paperclip's task, workspace, transcript, credential and configuration interfaces. Requires Node.js 24.11 or newer, matching the pinned Paperclip SDK. On macOS, model discovery also requires Python 3 for the PTY helper.

This release hardens shared-workspace execution, quota-session continuity and account-isolated health checks. It does not provide a cloud execution backend or detached native-runner adoption. See [production readiness and adapter comparison](docs/PRODUCTION_READINESS.md) and the [execution efficiency audit](docs/OTP_EFFICIENCY_AUDIT.md). Fixture tests do not prove provider quota savings or replace an authenticated canary.

A **native external Paperclip adapter**, updated from the supplied v0.2.12 archive. No separate HTTP bridge or UI service is required. Preserves the existing `antigravity_local` adapter type, Paperclip execution/workspace guardrails, skills staging, model APIs, and UI parser contract.

## Runtime behavior

| Concern | Behavior |
| --- | --- |
| Terminal account changes | Optional AGY `/statusline` observer records whitelisted email/model/quota data; Paperclip picks this up on its next adapter query/run |
| Model selection | Paperclip native `listModels` and `refreshModels` run **`agy models`**; model field uses a combobox, not a static catalog; selected ID is verified at run start by default |
| Credentials | No keychain writes or automatic account switching. Explicit sandbox credential copy-back accepts only a strictly newer credential for the same subscription identity; registry snapshots contain no tokens |
| Quota | Native `getQuotaWindows` uses the *fresh* interactive AGY quota snapshot, if available; otherwise reports unavailable |
| Sessions | Resumption tied to task, canonical workspace, workspace ID and model; account switches continue the stored conversation |
| Logs | Native Paperclip ACPX transcript (responses, tool calls/results, usage/checkpoints, real thinking deltas if emitted). Structured audit events go to Paperclip's `onEvent` |
| Usage | Persist cumulative CLI counters and report **per-run delta** on resumed turns. Unknown baselines remain unknown |
| Cost | Models matched to Google's official pricing table use dynamically fetched Standard text rates with `costStatus: 'estimated'`, exact decimals and provenance. This is an API-equivalent estimate, not a subscription invoice. Other models or incomplete/expired evidence stay unpriced; see [pricing audit](docs/PRICING_AUDIT.md) |
| Reliability | Serialized implementation writers, durable provider ownership receipts, private state files, bounded streams, redaction, command/workspace guards |

## Requirements

- Paperclip instance with external adapter support and `@paperclipai/adapter-utils` `2026.1005.0` dependency (its own published engine is Node >=24.11, although local tests also ran on Node 22.16).
- `agy` installed and authenticated for the **same OS user / HOME** as the Paperclip adapter worker.
- A dedicated secondary Git worktree, configured according to `workspaceMode`, `repositoryRoot`, and `allowedWorkspaceRoot`.
- Python 3 is required for `agy models` under a headless macOS PTY.

## Execution performance and repeated work

Explicit **Refresh models** always queries AGY. Execution validation can reuse live evidence for 60 seconds only after checking the current keychain credential digest, account, expiry and executable identity. Unknown credentials always require live discovery. Credential/account changes, executable updates, explicit refreshes and observed auth/quota failures revoke reuse. A successful provider turn renews evidence for its selected model only, so an immediate continuation avoids another model-list process even after a long turn. A model switch queries the live catalog when the reused evidence does not contain that model. Remote catalog changes can take up to 60 seconds to be reflected; Refresh models forces immediate revalidation.

Each run observes account identity once; a cold model lookup verifies the credentials again after discovery to reject account changes during the lookup. Unchanged account observations avoid redundant durable registry rewrites. The CLI continues to own authentication and account selection.

Adjacent response deltas are batched up to 8 KiB or 100 ms and replaceable progress snapshots are coalesced. Tool/session lifecycle boundaries flush pending text. One ordered publication queue delivers logs, events and progress independently of CLI parsing, with backpressure at 64 items or 256 KiB (a single larger record remains intact). Completion waits for delivery, and persistence failures fail the run. Journals buffer up to 64 KiB or 25 ms, preserve every accepted record in order, and flush/sync terminal records. Abrupt process death can lose the small nonterminal buffer; terminal records remain durable.

Verified resumed sessions retain at most 64 request and result digests to identify repeated unchanged investigation across wakes. They never cache tool outputs or skip required checks. Unchanged role/task context stays compact; skill content changes, including references and executable scripts, invalidate prompt reuse. Existing sessions without assigned skills retain their bootstrap signatures; sessions with skills receive one fresh bootstrap on upgrade to establish content verification. The unused persistent prompt-bundle preparation is removed from execution; assigned skills still receive private per-run copies and cleanup.

Inspect timing without printing account identities, prompts or tool output:

```sh
npm run perf:summary -- /path/to/antigravity-traces
# Development checkout only; controlled local benchmark with no real AGY turn:
npm run perf:benchmark
```

New traces include callback duration, model-discovery time, validation reuse, publication queue, journal batching and final cleanup timing. See the [performance audit](docs/performance-audit.md) for baseline measurements and controlled benchmark results.

## Upgrade

1. **Back up the original adapter and registry.** Do not unzip over an active plugin without a rollback copy. Stop/disable the adapter first.
2. Extract the package, run `npm ci` under a compatible Node/Paperclip runtime, then `npm run check && npm test`.
3. Register/reload the local external adapter in Paperclip. Keep `adapterType: "antigravity_local"` so agent configurations and task runs remain associated with the same adapter.
4. In each agent's config, choose **Refresh models** (live `agy models`), then select the requested model. The model is passed directly as `--model` to `agy` and revalidated at dispatch unless `validateSelectedModelOnRun:false` is explicitly set (testing only).
5. Keep existing workspace and implementation authorization controls. Nothing here automatically changes workspace permissions, merges or deploys.

### Observe account and quota changes from the AGY terminal

From the interactive `agy` TUI, opt in to the status-line observer:

```text
/statusline /ABSOLUTE/PATH/TO/ADAPTER/scripts/statusline-snapshot.mjs
```

The hook runs whenever the AGY TUI's status state changes. It writes an **atomic, mode-0600, sanitized** snapshot to `~/.paperclip/agy-status.json` by default. Configure the same `PAPERCLIP_AGY_STATUS_FILE=/absolute/path/agy-status.json` environment variable for both the AGY terminal and the Paperclip worker if their HOME paths differ. The two processes must be allowed to access the same protected file. Configure this manually: an existing custom AGY statusline may need to be combined, not silently replaced.

The observer stores only email, model ID, time and quota fields. It never writes tokens, changes accounts or logs in. Snapshots expire after two minutes; stale/missing data is shown as unavailable, not a guessed identity. The model selector **always** uses live `agy models`, not the status snapshot.

### Account switching

Use AGY's own login/logout controls in the terminal. The next observed status update, Paperclip model refresh or run picks up the account change. Paperclip resumes the same stored conversation after an account switch within the same task and workspace. Quota failures retain the conversation ID and cumulative usage baseline, including on the first turn. **The adapter never rotates OAuth credentials itself or replays a failed turn inside the same invocation.** The host recovery monitor admits a continuation once it observes a different account or the provider reset deadline arrives. If AGY refuses a cross-account conversation, the adapter reports the refusal and retains the session instead of silently starting over.

Running tasks publish their starting account and model in the transcript. While a CLI process is running, the adapter checks the observed account every ten seconds and publishes changes, preserving the original run account separately. Switching the terminal account does not prove that an already-running provider session has switched. Quota failures identify the run account, selected model and provider reset duration; structured results also include the reset timestamp when supplied by AGY. The Paperclip task chat account indicator requires the corresponding host UI update.

AGY's terminal observer is not a guaranteed authentication proof. On macOS the adapter additionally checks the currently discoverable keychain identity when available and fails if it conflicts with the observed AGY identity.

## Transcripts and thinking

The native `src/ui/parse-stdout.js` renders ACPX output via Paperclip's own transcript viewer; Paperclip owns run log persistence. Tool executions include linked IDs, timing, bounded outputs, failures and checkpoints. Thinking token counts are recorded as metadata and visible progress **but are not hidden reasoning text**. If an AGY build actually streams textual `thinking` or `agent_thought` deltas, those real deltas are forwarded; no artificial narrative is created.

`sessionParams` maintains the AGY conversation ID plus the recorded cumulative counters, allowing future turns to continue safely and measure new tokens. A legacy saved session with no counter baseline remains `cumulative_without_baseline` instead of double-charging cumulative usage.

## Scalability and limits

- **No additional database service:** rely on Paperclip's existing onLog/onEvent/run persistence and worker orchestration; do not maintain another competing history store.
- **Single host observation:** the AGY terminal snapshot/account pool are local files. For multi-host deployments, add worker affinity, per-worker AGY credentials and centralized account status through host APIs before dispatching tasks across machines.
- **No automatic retry after tool execution:** CLI 429, auth changes and failures are visible; retry is a new, explicitly scheduled run.
- **Bounded transcript:** AGY stdout, per-tool payloads and saved logs have size limits. A truncated transcript causes the run to fail rather than silently indicate success.
- **No claim of actual USD billing:** Antigravity CLI usage is not the provider's metered invoice. A separate billing reconciliation integration is required.
- **Paperclip frontend:** outside-running-task account badge and instantly pushed account changes require a Paperclip host UI/event subscription change; `getQuotaWindows`, `listModels`, task events and the run viewer are supported native surfaces, not a custom front-end patch.

## Tests

```bash
npm run check
npm test
npm run models:check  # requires real agy authentication and CLI installed
```

The automated suite uses fake AGY processes and fixtures, so the unit tests do **not** prove real CLI authentication, active account switching across macOS terminal sessions, or Paperclip production DB persistence.

**Security migration:** The v0.2.12 registry stored serialized OAuth/keyring payloads in plaintext JSON. New saves remove these fields, but any old copies/backups must be removed securely according to policy; consider rotating affected credentials. Do not expose the old registry as a user-downloadable artifact.

## Troubleshooting tests taking 15 seconds each (v0.3.1)

Run `npm run doctor` **before** `npm test`. If the doctor reports incompatible test
fixtures, replace the entire adapter source **and tests together** from this
archive. A test summary with **81 tests** and the positional
`estimateCostUsd(model, usage)` assertion is from the older suite, not v0.3.1.

The fast unit suite uses a deterministic injected model-discovery fixture.
Production `execute(ctx)` continues to run live `agy models` validation whenever
`validateSelectedModelOnRun` is enabled (the default). Production model lists are
never taken from the test fixture. Invalid or stale models fail closed.

Unit-test-only coverage does not verify local authenticated `agy` behavior.
Use `npm run models:check` and `npm run smoke` separately for integration checks.
These require an installed, authenticated CLI and can legitimately take longer.

Install in a **clean checkout** or a new branch; do not overlay only the `src`
folder over older tests. After copying the whole distribution, run:

```bash
npm ci
npm run doctor
npm run check
npm test
```

For the native Paperclip package, reload the external adapter after installation.
Avoid manually copying a changed `execute.js` into an older adapter without the
updated `test` files and package metadata.

## Execution history and detailed tool calls

Each execution writes an append-only JSONL journal to `~/.paperclip/antigravity-traces/<sha256-run-id-prefix>.jsonl` (or `config.traceDirectory`). The journal contains phase transitions, sanitized raw CLI events, stderr, Paperclip events, process exit, and terminal state. For every reported Antigravity tool call it additionally stores `tool.started`, `tool.completed` or `tool.interrupted`, including call ID, name, target, available parameters, timestamps, duration, full CLI-provided output up to the journal's per-field 256 KiB limit, output bytes/digest, and errors. The adapter cannot capture output that Antigravity's CLI itself does not emit.

Generate an offline, searchable, expandable history report:

```sh
node scripts/trace-report.mjs RUN_ID ./run-history.html
# or
node scripts/trace-report.mjs /path/to/trace.jsonl ./run-history.html
```

The report contains potentially sensitive prompts, file contents, and tool output. Keep it private. A 32 MiB cap per trace prevents unbounded storage; `journal.truncated` marks when the cap is reached. Older traces require periodic deletion or a separate retention policy. Runtime Paperclip UI rendering is host-controlled; the built-in offline viewer provides a complete view of captured events even if the host activity panel doesn't display them.


### Completion and runtime limits

`timeoutPolicy` defaults to `completion`: no wall-clock kill timer, including for agents with a saved legacy `timeoutSec: 900`. Select `timeoutPolicy: bounded` and a positive `timeoutSec` to opt into a wall-clock operational limit. This is a behavior change in 0.6.0. AGY always receives `--print-timeout 0`; the adapter is the sole owner of an explicitly bounded deadline, avoiding competing termination/final-response timers. Output-inactivity monitoring, cancellation, permission checks and approval gates remain independent; their termination is not evidence of completed work. Timeout and cancellation retain a CLI-observed task/workspace conversation when available, so later authorized continuation can verify earlier outcomes and finish remaining work.

A successful AGY turn is run-level success, not proof that the issue's acceptance criteria passed. Agent instructions require an evidence record for each criterion, completed and inspected background checks, and a correct Paperclip issue disposition: `done` only when no work remains, `in_review` for review/approval, or `blocked` for a concrete dependency. Paperclip owns subsequent continuation and task status; the adapter does not silently mark issues done or run its own retry loop. Unstructured provider prose cannot independently certify arbitrary acceptance criteria.

See [the completion contract](docs/COMPLETION_CONTRACT.md) for runtime policy, host authority, migration behavior and verification limits.
