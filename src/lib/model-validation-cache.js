/** Short-lived, credential-scoped validation. UI refreshes remain live. */
export function createModelValidationCache({ ttlMs = 60_000, maxEntries = 32, now = Date.now } = {}) {
  const entries = new Map(), flights = new Map();
  let generation = 0;
  const remember = (key, models) => {
    if (entries.size >= maxEntries && !entries.has(key)) entries.delete(entries.keys().next().value);
    entries.set(key, { models: structuredClone(models), expiresAt: now() + ttlMs });
  };
  return {
    clear() { generation++; entries.clear(); flights.clear(); },
    async get(key, load) {
      // Unknown or expired credentials must never authorize reuse.
      if (!key) return { models: await load(), cacheHit: false };
      const cached = entries.get(key);
      const epoch = generation;
      const result = (models, cacheHit) => ({ models: structuredClone(models), cacheHit,
        // A successful provider turn is fresh evidence for its selected model only.
        confirm: model => { if (generation === epoch && models.some(entry=>entry.id===model)) remember(key,models.filter(entry=>entry.id===model)); },
      });
      if (cached && now() < cached.expiresAt) return result(cached.models,true);
      entries.delete(key);
      if (flights.has(key)) return flights.get(key);
      const flight = (async () => {
        const models = await load();
        if (!Array.isArray(models) || !models.length) throw new Error('No models available for validation');
        if (generation === epoch) {
          remember(key,models);
        }
        return result(models,false);
      })();
      flights.set(key, flight);
      try { return await flight; }
      finally { if (flights.get(key) === flight) flights.delete(key); }
    },
  };
}
