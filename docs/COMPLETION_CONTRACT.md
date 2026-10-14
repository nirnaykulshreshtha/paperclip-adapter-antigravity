# Completion-driven execution contract

Paperclip's durable continuation scheduler distinguishes a finite heartbeat run from the issue lifecycle. Open work resumes through persisted host state. The issue's durable disposition, review/approval state, blockers and continuation ownership are authoritative; narrative alone cannot select a completed outcome.

## Runtime policy

- `timeoutPolicy: completion` is the default. Legacy positive `timeoutSec` values do not create a deadline under this policy.
- `timeoutPolicy: bounded` requires an explicit positive `timeoutSec`. The adapter owns that single deadline.
- AGY receives `--print-timeout 0` in both policies. This prevents a second CLI deadline from auto-finalizing a response while the adapter is terminating execution.
- The process timer exists only for positive resolved durations. Cancellation, output-inactivity monitoring, provider errors, permissions and approvals retain their separate semantics.
- A CLI-observed conversation and usage baseline survive a timeout/cancellation when available. Paperclip decides whether a later continuation is authorized; the adapter never retries a side-effectful turn itself.
- Results use Paperclip's existing `adapterExecutionTimeout` receipt (`timeoutSec` and `source`) so host run metadata reports the actual resolved policy, rather than a legacy saved limit.

## Completion authority

Provider `SUCCESS` means that an AGY turn finished; it does not prove arbitrary issue acceptance criteria. The adapter does not infer issue completion from elapsed time or prose such as “done.” Paperclip owns the durable issue disposition and host continuation.

Fresh and resumed instructions require a verification record for every acceptance criterion. Required background commands must finish, and their exit status and relevant output must be inspected. Unverified checks remain unverified. Required review uses `in_review`; real unmet dependencies use `blocked`. `done` requires no remaining required work or follow-up.

This adapter cannot independently certify free-form acceptance criteria. Stronger automated acceptance requires machine-executable checks and the task's configured review/approval gates; prompt instructions are not a substitute for those controls.

## Validation

The regression suite verifies unlimited execution waits for the actual terminal result, explicit bounded execution cancels correctly, old 900-second values resolve to unlimited under completion policy, AGY receives no competing deadline, timeout receipts match Paperclip's contract, and interrupted/resumed turns preserve their conversation and usage baseline.

Local Paperclip references examined: `doc/architecture/durable-continuation-scheduler.md`, `doc/plans/2026-09-22-legacy-continuation-authority.md`, `skills/paperclip/SKILL.md`, `packages/adapter-utils/src/server-utils.ts`, and `server/src/services/heartbeat-stop-metadata.ts`.
