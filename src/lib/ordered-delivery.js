/** Ordered persistence independent of CLI parsing, with bounded backpressure. */
export function createOrderedDelivery(write, { maxItems = 64, maxBytes = 256 * 1024 } = {}) {
  const queue = [];
  let bytes = 0, pending = null, failure = null;
  const metrics = { accepted: 0, delivered: 0, peakItems: 0, peakBytes: 0, backpressureCount: 0 };
  const check = () => { if (failure) throw failure; };
  const drain = () => {
    if (pending) return pending;
    // Start in a microtask so pending is assigned before a synchronous callback fails.
    pending = Promise.resolve().then(async () => {
      while (queue.length) {
        const item = queue[0];
        await write(item.value);
        queue.shift(); bytes -= item.bytes; metrics.delivered++;
      }
    }).catch(error => { failure ||= error; }).finally(() => {
      pending = null;
      if (queue.length && !failure) void drain();
    });
    return pending;
  };
  const flush = async () => {
    do { await drain(); check(); } while (pending || queue.length);
  };
  return {
    async append(value) {
      check();
      const itemBytes = Buffer.byteLength(JSON.stringify(value));
      // Include the active callback in the budget. Producers await before adding
      // another item, rather than creating an unbounded chain of closures.
      while (queue.length && (queue.length >= maxItems || bytes + itemBytes > maxBytes)) {
        metrics.backpressureCount++;
        await flush();
      }
      check();
      queue.push({value,bytes:itemBytes});bytes += itemBytes;metrics.accepted++;
      metrics.peakItems=Math.max(metrics.peakItems,queue.length);metrics.peakBytes=Math.max(metrics.peakBytes,bytes);
      void drain();
    },
    check, flush, snapshot: () => ({...metrics}),
  };
}
