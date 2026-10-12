#!/usr/bin/env node
// Opt-in AGY /statusline command. Bounded stdin, secret-free, atomic local state.
import { writeObservedStatus } from '../src/lib/statusline.js';
let raw = '';
try {
  for await (const chunk of process.stdin) {
    raw += chunk.toString('utf8');
    if (Buffer.byteLength(raw, 'utf8') > 262144) throw new Error('Oversized status payload');
  }
  const state = await writeObservedStatus(JSON.parse(raw));
  process.stdout.write(`AGY ${state.model ?? ''} · Paperclip synced\n`);
} catch {
  process.stdout.write('AGY · Paperclip status unavailable\n');
}
