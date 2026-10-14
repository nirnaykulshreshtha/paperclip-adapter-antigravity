import { createHash } from 'node:crypto';
const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
const hash = v => createHash('sha256').update(v).digest('hex');
const MAX_HISTORY = 64;
export function normalizeRepeatHistory(value) {
  const valid = (entries, pattern) => Array.isArray(entries) ? entries.slice(-MAX_HISTORY)
    .filter(entry => Array.isArray(entry) && entry.length===2 && typeof entry[0]==='string' && pattern.test(entry[0]) && Number.isSafeInteger(entry[1]) && entry[1]>0)
    .map(([key,count])=>[key,Math.min(count,1_000_000)]) : [];
  return {requests:valid(value?.requests,/^[0-9a-f]{64}$/),results:valid(value?.results,/^[0-9a-f]{64}:[0-9a-f]{64}$/)};
}
const increment = (map,key) => {
  const count = Math.min((map.get(key) ?? 0)+1,1_000_000);
  map.delete(key); map.set(key,count);
  if(map.size>MAX_HISTORY)map.delete(map.keys().next().value);
  return count;
};

/** Observes repeats; never blocks a tool or treats legitimate rereads as failures. */
export function createEfficiencyTracker(history) {
  const prior = normalizeRepeatHistory(history);
  const calls = new Map(), completed = new Set(), signatures = new Map(prior.requests), results = new Map(prior.results);
  const stats = { toolCalls: 0, completedToolCalls: 0, failedToolCalls: 0, exactRepeatCalls: 0, unchangedRepeatResults: 0, toolOutputBytes: 0 };
  return {
    start(id, name, parameters) {
      if (calls.has(id)) return;
      const key = hash(JSON.stringify([name, stable(parameters)]));
      calls.set(id, key); stats.toolCalls++;
      const count = increment(signatures,key);
      if (count > 1) stats.exactRepeatCalls++;
    },
    complete(id, output, failed) {
      if (completed.has(id) || !calls.has(id)) return false;
      completed.add(id); stats.completedToolCalls++;
      if (failed) stats.failedToolCalls++;
      stats.toolOutputBytes += Buffer.byteLength(output, 'utf8');
      const key = calls.get(id) + ':' + hash(output);
      const count = increment(results,key);
      if (count > 1) stats.unchangedRepeatResults++;
      return count === 3;
    },
    snapshot: () => ({ ...stats }),
    history: () => ({requests:[...signatures],results:[...results]}),
  };
}
