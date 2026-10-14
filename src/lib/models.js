/**
 * Live Antigravity account model discovery.
 *
 * Catalogs have exactly ONE source: `agy models`. Explicit refreshes are live.
 * Execution may briefly reuse credential-scoped validation in memory.
 *
 * macOS `agy models` can be TTY-sensitive. Our local Python PTY helper
 * allocates a controlling terminal for THIS SAME command without requiring
 * the Paperclip process to own a terminal. No fallback model source is used.
 */
import { execFile, spawn } from 'node:child_process';
import { access, stat, realpath } from 'node:fs/promises';
import { createModelValidationCache } from './model-validation-cache.js';
import { observeExecutionAccount } from './account.js?v=0.6.0-performance';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execAsync = promisify(execFile);
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const MODEL_ID = /^[a-zA-Z][a-zA-Z0-9._-]{1,99}$/;
const TIMEOUT_MS = 30_000;
const discoveryFlights = new Map();
const validationCache = createModelValidationCache();
let validationScope = null;
export const invalidateModelValidation = () => { validationCache.clear(); validationScope = null; };
const MAX_BYTES = 512 * 1024;
const PTY_HELPER = fileURLToPath(new URL('./pty-models.py', import.meta.url));

function safeOutput(text) {
  return String(text ?? '').replace(ANSI, '').replace(/\r/g, '\n');
}

/** Only parse rows shaped like `id     Human Label` from `agy models`. */
export function parseAgyModels(raw) {
  if (typeof raw !== 'string') throw new Error('Antigravity model output is not text');
  const models = new Map();
  for (const original of safeOutput(raw).split('\n')) {
    const line = original.trim().replace(/^(?:[>*•-]\s+)+/, '');
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z][A-Za-z0-9._-]{1,99})[ \t]{2,}(.+?)\s*$/.exec(line);
    if (!match) continue;
    const [, id, rawLabel] = match;
    const label = rawLabel.trim().replace(/\s+\|\s*$/, '');
    if (!MODEL_ID.test(id) || !/[0-9_-]/.test(id) || !label || label.length > 160) continue;
    if (/^(?:default|model|models|name|slug|status|version|usage|quota|available)$/i.test(id)) continue;
    if (/[\x00-\x1f]/.test(label)) continue;
    if (!models.has(id)) models.set(id, { id, label });
    if (models.size > 128) throw new Error('Antigravity returned more than 128 models; refusing ambiguous output');
  }
  return [...models.values()];
}

function configFromContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return {};
  return ctx.config ?? ctx.adapterConfig ?? ctx.agent?.adapterConfig ?? {};
}

