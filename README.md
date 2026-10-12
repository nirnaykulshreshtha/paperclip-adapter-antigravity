# Paperclip adapter — Antigravity CLI (0.3.0)

A **native external Paperclip adapter**, updated from the supplied v0.2.12 archive. No separate HTTP bridge or UI service is required. Preserves the existing `antigravity_local` adapter type, Paperclip execution/workspace guardrails, skills staging, model APIs, and UI parser contract.

## Changes from 0.2.12

| Concern | v0.3 behavior |
| --- | --- |
| Terminal account changes | Optional AGY `/statusline` observer records whitelisted email/model/quota data; Paperclip picks this up on its next adapter query/run |
| Model selection | Paperclip native `listModels` and `refreshModels` run **`agy models`**; model field uses a combobox, not a static catalog; selected ID is verified at run start by default |
| Credentials | **No keychain writes or token copies**. Old JSON account-pool credentials are stripped on migration; switching AGY accounts is done in AGY itself |
| Quota | Native `getQuotaWindows` uses the *fresh* interactive AGY quota snapshot, if available; otherwise reports unavailable |
| Sessions | Resumption tied to task, canonical workspace, workspace ID, account and model; force fresh after detected account/model change |
| Logs | Native Paperclip ACPX transcript (responses, tool calls/results, usage/checkpoints, real thinking deltas if emitted). Structured audit events go to Paperclip's `onEvent` |
| Usage | Persist cumulative CLI counters and report **per-run delta** on resumed turns. Unknown baselines remain unknown |
| Cost | No fraudulent Gemini/Claude dollar number from CLI subscription tokens; `costStatus: 'unpriced'`. `src/lib/pricing.js` remains available for independently metered provider responses |
| Reliability | Atomic private state files, cross-process account-registry lock, corrupt-file errors, size limits, key redaction, command/workspace guards |

## Requirements

- Paperclip instance with external adapter support and `@paperclipai/adapter-utils` `2026.1005.0` dependency (its own published engine is Node >=24.11, although local tests also ran on Node 22.16).
- `agy` installed and authenticated for the **same OS user / HOME** as the Paperclip adapter worker.
- A dedicated secondary Git worktree, configured according to `workspaceMode`, `repositoryRoot`, and `allowedWorkspaceRoot`.
- Python 3 is required for `agy models` under a headless macOS PTY.

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

Use AGY's own login/logout controls in the terminal. The next observed status update, Paperclip model refresh or run picks up the account change. Paperclip starts a new conversation when it detects a different account. **The adapter will not rotate OAuth credentials or replay work after a 429.** This prevents unintended double tool execution and hidden account mismatches.

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
