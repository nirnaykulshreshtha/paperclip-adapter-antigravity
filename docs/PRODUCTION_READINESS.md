# Production readiness — v0.5.0

The reference is the locally installed Paperclip adapter contract and its Codex-local, Gemini-local and Cursor-cloud implementations. Their newer native runner/ACP code is not interchangeable with AGY's stream-JSON protocol.

| Capability | Antigravity implementation |
| --- | --- |
| Local task execution | Stream-JSON CLI; verified secondary Git worktree; host-issued JWT; planning/implementation authorization |
| Shared feature worktree | One implementation writer per Paperclip instance through the SDK's cross-process directory lock; planning still requires a clean checkout |
| Ownership after worker loss | Private controller/CLI PID and process-group receipt; unknown dispatch or surviving provider blocks a new writer |
| Session continuity | Task/workspace/account/model/policy binding; compact resume; verified quota-limited sessions retained |
| Retry behavior | No automatic rerun, credential rotation or account switching inside the adapter; host owns scheduling and reconciliation |
| Models and credentials | Live model catalog; credential observation/readiness; explicit credential promotion guarded by identity and freshness |
| Health checks | Successful probes isolated by company/account; unknown identity is not cached; hello probes can consume quota when `probeAuthentication=true` (the default) |
| Usage/cost | Per-run usage deltas where a baseline exists; unavailable usage stays unavailable; CLI spend remains unpriced |
| Observability | Bounded sanitized transcripts, lifecycle/performance events, tool-repeat counters, failure classification |
| Hosted/SSH/cloud execution | Unsupported; a separate backend needs provider leases, credential delivery, workspace round-trip/finalization and cancellation receipts |
| Native detached runner adoption | Unsupported; existing legacy shutdown recovery requires observed outcomes and host reconciliation |

## Ownership and recovery

Implementation takes the workspace lease before model discovery or dispatch and releases it after verified CLI termination and cleanup. Canonical paths ensure aliases share a lock. Receipts live under the Paperclip instance's private `antigravity-workspace-owners` directory, outside the repository.

The SDK lock alone cannot prove that a detached CLI stopped after its controller died. The durable receipt therefore records dispatch before spawn, then the CLI PID/group. A live group or an unknown spawn outcome produces `workspace_busy` rather than starting another paid turn. Cancellation while waiting never launches a provider. A pre-provider busy failure is retryable; a surviving provider after dispatch requires reconciliation.

For an orphan receipt, stop/inspect the exact recorded CLI and process group, verify workspace changes and external action outcomes, and use Paperclip's recovery workflow. Only after confirming that execution stopped may an operator remove the exact retained ownership receipt. Do not delete receipts based on age or a dead controller alone. Background services must be managed by Paperclip; independent processes outside the known CLI group are not covered by this lease.

Quota preservation keeps only the already verified conversation and its previous usage baseline; it does not automatically replay the failed turn or treat partial work as complete. Auth failures, unknown accounts, changed policy/model/workspace and unverified legacy sessions keep their existing reset/reconciliation gates.

## Validation and deployment

The offline CI template at `docs/ci/github-actions-test.yml` defines fixture tests and package checks on Linux and macOS with Node 24. It is not active: installing it at `.github/workflows/test.yml` requires a GitHub credential with workflow write permission. Windows CLI behavior is not certified by that matrix. No real account or provider turn is required by CI.

Before rollout, run an authenticated canary against the actual installed AGY/Paperclip versions: two implementation agents sharing one worktree, cancellation, provider quota exhaustion, controller loss with a surviving child, account change, transcript redaction and usage accounting. Verify required acceptance checks and the feature's existing release gates. Compare actual run counters and provider-reported quota observations; tool-repeat percentages are not token-saving percentages.

Reload only when active runs have settled. Keep legacy shutdown holds until action outcomes are reconciled. Publishing the package or adding remote transport does not make legacy AGY invocations hot-restartable.
