/**
 * Account observation and quota registry. Never store OAuth access/refresh/id
 * tokens or modify the Antigravity keychain; the CLI owns authentication.
 */
import { readFile, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { detectActiveAccount } from './account.js?v=0.6.0-performance';

export function getAccountPoolPath() {
  return path.resolve(process.env.PAPERCLIP_ANTIGRAVITY_ACCOUNT_POOL_FILE || path.join(homedir(), '.paperclip', 'antigravity-accounts.json'));
}
const blank = () => ({version:2,activeAccount:null,accounts:[]});
const UNCHANGED = Symbol('unchanged account observation');
function validate(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.accounts)) throw new Error('Corrupt account registry');
  const accounts = data.accounts.map(a => {
    if (typeof a?.email !== 'string' || !a.email.includes('@')) throw new Error('Invalid account entry');
    const {tokenPayload,accessToken,refreshToken,idToken,...safe} = a;
    return {...safe,email:a.email.toLowerCase()};
  });
  const result = {...data,version:2,accounts};
  return result;
}
export async function loadAccountPool(filePath=getAccountPoolPath()) {
  try {
    const raw = await readFile(filePath,'utf8');
    const pool = validate(JSON.parse(raw));
    Object.defineProperty(pool,'_filePath',{value:filePath,writable:true,enumerable:false,configurable:true});
    return pool;
  } catch(e) {
    if (e.code !== 'ENOENT') throw new Error(`Cannot load account registry at ${filePath}; refused to discard state`,{cause:e});
    const pool = blank();
    Object.defineProperty(pool,'_filePath',{value:filePath,writable:true,enumerable:false});
    return pool;
  }
}
export async function saveAccountPool(pool,filePath=pool?._filePath || getAccountPoolPath()) {
  const data = validate(pool);
  const dir=path.dirname(filePath);
  await mkdir(dir,{recursive:true,mode:0o700});
  const tmp=path.join(dir,`.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd=await open(tmp,'wx',0o600);
    await fd.writeFile(JSON.stringify({version:2,activeAccount:data.activeAccount,accounts:data.accounts},null,2),'utf8');
    await fd.sync();await fd.close();fd=null;
    await rename(tmp,filePath);
    const dfd=await open(dir,'r').catch(()=>null);
    if(dfd){try{await dfd.sync();}finally{await dfd.close();}}
    return true;
  } finally {if(fd)await fd.close();await rm(tmp,{force:true}).catch(()=>{});}
}
// Serialize writers across processes. Use fresh disk state inside lock to avoid lost updates.
export async function updateAccountPool(mutator,filePath=getAccountPoolPath(),{waitMs=3000}={}) {
  const lock=filePath+'.lock';
  await mkdir(path.dirname(filePath),{recursive:true,mode:0o700});
  const start=Date.now();let acquired=false;
  while(!acquired) {
    try { await mkdir(lock,{mode:0o700});acquired=true; }
    catch(e){
      if(e.code!=='EEXIST')throw e;
      if(Date.now()-start>waitMs)throw new Error('Account registry is locked; refusing concurrent state overwrite');
      const st=await stat(lock).catch(()=>null);
      if(st && Date.now()-st.mtimeMs>30_000) {
        // Stale locks require manual intervention: unsafe automatic removal can race owners.
        throw new Error('Stale account registry lock; administrator intervention required');
      }
      await new Promise(resolve=>setTimeout(resolve,30));
    }
  }
  try {
    const pool=await loadAccountPool(filePath),value=await mutator(pool);
    if(value!==UNCHANGED)await saveAccountPool(pool,filePath);
    return value===UNCHANGED ? pool : value??pool;
  }
  finally {await rm(lock,{recursive:true,force:true});}
}
export function parseQuotaResetDuration(value) {
  if(typeof value!=='string')return 30*60_000;
  const match=/resets? in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?\s*(?:(\d+)\s*s(?:ec(?:onds?)?)?)?/i.exec(value);
  const seconds=match?Number(match[1]||0)*3600+Number(match[2]||0)*60+Number(match[3]||0):0;
  return Number.isSafeInteger(seconds) && seconds>0?Math.min(seconds*1000+30_000,31*86400000):30*60_000;
}
export async function syncKeychainToPool(pool,filePath=pool?._filePath || getAccountPoolPath(),detectedObservation) {
  const detected=detectedObservation === undefined ? await detectActiveAccount() : detectedObservation;
  if(!detected?.email)return pool;
  const email=detected.email.toLowerCase();
  const result=await updateAccountPool(p=>{
    const a=p.accounts.find(x=>x.email.toLowerCase()===email);
    const age = a ? Date.now()-Date.parse(a.lastSeenAt) : Infinity;
    if(a && p.activeAccount===email && a.authSource===(detected.source||'keychain') && age>=0 && age<60_000) return UNCHANGED;
    if(a){a.lastSeenAt=new Date().toISOString();a.authSource=detected.source||'keychain';}
    else p.accounts.push({email,status:'observed',lastSeenAt:new Date().toISOString(),authSource:detected.source||'keychain',modelQuotas:{}});
    p.activeAccount=email;
  },filePath);
  return result;
}
export function isAccountReadyForModel(account,model=null,now=Date.now()) {
  if(!account || ['disabled','invalid','blocked'].includes(account.status))return false;
  if(account.quotaResetAt && now<account.quotaResetAt)return false;
  if(model && account.modelQuotas?.[model]?.quotaResetAt>now)return false;
  return true;
}
export function getNextReadyAccount(pool,excludeEmail=null,model=null) {
  // Informational only. Selecting a pool entry NEVER changes CLI credentials.
  return (pool?.accounts||[]).filter(a=>a.email!==excludeEmail && isAccountReadyForModel(a,model))
    .sort((a,b)=>Date.parse(a.lastUsedAt||0)-Date.parse(b.lastUsedAt||0))[0]||null;
}
export async function activateAccount() { return false; } // Auth changes must happen in the AGY terminal.
export async function markAccountQuotaExhausted(email,pool,cooldownMs,reason='RESOURCE_EXHAUSTED',filePath=pool?._filePath||getAccountPoolPath(),model=null) {
  if(!email || !Number.isSafeInteger(cooldownMs) || cooldownMs<=0)return;
  await updateAccountPool(p=>{
    const a=p.accounts.find(x=>x.email.toLowerCase()===email.toLowerCase());
    if(!a)return;
    const at=Date.now()+Math.min(cooldownMs,31*86400000);
    if(model){a.modelQuotas??={};a.modelQuotas[model]={quotaResetAt:at,exhaustedAt:new Date().toISOString()};}
    else {a.quotaResetAt=at;a.status='quota_exhausted';}
    a.lastErrorCode='provider_quota';
  },filePath);
}
