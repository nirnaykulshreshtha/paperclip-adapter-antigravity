import { createHash } from 'node:crypto';
const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
const hash = v => createHash('sha256').update(v).digest('hex');

/** Observes repeats; never blocks a tool or treats legitimate rereads as failures. */
export function createEfficiencyTracker() {
  const calls = new Map(), completed = new Set(), signatures = new Map(), results = new Map();
  const stats = { toolCalls: 0, completedToolCalls: 0, failedToolCalls: 0, exactRepeatCalls: 0, unchangedRepeatResults: 0, toolOutputBytes: 0 };
  return {
    start(id, name, parameters) {
      if (calls.has(id)) return;
      const key = hash(JSON.stringify([name, stable(parameters)]));
      calls.set(id, key); stats.toolCalls++;
      const count = (signatures.get(key) ?? 0) + 1;
      signatures.set(key, count);
      if (count > 1) stats.exactRepeatCalls++;
    },
    complete(id, output, failed) {
      if (completed.has(id) || !calls.has(id)) return false;
      completed.add(id); stats.completedToolCalls++;
      if (failed) stats.failedToolCalls++;
      stats.toolOutputBytes += Buffer.byteLength(output, 'utf8');
      const key = calls.get(id) + ':' + hash(output);
      const count = (results.get(key) ?? 0) + 1;
      results.set(key, count);
      if (count > 1) stats.unchangedRepeatResults++;
      return count === 3;
    },
    snapshot: () => ({ ...stats }),
  };
}