export async function resolveAgyCommand(ctx = {}) {
  const config = configFromContext(ctx);
  const raw = config.command || process.env.PAPERCLIP_ANTIGRAVITY_COMMAND;
  if (raw !== undefined) {
    if (typeof raw !== 'string' || !raw.trim() || /[\s;&|`$><\r\n]/.test(raw)) {
      throw new Error('Invalid Antigravity executable path');
    }
    return raw.trim();
  }
  const installed = path.join(homedir(), '.local', 'bin', 'agy');
  try { await access(installed); return installed; } catch { return 'agy'; }
}

/**
 * Build exactly one `agy models` operation. On macOS the Python helper
 * creates a REAL pseudoterminal even when Node stdin is a socket/pipe.
 * It launches exactly the named `agy` executable with `models` (no shell).
 */
export function makeModelCommand(agy, platform = process.platform) {
  if (platform === 'darwin') {
    return { command: 'python3', args: ['-u', PTY_HELPER, agy] };
  }
  return { command: agy, args: ['models'] };
}

/**
 * Query the signed-in account every time Paperclip requests a model list.
 * Throws on failure. A failed lookup must NOT publish a fake default or a
 * previously generated/stale catalog.
 */
/** One invocation per command/platform at a time. Never cache model authorization
 * across invocations: account switches must be reflected by the next lookup. */
export async function discoverAgyModels(ctx = {}, runner = execAsync, platform = process.platform) {
  // Explicit catalog requests revoke previously reused authorization.
  invalidateModelValidation();
  const agy = await resolveAgyCommand(ctx);
  const key = `${platform}\0${agy}`;
  // Injected test runners must remain isolated from production and each other.
  if (runner !== execAsync) return queryModels(agy, runner, platform);
  if (discoveryFlights.has(key)) return discoveryFlights.get(key);
  const flight = queryModels(agy, runner, platform);
  discoveryFlights.set(key, flight);
  try { return await flight; }
  finally { if (discoveryFlights.get(key) === flight) discoveryFlights.delete(key); }
}

/** Reuse only after a fresh credential observation and unchanged executable. */
export async function modelsForExecution(ctx, { email, credentialVersion, expired } = {}) {
  const agy = await resolveAgyCommand(ctx);
  let executable = null;
  const candidates = path.isAbsolute(agy) ? [agy] : (process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, agy));
  for (const candidate of candidates) {
    try {
      await access(candidate, 1);
      const file = await realpath(candidate), info = await stat(file);
      if (!info.isFile()) continue;
      executable = { file, identity: `${file}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` };
      break;
    } catch { /* Preserve normal discovery errors if resolution fails. */ }
  }
  const key = email && credentialVersion && !expired && executable
    ? JSON.stringify([process.platform, executable.identity, email.toLowerCase(), credentialVersion]) : null;
  if (!key || validationScope !== key) { invalidateModelValidation(); validationScope = key; }
  const load = async () => {
    const models = await queryModels(executable?.file || agy, execAsync, process.platform);
    if (key) {
      const current = (await observeExecutionAccount()).validationIdentity;
      if (current.email !== email || current.credentialVersion !== credentialVersion || current.expired) {
        invalidateModelValidation();
        throw new Error('AGY credentials changed during model discovery; retry with the current account');
      }
    }
    return models;
  };
  let result = await validationCache.get(key, load);
  const selected = configFromContext(ctx).model;
  if (result.cacheHit && !result.models.some(entry=>entry.id===selected)) {
    // A successful turn confirms only one model; switching models needs a live list.
    invalidateModelValidation();
    validationScope = key;
    result = await validationCache.get(key,load);
  }
  return result;
}

async function queryModels(agy, runner, platform) {
  const spec = makeModelCommand(agy, platform);
  let stdout, stderr;
  try {
    // The real CLI path uses process-group termination on POSIX, so a hung
    // PTY grandchild cannot survive a Node execFile timeout.
    const response = runner === execAsync
      ? await runModelProcess(spec)
      : await runner(spec.command, spec.args, {
          timeout: TIMEOUT_MS, maxBuffer: MAX_BYTES, windowsHide: true,
          shell: false, encoding: 'utf8',
          env: { ...process.env, NO_COLOR: '1', CLICOLOR: '0', TERM: 'dumb' },
        });
    stdout = response.stdout;
    stderr = response.stderr;
  } catch (err) {
    const code = err?.code === 'ETIMEDOUT' || err?.timedOut ? 'timed out' : `failed (${String(err?.code ?? 'unknown')})`;
    throw new Error(`Live Antigravity model discovery ${code}; command: ${spec.command}; verify AGY authentication and terminal access for the Paperclip process`, { cause: err });
  }
  const models = parseAgyModels(`${stdout ?? ''}\n${stderr ?? ''}`);
  if (!models.length) throw new Error('Antigravity model discovery returned no valid model rows; check AGY login and `agy models`');
  return models;
}

function runModelProcess(spec) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, NO_COLOR: '1', CLICOLOR: '0', TERM: 'dumb' };
    const child = spawn(spec.command, spec.args, {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', env,
    });
    let stdout = '', stderr = '', bytes = 0, settled = false, timedOut = false;
    let timer;
    const killTree = () => {
      if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      } else { try { child.kill('SIGKILL'); } catch {} }
    };
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    };
    const append = (stream, data) => {
      bytes += data.length;
      if (bytes > MAX_BYTES) {
        killTree(); finish(Object.assign(new Error('Model output exceeded limit'), { code: 'EMAXBUFFER' }));
        return;
      }
      if (stream === 'out') stdout += data.toString('utf8');
      else stderr += data.toString('utf8');
    };
    child.stdout.on('data', data => append('out', data));
    child.stderr.on('data', data => append('err', data));
    child.on('error', err => finish(err));
    child.on('close', code => {
      if (timedOut) finish(Object.assign(new Error('Model discovery timeout'), { code: 'ETIMEDOUT' }));
      else if (code !== 0) finish(Object.assign(new Error('AGY model discovery exited unsuccessfully'), { code }));
      else finish(null, { stdout, stderr });
    });
    timer = setTimeout(() => {
      timedOut = true;
      killTree();
      finish(Object.assign(new Error('Model discovery timeout'), { code: 'ETIMEDOUT' }));
    }, TIMEOUT_MS);
    timer.unref?.();
  });
}
