# Changelog

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
