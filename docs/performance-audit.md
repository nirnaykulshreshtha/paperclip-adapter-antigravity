# Adapter performance audit — 14 October 2026

Read-only analysis of 87 local journals containing process.exit performance metrics, plus the current execution code. This is a historical mixed workload, not a controlled benchmark of the current revision. Failed runs before process.exit are excluded. Percentiles use the sorted observation at floor(n × percentile).

| Measurement | Median | P95 | Maximum |
| --- | ---: | ---: | ---: |
| Preflight | 5.148 s | 7.760 s | 11.546 s |
| Model validation phase | 4.970 s | 7.229 s | 9.361 s |
| Workspace validation | 47 ms | 94 ms | 383 ms |
| Skills and instructions | 4 ms | 47 ms | 136 ms |
| Account detection | 118 ms | 393 ms | 1.405 s |
| CLI execution, including event processing | 308.675 s | 905.110 s | 1278.022 s |
| Peak event queue wait per run | 112 ms | 4.021 s | 42.652 s |
| From performance snapshot to terminal record | 116 ms | 825 ms | 3.068 s |

## Priorities

1. **Live model discovery dominates startup.** execute.js awaits discoverAgyModels before dispatch, enabled by default. models.js coalesces simultaneous discovery but performs a fresh CLI/PTY lookup for each subsequent request. The phase also includes branch freshness for implementation runs, so add a dedicated discovery timer before assigning its entire duration to discovery. Preserve account-sensitive model authorization; a blind TTL cache could approve a model from the wrong account. Consider sharing one verified discovery result within an explicit account observation generation, with invalidation on credential/account changes.
2. **Serialized event consumers cause occasional long latency.** process.js awaits each handler in order. execute.js awaits a journal write for every raw event, then log/progress/event callbacks; assistant text updates trigger progress on every delta. The worst observed run queued 350 callbacks, peaked at depth 22, and had a 42.652 s peak wait. Another reached depth 128 and paused streams. Instrument handler duration separately for journal, onLog, onEvent and onRuntimeProgress; coalesce replaceable progress updates and batch journal writes while retaining ordered audit records, error propagation and terminal flush. Queue wait is not additive runtime overhead: many events wait concurrently, and provider/tool activity can overlap it.
3. **Account checks repeat work.** execute.js reads status, detects the account, calls syncKeychainToPool (which detects again), then separately reads the headless keychain. Pool synchronization loads state repeatedly and performs durable writes. Reuse one per-run observation where semantically equivalent, retain the independent headless identity check, and avoid unnecessary pool writes. Measured impact is much smaller than model discovery.
4. **Prompt cache preparation is unused.** execute.js awaits preparePromptBundle but discards its returned paths; the CLI uses the separately copied temporary skill bundle and inline instructions. Remove this work from execution after verifying no external consumer relies on its side effects. Historical preparation costs are small; do not prioritize a large skill-cache redesign on this evidence.
5. **Finalization is incompletely measured.** harness.performance is emitted near the start of finalization, before account-monitor shutdown, pricing, worktree checks, terminal writes and finally cleanup. Cold official pricing fetches have a 12 s timeout. Add a full return/cleanup timing record and separate pricing timing. The table's post-snapshot interval excludes finally cleanup.

The dominant overall interval is CLI execution (median about 5.1 minutes). Existing telemetry cannot separate provider thinking, tools, network waits and adapter callbacks. Reducing startup alone will have a modest effect on typical long tasks, while improving short wakes more substantially.

## Reproduce

Run `node scripts/performance-summary.mjs [trace-directory]`. Output contains only aggregate timing metrics. No live AGY turn, credential access or network request is needed.

## Implemented changes

- Execution validation now reuses evidence for 60 seconds with a freshly read credential digest, known account, valid expiry and unchanged executable metadata. Account/credential changes invalidate reuse, as do explicit live refreshes and observed auth/quota failures. Cold discovery rechecks credentials before accepting its result. A successful provider turn renews evidence for the selected model only, allowing immediate continuation after a long turn. This does not eliminate cold startup or assume that catalogs never change.
- Text delivery batches adjacent deltas at 8 KiB/100 ms and coalesces progress snapshots. Lifecycle boundaries flush the batch. A bounded ordered publication queue overlaps host persistence with CLI execution, retains logs/events, applies backpressure and reports callback failures. Completion waits for publication.
- Journals batch writes at 64 KiB/25 ms. Terminal boundaries flush and fsync. An abrupt crash can lose a small pending nonterminal buffer; normal completion, failure and cancellation flush it. Terminal reserve now accounts for the truncation marker as well as lifecycle records.
- Account observations are reused within a run, pool updates avoid redundant writes for an unchanged observation within 60 seconds, and execution no longer prepares an unused persistent prompt cache.
- Verified conversation sessions carry at most 64 hashed request/result signatures each. Repeat guidance can now span resumed turns, while tool execution and acceptance checks remain under provider control. Actual skill content digests prevent stale policy reuse when references change.
- Metrics separate model lookup, account observation, pool synchronization, pricing, callback totals/maxima, ordered publication backlog and process handler/drain time. A final timing record includes skill/auth/lease cleanup before journal close. These measurements allow live attribution of future stalls.

## Controlled benchmark

Run `npm run perf:benchmark` in the Git checkout. It compares the committed journal with the working implementation and simulates a burst of 1,000 deltas/progress snapshots with 1 ms per persistence callback. It asserts text preservation and journal order, uses temporary files, and performs no live AGY turn.

One local run on Node 24.21.0 produced:

| Workload | Before | After |
| --- | ---: | ---: |
| Journal, 1,001 records | 1,001 writes / 44 ms | 7 writes / 12 ms |
| Response burst | 2,000 callbacks / 2,791 ms | 6 callbacks / 22 ms |

These are controlled adapter-overhead measurements, not end-to-end provider speedups. Filesystem/timer scheduling varies; steady live output may flush more batches than a burst. Integration tests additionally verify two immediate executions perform one model discovery, explicit refresh forces another lookup, credential/binary changes reject reuse, all 1,000 raw delta events remain in the journal, and repeat history survives verified resume/serialization.
