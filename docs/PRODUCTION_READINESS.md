# Production readiness — v0.5.2

The reference is the locally installed Paperclip adapter contract and its Codex-local, Gemini-local and Cursor-cloud implementations. Their newer native runner/ACP code is not interchangeable with AGY's stream-JSON protocol.

| Capability | Antigravity implementation |
| --- | --- |
| Local task execution | Stream-JSON CLI; verified secondary Git worktree; host-issued JWT; planning/implementation authorization |
| Shared feature worktree | One implementation writer per Paperclip instance through the SDK's cross-process directory lock; planning still requires a clean checkout |
| Ownership after worker loss | Private controller/CLI PID and process-group receipt; unknown dispatch or surviving provider blocks a new writer |
| Session continuity | Task/workspace/model/policy binding; account handoff with the same conversation; quota-limited sessions retained |
| Retry behavior | No automatic rerun, credential rotation or account switching inside the adapter; host owns scheduling and reconciliation |
| Models and credentials | Live model catalog; credential observation/readiness; explicit credential promotion guarded by identity and freshness |
| Health checks | Successful probes isolated by company/account; unknown identity is not cached; hello probes can consume quota when `probeAuthentication=true` (the default) |
| Usage/cost | Per-run usage deltas where a baseline exists; unavailable usage stays unavailable; dynamically fetched official Google Standard rates produce API-equivalent estimates; actual CLI spend remains unverified |
| Observability | Bounded sanitized transcripts, lifecycle/performance events, tool-repeat counters, failure classification |
| Hosted/SSH/cloud execution | Unsupported; a separate backend needs provider leases, credential delivery, workspace round-trip/finalization and cancellation receipts |
| Native detached runner adoption | Unsupported; existing legacy shutdown recovery requires observed outcomes and host reconciliation |

## Ownership and recovery

Implementation takes the workspace lease before model discovery or dispatch and releases it after verified CLI termination and cleanup. Canonical paths ensure aliases share a lock. Receipts live under the Paperclip instance's private `antigravity-workspace-owners` directory, outside the repository.

The SDK lock alone cannot prove that a detached CLI stopped after its controller died. The durable receipt therefore records dispatch before spawn, then the CLI PID/group. A live group or an unknown spawn outcome produces `workspace_busy` rather than starting another paid turn. Cancellation while waiting never launches a provider. A pre-provider busy failure is retryable; a surviving provider after dispatch requires reconciliation.

For an orphan receipt, stop/inspect the exact recorded CLI and process group, verify workspace changes and external action outcomes, and use Paperclip's recovery workflow. Only after confirming that execution stopped may an operator remove the exact retained ownership receipt. Do not delete receipts based on age or a dead controller alone. Background services must be managed by Paperclip; independent processes outside the known CLI group are not covered by this lease.

Quota preservation retains the CLI-observed conversation and its cumulative usage baseline, including on an interrupted first turn. An account change resumes that conversation within the same task and workspace; it does not replay the turn inside the adapter invocation or treat partial work as complete. Host quota recovery uses the provider reset deadline and brings waiting work forward when a different credential identity is observed. Auth failures, unknown accounts and changed policy/model/workspace keep their existing reset/reconciliation gates. Cross-account provider support still requires a live authenticated canary; fixtures prove adapter behavior, not provider acceptance.

## Validation and deployment

The offline CI template at `docs/ci/github-actions-test.yml` defines fixture tests and package checks on Linux and macOS with Node 24. It is not active: installing it at `.github/workflows/test.yml` requires a GitHub credential with workflow write permission. Windows CLI behavior is not certified by that matrix. No real account or provider turn is required by CI.

Before rollout, run an authenticated canary against the actual installed AGY/Paperclip versions: two implementation agents sharing one worktree, cancellation, provider quota exhaustion, controller loss with a surviving child, account change, transcript redaction and usage accounting. Verify required acceptance checks and the feature's existing release gates. Compare actual run counters and provider-reported quota observations; tool-repeat percentages are not token-saving percentages.

Reload only when active runs have settled. Keep legacy shutdown holds until action outcomes are reconciled. Publishing the package or adding remote transport does not make legacy AGY invocations hot-restartable.
