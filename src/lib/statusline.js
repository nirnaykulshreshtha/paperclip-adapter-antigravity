/**
 * Unprivileged observation of the interactive AGY status line.
 * The file contains ONLY a small whitelisted snapshot; it is not authentication
 * and must never be used to impersonate or switch an AGY account.
 */
import path from 'node:path';
import { homedir } from 'node:os';
import { readFile, mkdir, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export function getStatusPath() {
  return path.resolve(process.env.PAPERCLIP_AGY_STATUS_FILE || path.join(homedir(), '.paperclip', 'agy-status.json'));
}
const EMAIL = /^[^\s@\x00-\x1f]{1,128}@[^\s@\x00-\x1f]{1,128}$/;
const MODEL = /^[A-Za-z][\w.-]{1,99}$/;
export function sanitizeStatuslinePayload(value, at = new Date()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid AGY status line payload');
  const email = typeof value.email === 'string' && EMAIL.test(value.email) ? value.email.toLowerCase() : null;
  const model = typeof value.model?.id === 'string' && MODEL.test(value.model.id) ? value.model.id : null;
  const quota = {};
  for (const [key, raw] of Object.entries(value.quota && typeof value.quota === 'object' ? value.quota : {})) {
    if (!MODEL.test(key) || Object.keys(quota).length >= 128 || !raw || typeof raw !== 'object') continue;
    const remaining = raw.remaining_fraction;
    const seconds = raw.reset_in_seconds;
    quota[key] = {
      ...(typeof remaining === 'number' && remaining >= 0 && remaining <= 1 ? {remainingFraction: remaining} : {}),
      ...(Number.isFinite(seconds) && seconds >= 0 && seconds <= 2678400 ? {resetInSeconds: seconds} : {}),
      ...(typeof raw.reset_time === 'string' && Number.isFinite(Date.parse(raw.reset_time)) ? {resetAt: raw.reset_time} : {}),
    };
  }
  return {version: 1, observedAt: at.toISOString(), source: 'agy_statusline', email, model, quota};
}
export async function writeObservedStatus(value, filePath = getStatusPath()) {
  const snapshot = sanitizeStatuslinePayload(value);
  const dir = path.dirname(filePath);
  await mkdir(dir, {recursive: true, mode: 0o700});
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = await open(temp, 'wx', 0o600);
    await fd.writeFile(JSON.stringify(snapshot) + '\n', 'utf8');
    await fd.sync();
    await fd.close(); fd = null;
    await rename(temp, filePath);
    const dh = await open(dir, 'r').catch(() => null);
    if (dh) { try { await dh.sync(); } finally { await dh.close(); } }
  } finally { if (fd) await fd.close(); await rm(temp, {force:true}).catch(()=>{}); }
  return snapshot;
}
export async function readObservedStatus({filePath = getStatusPath(), maxAgeMs = 120_000, now = Date.now()} = {}) {
  let data;
  try { data = JSON.parse(await readFile(filePath, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('Invalid AGY status file (do not trust account identity)', {cause:error});
  }
  const age = now - Date.parse(data?.observedAt);
  if (data?.version !== 1 || !Number.isFinite(age) || age < -30_000 || age > maxAgeMs) return null;
  // Re-validate whitelisted fields before presenting them.
  const clean = sanitizeStatuslinePayload({email:data.email,model:{id:data.model},quota:{}}, new Date(data.observedAt));
  return {...clean, quota: data.quota && typeof data.quota === 'object' ? sanitizeStatuslinePayload({quota:Object.fromEntries(Object.entries(data.quota).map(([k,v])=>[k,{remaining_fraction:v?.remainingFraction,reset_in_seconds:v?.resetInSeconds,reset_time:v?.resetAt}]))}).quota : {}};
}
