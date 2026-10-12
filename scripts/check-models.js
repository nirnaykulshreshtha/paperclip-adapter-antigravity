#!/usr/bin/env node
// Diagnostics only: queries `agy models` live; no AI inference, file writes,
// cached catalog, or backup list.
import { discoverAgyModels } from '../src/lib/models.js';
try {
  const models = await discoverAgyModels();
  console.log(`Discovered ${models.length} live Antigravity account model(s):`);
  for (const model of models) console.log(`${model.id}\t${model.label}`);
} catch (err) {
  console.error(`Live model discovery failed: ${err.message}`);
  if (err.cause?.message) console.error(`Underlying CLI error: ${String(err.cause.message).slice(0, 500)}`);
  process.exitCode = 1;
}
