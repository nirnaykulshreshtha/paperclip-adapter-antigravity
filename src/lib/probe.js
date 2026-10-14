/**
 * Minimal live account probe. Never runs inside the project checkout:
 * its temporary empty directory contains no repository instructions/files.
 * This still uses a paid/limited model turn; actual tokens vary by provider.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const TTL_MS = 15 * 60 * 1000;
const successCache = new Map();
const inflight = new Map();

export function parseProbeResult(stdout, stderr = '', code = 0) {
  let result;
  try { result = JSON.parse(stdout); } catch {
    const combinedErr = `${stderr} ${stdout}`;
    if (/(?:RESOURCE_EXHAUSTED|quota|rate[-\s]?limit|429|out\s+of\s+quota)/i.test(combinedErr)) {
      return {ok:false, reason:'Antigravity quota exhausted or token limit reached (429).'};
    }
    if (/(?:not\s+logged\s+in|unauthenticated|unauthorized|please\s+authenticate)/i.test(combinedErr)) {
      return {ok:false, reason:'Antigravity authentication required or credentials expired.'};
    }
    return {ok:false, reason:'Antigravity did not produce valid JSON.'};
  }
  if (code !== 0 || result?.status !== 'SUCCESS') {
    const combinedErr = `${stderr} ${result?.error ?? ''}`;
    if (/(?:RESOURCE_EXHAUSTED|quota|rate[-\s]?limit|429|out\s+of\s+quota)/i.test(combinedErr)) {
      return {ok:false, reason:'Antigravity quota exhausted or token limit reached (429).'};
    }
    if (/(?:not\s+logged\s+in|unauthenticated|unauthorized|please\s+authenticate)/i.test(combinedErr)) {
      return {ok:false, reason:'Antigravity authentication required or credentials expired.'};
    }
    return {ok:false, reason:`Antigravity returned ${String(result?.status ?? 'an unsuccessful status').slice(0,40)}. Check CLI authentication and model access.`};
  }
  if (/\b(?:permission\s+denied|requires?\s+approval|not\s+authorized)\b/i.test(stderr)) {
    return {ok:false, reason:'Antigravity reported a permission denial.'};
  }
  if (!/^OK[.!]?$/i.test(String(result.response??'').trim())) {
    return {ok:false, reason:'Model replied but did not follow the short probe. Verify account settings and active hooks.'};
  }
  const usage=result?.usage && typeof result.usage==='object' ? result.usage : {};
  const tokens={};
  for (const [from,to] of [['input_tokens','inputTokens'],['output_tokens','outputTokens'],['thinking_tokens','thinkingTokens'],['cache_read_tokens','cacheReadTokens'],['total_tokens','totalTokens']]) {
    if (Number.isSafeInteger(usage[from]) && usage[from]>=0) tokens[to]=usage[from];
  }
  return {ok:true,tokens};
}

/** The runner is injectable so unit tests spend no model tokens. */
export async function runMinimalProbe({command, model, timeoutSec=35}, runner=exec) {
  if (!model || model === 'default') throw new Error('An explicit Antigravity model is required for the connection test');
  const dir=await mkdtemp(path.join(tmpdir(),'paperclip-agy-probe-'));
  try {
    const args=['-p','Reply exactly OK. Do not use tools.', '--output-format','json', '--sandbox', '--print-timeout', `${timeoutSec}s`];
    args.push('--model',model);
    let res;
    try {
      res=await runner(command,args,{
        cwd:dir, env:process.env, shell:false, windowsHide:true,
        timeout:(timeoutSec+5)*1000, maxBuffer:128*1024, encoding:'utf8',
      });
    } catch (err) {
      return {ok:false,reason:err.code==='ETIMEDOUT'||err.killed
        ? 'Connection probe timed out.'
        : 'Antigravity process failed. Confirm signed-in CLI credentials and model availability.'};
    }
    return parseProbeResult(res.stdout, res.stderr, 0);
  } finally {
    await rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}

/** Deduplicate concurrent probes and cache only proven successes. */
export async function probeWithCache(cfg, runner=exec, now=()=>Date.now()) {
  // Production callers explicitly pass null when credential identity is unknown.
  // Never certify a different company/account using a cached model response.
  if (cfg.probeIdentity === null || cfg.forceProbe === true) return runMinimalProbe({command:cfg.command,model:cfg.model,timeoutSec:cfg.probeTimeoutSec},runner);
  for (const [key,entry] of successCache) if (now()-entry.at>=TTL_MS) successCache.delete(key);
  const key=JSON.stringify([cfg.command,cfg.model,cfg.probeTimeoutSec,cfg.probeIdentity]);
  const cached=successCache.get(key);
  if (cached && now()-cached.at<TTL_MS) return {...cached.result,cached:true};
  if (inflight.has(key)) return inflight.get(key);
  const promise=runMinimalProbe({command:cfg.command,model:cfg.model,timeoutSec:cfg.probeTimeoutSec},runner)
    .then(result=>{
      if(result.ok) {
        if(successCache.size>=128) successCache.delete(successCache.keys().next().value);
        successCache.set(key,{at:now(),result});
      }
      return result;
    })
    .finally(()=>inflight.delete(key));
  inflight.set(key,promise);
  return promise;
}
export function clearProbeCacheForTests() { successCache.clear(); inflight.clear(); }
