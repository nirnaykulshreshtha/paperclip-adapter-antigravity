# Changelog

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
