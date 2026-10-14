# YourClientDesk — Paperclip execution optimization

This is an **unofficial patch** to the supplied Antigravity adapter v0.3.2.
It is not verified against an installed, authenticated Antigravity or Paperclip host.

## Changes implemented in the adapter

- `promptPolicy: compact_resume` (default) sends the full instructions on the first turn and on legacy/unverifiable sessions; verified resumed conversations receive a concise continuation plus new task details and the *current* ephemeral skill paths.
- `promptPolicy: full_every_turn` restores the original prompt strategy for A/B comparison or troubleshooting.
- `sessionParams` tracks a fingerprint of approved agent instructions, staged skill metadata and core task context. Changing approved role instructions forces a new conversation; changing a task description sends the new description within the resumed conversation.
- `resultJson.promptStats` reports the prompt mode and UTF-8 bytes per run for controlled measurement; the trace `cli_execution` phase also records this information.
- First-turn team collaboration guidance now specifies one implementation owner, dependency-aware handoffs, a concise status contract, and a stop-on-blocker rule.

These patches **do not** guarantee that the CLI actually reduces metered input tokens, because resumed conversations may replay earlier conversational history. Measure promptStats together with usage inputTokens and cache-read tokens on real runs. The adapter does not control AGY's internal context compaction or model billing.

## Team protocol (must be configured in Paperclip; adapter cannot enforce it)

**Feature workspace.** Children of one feature umbrella should explicitly reuse one designated, registered secondary Git worktree and integration branch. Set `executionWorkspaceId` to that workspace and `executionWorkspacePreference: reuse_existing` with `executionWorkspaceSettings.mode: reuse_existing` on the children. A parent relationship alone does not guarantee workspace sharing. Keep the project default isolated so unrelated features remain separate. Preserve and reconcile existing child commits before rebinding; stop active writers first. Use the parent issue for shared decisions, interface contracts and accepted commit handoffs, while keeping conversations task-scoped. Serialize writers or explicitly assign disjoint file scopes. The adapter validates the supplied checkout but cannot schedule writers or enforce umbrella membership.

**Task assignment.** The Delivery Lead assigns one implementation owner to each issue and defines acceptance criteria, writable file scope, dependencies and expected test commands. A review or QA agent may read the issue and repo but must not independently implement the same change without an explicit transfer.

**Before implementation.** The owner checks issue status, latest handoff, existing branch/commits and current tests. If requirements are already met, they verify and report rather than implementing the feature a second time.

**Cross-domain changes.** The upstream agent publishes the API/schema/interface contract first, including version, types, paths, error responses and the commit that establishes it. The dependent agent starts only after this contract is available. If a contract changes, link the change to the existing issue and notify dependent owners rather than opening a parallel implementation.

**Blockers.** Post one `BLOCKED` comment naming the exact dependency/decision and next owner. Stop the agent until the dependency is resolved. Avoid periodic polling, broad re-research and speculative workarounds.

**Handoff comment schema:**

```text
STATUS: READY_FOR_QA | BLOCKED | NEEDS_REVIEW | COMPLETE
OWNER: role or agent ID
BRANCH/COMMIT: branch + SHA
FILES: changed file paths or module names
INTERFACES: changed APIs/database contracts (or none)
TESTS: commands, pass/fail, remaining gaps
BLOCKERS: exact missing dependency (or none)
NEXT OWNER: role or agent ID
```

**QA/release gates.** QA is independent of implementation. Verify the integrated branch and critical workflows. Deployments and migrations remain human-authorized under existing Paperclip/AGY guards.

## Operational measurement

For a short pilot, use 5–10 representative tasks and record per run:

- Input, output and cache-read token deltas (do not treat subscription token counters as USD billing).
- `promptStats.mode`, `promptStats.bytes`, and number of wakeups per issue.
- Repeated repository reads/searches, repeated tool targets and duplicate change attempts from the JSONL journal.
- Number of issue handoffs, blockers, misrouted tasks, failed resumes and worktree conflicts.
- End-to-end delivery and independent QA result.

Compare the same task classes under `compact_resume` and `full_every_turn`. Don't use two concurrent agents to run the *same* mutation as an A/B test.

## Known gaps and rollout conditions

1. **No Paperclip issue/task lock in this patch.** Enforce one active implementation owner at the host scheduler/issue level. The adapter does not claim a task atomically and cannot prevent another agent using a different adapter from duplicating work.
2. **No runtime event bus added.** Agent-to-agent communication depends on Paperclip issue comments and dependency-aware scheduling, which must be configured in the Paperclip host and individual agent instructions.
3. **No reliable USD cost claims.** The AGY CLI is not an authoritative provider billing interface.
4. **No production verification.** Run `npm ci`, `npm run doctor`, `npm run check`, `npm test`, `npm run models:check` and `npm run smoke` with a trusted authenticated worker before deployment.
5. **Sensitive transcripts.** Do not share raw traces without redaction; they may contain task contents and tool outputs. Apply retention limits to `~/.paperclip/antigravity-traces`.

## Rollback

Stop the plugin, restore the original adapter folder and restart/reload the external adapter. As a lower-risk first response to a compact-resume problem, set `promptPolicy: full_every_turn` in agent configuration. Keep your original package and account state backups. Do not loosen implementation approvals or sandbox settings.

## Recovery and billing compatibility

A shutdown-interrupted run must be reconciled through Paperclip's recovery action API using observed action outcomes before a successor is queued. Recovery prompts explicitly preserve completed work and use the current assigned workspace. Agent-level wakes without a task ID remain idle and tell the user to run from the issue; they do not implement in a fallback agent home.

CLI runs emit the host-supported `billingType: unknown` with `costStatus: unpriced`. The former adapter-specific `external_cli_unverified` value is not accepted by Paperclip cost receipts. Persisted historical receipts need the host accounting compatibility mapping before retrying through the accounting API; do not invent a dollar cost or subscription classification.

For Paperclip-assigned linked worktrees, the adapter adds the verified Git common directory to AGY's workspace so Git can access objects and worktree indexes outside cwd, without adding the primary source checkout. Paperclip dev watch must exclude registered adapter local paths (including canonical symlink targets); reload adapter updates only after active runs stop.
