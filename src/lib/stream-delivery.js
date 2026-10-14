/** Coalesce replaceable progress and adjacent text, preserving lifecycle order. */
export function createStreamDelivery({ onText, onProgress, intervalMs = 100, maxTextBytes = 8192 }) {
  let text = '', textBytes = 0, progress = null, timer = null, pending = null, error = null;
  let closed = false;
  const metrics = { textDeltas: 0, textBatches: 0, progressUpdates: 0, progressDelivered: 0 };
  const check = () => { if (error) throw error; if (closed) throw new Error('Stream delivery closed'); };
  const flush = async () => {
    clearTimeout(timer); timer = null;
    if (pending) await pending;
    if (error) throw error;
    if (pending) return flush();
    const batch = text, snapshot = progress;
    text = ''; textBytes = 0; progress = null;
    if (!batch && !snapshot) return;
    pending = (async () => {
      if (batch) { await onText(batch); metrics.textBatches++; }
      if (snapshot && onProgress) { await onProgress(snapshot); metrics.progressDelivered++; }
    })().catch(err => { error ||= err; }).finally(() => { pending = null; });
    await pending;
    if (error) throw error;
  };
  const schedule = () => {
    if (!timer) {
      timer = setTimeout(() => { void flush().catch(() => {}); }, intervalMs);
      timer.unref?.();
    }
  };
  return {
    async text(delta) {
      check(); metrics.textDeltas++;
      text += delta; textBytes += Buffer.byteLength(delta);
      if (textBytes >= maxTextBytes) await flush(); else schedule();
    },
    progress(value) { check(); metrics.progressUpdates++; progress = value; schedule(); },
    flush,
    async close() { try { await flush(); } finally { closed = true; clearTimeout(timer); } },
    snapshot: () => ({ ...metrics }),
  };
}
