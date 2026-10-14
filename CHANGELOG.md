# Changelog

## 0.5.4 — Verified account recovery release

- Package account handoff, quota continuation and verified model-rate pricing changes with refreshed runtime import versions.
- Verified live BUC-25 recovery under the newly authenticated account using its retained AGY conversation ID.

## 0.5.3 — Account handoff and quota continuation

- Preserve CLI conversation IDs and usage baselines on quota interruptions, including the first turn; resume the same task under a newly authenticated account.
- Retain interrupted sessions when a provider refuses account handoff, without silently creating a new conversation.
- Publish account changes during runs and expose current credential identity independently of quota-window availability.
- Supply exact provider reset timestamps to Paperclip recovery; host changes bring quota waits forward after account switches and synchronize second-level countdowns with server time.

## 0.5.2 — Verified Gemini token-rate estimates

- Connect exact-decimal pricing to successful run accounting for explicitly mapped Gemini 3.8 Flash variants using dynamically fetched official Google Standard rates.
- Emit `estimated`, exact USD, rate provenance and a calculation snapshot; retain unpriced fallback for unsupported models, incomplete per-run counters and ambiguous or unavailable official pricing.
- Replay actual BUC-15 counters in regression tests; price cached reads separately and preserve resumed-run delta semantics.

## 0.5.1 — Supported implementation CLI mode

- Omit the implementation mode override: AGY supports `accept-edits`, `auto` and `plan`, not `default`. Preserve sandbox and implementation authorization.
- Version the executor import so Paperclip's runtime adapter reload loads the corrected executor on an existing host.
- Assert implementation never emits an unsupported mode or permission-bypass flag.

## 0.5.0 — Local execution hardening

- Serialize implementation writers with Paperclip's cross-process directory lock and retain provider ownership receipts across controller loss. Unknown dispatch or surviving CLI process groups block workspace reuse.
- Preserve a verified same-account conversation on quota failure without automatic retry or account switching; unsafe or unverifiable sessions still clear.
- Scope successful health-probe caching by company/account identity, bypass caching for unknown identity, and bound the cache size.
- Accept host adapter-config fallback consistently, validate inactivity settings, and tolerate an omitted runtime-command configuration.
- Align the Node engine with the SDK requirement (24.11+), add an offline CI template, and document the local/cloud/native-runner capability boundary.

## 0.4.3 — Shared feature execution and efficiency fixes

- Deliver nested Paperclip assignments and detect requirement changes on resumed conversations.
- Provide verified workspace context, focused-test guidance, and a configurable cooperative investigation budget.
- Report exact tool repeats and unchanged results in run efficiency diagnostics.
- Guide shared feature worktree handoffs and reconciled recovery; expose missing-task wakes clearly.
- Use the supported `unknown` billing type while preserving unpriced CLI usage, and grant verified Git metadata access for Paperclip-linked worktrees.
- Add regression tests and the OTP efficiency audit. Subscription quota savings remain unmeasured; no hard token cap is claimed.

## 0.4.2 — Actionable runtime permission diagnostics

- Explain how to resolve the conflict between AGY's `always-proceed` runtime and `allowUnattendedRuntime=false`, while retaining permission-denied classification and authorization checks.
- Keep test fixture journals in temporary directories instead of the operator's Paperclip trace directory.

## 0.4.1 — Runtime Permission Policy Authorization & Structured Error Classification

- **Unattended Stream-JSON Authorization**: Real headless `agy` processes emit `init.permission_mode === 'always-proceed'`. Authorized unattended execution across planning mode (`executionMode === 'planning'`), issue-scoped worktrees (`cfg.approvedIssueIds`), and verified legacy fixed workspaces.
- **Configurable `allowUnattendedRuntime`**: Added `allowUnattendedRuntime` toggle (default: `true`) to `configSchema.fields` and normalized configuration, aligning with Paperclip's unattended design while allowing operators to disable auto-approvals when required.
- **Structured Error Classification**: Upgraded runtime permission policy failures and denials to emit structured `errorCode: 'permission_denied'` and `errorFamily: 'permission'`, preventing uninformative generic `adapter_failed` errors.
- **Comprehensive Permission Policy Test Suite**: Added dedicated regression coverage in `test/permission-policy.test.js` validating planning mode, issue-authorized implementation, fixed workspaces, and explicit failure when `allowUnattendedRuntime: false`.

