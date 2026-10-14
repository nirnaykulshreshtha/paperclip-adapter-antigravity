import { readObservedStatus } from './statusline.js';
import { detectHeadlessKeychainAccount } from './account.js';
/** Paperclip-native live provider quota hook. No static credit buckets. */
export async function getQuotaWindows() {
  let snapshot;
  const credentialAccount=await detectHeadlessKeychainAccount().catch(()=>null);
  const accountIdentity=credentialAccount?.email || null;
  try {snapshot=await readObservedStatus({maxAgeMs:120_000});}
  catch {return {provider:'antigravity',accountIdentity,ok:false,error:'Invalid interactive status snapshot',windows:[]};}
  if(!snapshot) return {provider:'antigravity',accountIdentity,ok:false,error:'No recent AGY terminal status observation. Configure /statusline.',windows:[]};
  if(accountIdentity && snapshot.email && accountIdentity!==snapshot.email)
    return {provider:'antigravity',accountIdentity,ok:false,error:'Terminal quota observation belongs to a different account than the headless credentials.',windows:[]};
  return {provider:'antigravity',accountIdentity:accountIdentity || snapshot.email,source:`AGY terminal (${snapshot.email||'unknown account'})`,ok:true,
    windows:Object.entries(snapshot.quota||{}).map(([key,v])=>({
      label:key,usedPercent:typeof v.remainingFraction==='number' ? Math.round((1-v.remainingFraction)*10000)/100 : null,
      resetsAt:v.resetAt|| (Number.isFinite(v.resetInSeconds) ? new Date(Date.parse(snapshot.observedAt)+v.resetInSeconds*1000).toISOString():null),
      valueLabel:null,detail:'Observed from live AGY TUI statusline; may be stale between updates',
    }))};
}
