# Changelog

## 0.2.12 — 2026-10-12
- Open source release under canonical name `paperclip-adapter-antigravity`.
- **Branch Freshness Guard**: Automatically detects when a task worktree is behind `main` (`checkBranchFreshness`) and emits warning events to avoid merge drift.
- **Turn-End Cleanliness Guard**: Audits worktree status on implementation turn completion, emitting `worktree.dirty_warning` and reporting untracked/uncommitted files in execution telemetry.
- **Enhanced Documentation & SEO**: Complete README, architecture diagrams, and Paperclip setup guide.

## 0.2.11 — 2026-10-12
- **Dashboard Progress & Telemetry Parity**: Added comprehensive ACPX stream formatting and event emission for Paperclip live web UI.
- Detailed audit cards for active tool invocations (`run_command`, file modifications, subagent delegation).
- Subagent delegation tracking: formats `invoke_subagent` calls with role, task summary, and delegation progress.
- Live execution duration, status badges, and tool output previews.

## 0.2.6 — 2026-10-11
- Gracefully handle Paperclip unassigned heartbeat wakes without requiring an assigned task identifier or failing on worktree containment. Avoids crashing agents and wasting tokens on idle heartbeat cycles.
- Automatic stale session clearance: any failed execution when resuming with `--conversation` (including account switch or expired session) now automatically signals `clearSession: true` to purge the old conversation ID.
- Structured quota & authentication error classification: detects Google Gemini token/quota limits (`provider_quota`) and authentication/account changes (`provider_auth_error`), setting `clearSession: true` and informative guidance.
- Task switching and `forceFreshSession` in Paperclip mode start clean sessions without throwing unrecoverable session mismatches.

## 0.2.5 — 2026-10-11
- Advertise supportsLocalAgentJwt so Paperclip supplies host-issued run-scoped tokens. Fail before dispatch when the token is absent; do not silently use local-board identity.
- Added capability and missing-token regression tests. Versioned adapter factory/execute imports make this specific update reloadable without interrupting other server services.

## 0.2.4 — 2026-10-11
- Added explicit operator opt-in for the existing unattended Antigravity permission policy, only in implementation mode within an approved, verified Paperclip project worktree. Default and fixed-mode runs still reject that policy.
- Added opt-in/default rejection and wrong-project regression coverage. Terminal sandbox remains required; CLI file tools are not full OS isolation.
- Human operator explicitly approved unattended YourClientDesk runs after this limitation was explained.

## 0.2.3 — 2026-10-11
- Added explicit operator-authorized project UUIDs for implementation in verified Paperclip isolated workspaces. Individual issue allowlists remain supported. Different or missing host project identity is rejected.
- Preserved repository identity, secondary-worktree, protected-branch, task/workspace identity, sandbox and implementation-enable checks.
- Added boundary tests and a public execute test using the actual declared Paperclip helper dependency.
- Installed the previously missing pinned adapter utility dependency and generated a dependency lockfile.

Project-wide YourClientDesk implementation was explicitly approved by the human operator. This release does not authorize production deployment or remove protected-operation controls.