## 0.4.0 — Production Parity: Auth Lifecycle, Credential Readiness, Prompt Bundles & Diagnostics

- **Credential Lifecycle & Cache**: Multi-tenant company-scoped auth cache (`src/lib/auth-cache.js`) with atomic file swaps, 0700/0600 modes, path traversal guards, and `withDirectoryMergeLock`.
- **Auth Precedence**: 4-tier precedence resolver (`configured_api_key` > `host_keychain` > `cached_company_auth` > `sandbox_auth_json`) with shadowing detection (`src/lib/auth-precedence.js`).
- **Pre-Dispatch Credential Readiness**: Pre-check evaluator (`src/lib/credential-readiness.js`) enabling Paperclip UI to gate agent launch pre-flight and surface login requirements immediately.
- **Teardown Auth Copyback**: `copyBackAntigravityAuth` installing strictly-newer sandbox credentials back to host default stores on teardown with clock-skew detection (`src/lib/auth-cache.js`).
- **Headless Device Login Runner**: PTY-based interactive pairing driver (`src/server/login-runner.js`) parsing Google OAuth device codes and URLs.
- **Prompt Bundle Caching & Skills Symlinks**: SHA-256 fingerprinting of instructions and skills with materialized symlinks under `.agents/skills/` (`src/lib/prompt-bundle-cache.js`), wired into `src/server/execute.js`.
- **Output Inactivity Monitor**: Configurable activity monitor (`src/lib/inactivity-monitor.js`) with SIGTERM and SIGKILL escalation grace.
- **Safe Probe Diagnostics**: Structured diagnostic loggers and strict Google OAuth URL normalizers preventing credential leaks in UI check messages (`src/lib/probe-diagnostics.js`).
- **Canonical UI Config Builder**: `./ui` package export exposing `buildAntigravityLocalConfig` for standard Paperclip forms (`src/ui/build-config.js`).
- **Canonical Check Codes**: Emits canonical `adapter_auth_missing` check code on missing auth.

## 0.3.3 — execution trace journal, backpressure and offline viewer

- Add append-only JSONL execution journal (`src/lib/journal.js`) at `~/.paperclip/antigravity-traces/<hash>.jsonl`.
- Record detailed lifecycle and tool invocation tracing (`tool.started`, `tool.completed`, `tool.interrupted`) with sanitized arguments/output and token redaction.
- Add backpressure queue metrics and high/low stream watermarks in `src/lib/process.js` to guard against unbounded memory buffers.
- Add offline trace viewer generator (`scripts/trace-report.mjs`) exporting searchable self-contained HTML reports.
- Expand `parseStdoutLine` to capture target, startedAt, durationMs, and error fields from tool lifecycle events.

## 0.3.1 — fast deterministic test harness

- Move live model discovery after host execution-target, assigned-workspace, authorization and clean-worktree guards.
- Add injection-only unit-test model-discovery seam; production entry point still discovers models from the actual `agy` CLI.
- Enable model validation in fixture configurations, with a deterministic fake model source for pure adapter tests.
- Add fast-model discovery and preflight ordering regressions.
- Add `npm run doctor` to fail early on mixed archive versions and the obsolete pricing signature.
- Keep v0.3.0 account-sync, model selection, transcript, quota and usage corrections.

# 0.3.0 — Native account/model/usage reliability update

- Replaces credential rotation with read-only account observation. Provides an opt-in AGY `/statusline` script and native Paperclip `getQuotaWindows` hook.
- Binds resumed sessions to current model, account, task and workspace; persists cumulative tokens for per-run deltas.
- Corrects broken `estimateCostUsd(model, usage)` call in the execution adapter. CLI costs are marked `unpriced` until authoritative billing exists; the separate pricing module retains its own provider-specific API.
- Adds true model combobox field, live model revalidation, checkpoint/usage timeline events, safe telemetry redaction, and bounded per-tool output.
- Atomic private on-disk metadata, serialized pool writes, explicit corruption/lock errors, and sanitized v1 registry migration.
- Eliminates automatic 429 account switching/replays. Leaves credentials to the AGY CLI authentication flow.
- Adds tests for account sync, model drift, quota, corrupt registry, concurrency, usage baseline, privacy and session changes.

Outstanding: real TUI + actual Paperclip installation smoke tests; multi-host credential affinity; frontend account status push outside runs; full private model reasoning cannot be surfaced if the CLI does not emit it.
