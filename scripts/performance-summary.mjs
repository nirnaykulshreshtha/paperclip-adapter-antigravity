#!/usr/bin/env node
// Aggregate timing only: never print prompts, tool output or account identities.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(process.argv[2] || process.env.AGY_TRACE_DIR || path.join(os.homedir(), '.paperclip', 'antigravity-traces'));
const runs = [];
for (const file of await readdir(root)) {
  if (!file.endsWith('.jsonl')) continue;
  let performanceData, terminalElapsedMs, finalPerformance;
  for (const line of (await readFile(path.join(root, file), 'utf8')).split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.kind === 'process.exit' && event.data?.performance) performanceData = event.data.performance;
      if (event.kind === 'run.terminal') terminalElapsedMs = event.data?.elapsedMs;
      if (event.kind === 'run.performance.final') finalPerformance = event.data;
    } catch { /* Ignore incomplete or malformed records. */ }
  }
  if (performanceData) runs.push({ ...performanceData, terminalElapsedMs, finalPerformance });
}
function summarize(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? null;
  return { n: sorted.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? null };
}
const phases = [...new Set(runs.flatMap(run => Object.keys(run.phaseDurationsMs || {})))];
const callbacks = [...new Set(runs.flatMap(run => Object.keys(run.finalPerformance?.callbackMetrics || {})))];
console.log(JSON.stringify({
  runs: runs.length,
  preflightMs: summarize(runs.map(run => run.preflightMs)),
  cliMs: summarize(runs.map(run => run.cliDurationMs)),
  postPerformanceMs: summarize(runs.map(run => run.terminalElapsedMs - run.totalElapsedMs)),
  phases: Object.fromEntries(phases.map(phase => [phase, summarize(runs.map(run => run.phaseDurationsMs?.[phase]))])),
  queuePeakWaitMs: summarize(runs.map(run => run.eventQueue?.peakWaitMs)),
  pausedRuns: runs.filter(run => run.eventQueue?.pausedCount > 0).length,
  validationReuseRuns: runs.filter(run => run.modelValidationCacheHit).length,
  finalElapsedMs: summarize(runs.map(run => run.finalPerformance?.totalElapsedMs)),
  finalizationMs: summarize(runs.map(run => run.finalPerformance?.finalizationMs)),
  handlerMaxMs: summarize(runs.map(run => run.eventQueue?.handlerMaxMs)),
  callbackTotalMs: Object.fromEntries(callbacks.map(name => [name,summarize(runs.map(run=>run.finalPerformance?.callbackMetrics?.[name]?.totalMs))])),
}, null, 2));
