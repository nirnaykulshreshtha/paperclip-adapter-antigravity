import { mkdir, open, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

// Append-only, run-scoped trace. Never use a raw run id as a path component.
export function journalPath(runId, root = path.join(os.homedir(), '.paperclip', 'antigravity-traces')) {
  const id = createHash('sha256').update(String(runId ?? '')).digest('hex').slice(0, 32);
  return path.join(root, `${id}.jsonl`);
}
export async function createJournal({runId, root, token, maxBytes = 32 * 1024 * 1024} = {}) {
  const file = journalPath(runId, root);
  await mkdir(path.dirname(file), {recursive:true, mode:0o700});
  const handle = await open(file, 'a+', 0o600);
  let size = (await stat(file)).size, seq = 0, chain = Promise.resolve(), truncated = false, closed = false;
  // A retried run ID may reopen an existing journal. Preserve monotonic
  // sequence IDs instead of restarting at 1 and confusing the history viewer.
  if (size > 0) {
    const tailSize = Math.min(size, 8192);
    const buffer = Buffer.alloc(tailSize);
    const {bytesRead} = await handle.read(buffer, 0, tailSize, size - tailSize);
    const tail = buffer.subarray(0,bytesRead).toString('utf8').trimEnd().split('\n');
    for (let i = tail.length - 1; i >= 0; i--) {
      try { const prior = JSON.parse(tail[i]); if (Number.isSafeInteger(prior.sequence)) { seq = prior.sequence; break; } }
      catch { /* partial leading line; examine earlier complete record */ }
    }
  }
  // Retain space for a failure or completion record even if verbose CLI output
  // exceeds the configured trace cap.
  const terminalReserve = Math.min(64 * 1024, Math.floor(maxBytes / 8));
  const terminalKinds = new Set(['run.terminal', 'run.exception', 'process.exit']);
  const sanitize = (value, depth = 0) => {
    if (depth > 10) return '[DEPTH_LIMIT]';
    if (typeof value === 'string') {
      let s = value;
      if (typeof token === 'string' && token.length > 4) s = s.replaceAll(token, '[REDACTED_TOKEN]');
      s = s.replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]')
        .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*)[^\s,'\"}]+/gi, '$1[REDACTED]');
      return s.length > 262144 ? s.slice(0,262144) + '[TRUNCATED]' : s;
    }
    if (Array.isArray(value)) return value.slice(0, 100).map(v => sanitize(v,depth+1));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key,v] of Object.entries(value).slice(0,100)) out[key] = /password|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key/i.test(key) ? '[REDACTED]' : sanitize(v,depth+1);
      return out;
    }
    return value;
  };
  const append = (kind, data = {}) => {
    if (closed) return Promise.reject(new Error('Execution journal is already closed'));
    const item = {schema:'agy.trace.v1', runId:String(runId ?? ''), sequence:++seq, timestamp:new Date().toISOString(), kind, data:sanitize(data)};
    chain = chain.catch(() => {}).then(async () => {
      const terminalEvent = terminalKinds.has(kind);
      if (truncated && !terminalEvent) return;
      const line = JSON.stringify(item) + '\n';
      const bytes = Buffer.byteLength(line);
      const limit = terminalEvent ? maxBytes : maxBytes - terminalReserve;
      if (size + bytes > limit) {
        if (!truncated && !terminalEvent) {
          truncated = true;
          const marker = JSON.stringify({schema:'agy.trace.v1',runId:String(runId??''),sequence:++seq,
            timestamp:new Date().toISOString(),kind:'journal.truncated',
            data:{reason:'trace size limit; terminal events still reserved'}})+'\n';
          const markerBytes = Buffer.byteLength(marker);
          if (size + markerBytes <= maxBytes) { await handle.writeFile(marker); size += markerBytes; }
        }
        return;
      }
      await handle.writeFile(line);
      size += bytes;
      if (terminalEvent) await handle.sync();
    });
    return chain;
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await chain; await handle.sync(); }
    finally { await handle.close(); }
  };
  return {file, append, close};
}
