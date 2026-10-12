import { readObservedStatus } from './statusline.js';
/** Paperclip-native live provider quota hook. No static credit buckets. */
export async function getQuotaWindows() {
  let snapshot;
  try {snapshot=await readObservedStatus({maxAgeMs:120_000});}
  catch {return {provider:'antigravity',ok:false,error:'Invalid interactive status snapshot',windows:[]};}
  if(!snapshot) return {provider:'antigravity',ok:false,error:'No recent AGY terminal status observation. Configure /statusline.',windows:[]};
  return {provider:'antigravity',source:`AGY terminal (${snapshot.email||'unknown account'})`,ok:true,
    windows:Object.entries(snapshot.quota||{}).map(([key,v])=>({
      label:key,usedPercent:typeof v.remainingFraction==='number' ? Math.round((1-v.remainingFraction)*10000)/100 : null,
      resetsAt:v.resetAt|| (Number.isFinite(v.resetInSeconds) ? new Date(Date.parse(snapshot.observedAt)+v.resetInSeconds*1000).toISOString():null),
      valueLabel:null,detail:'Observed from live AGY TUI statusline; may be stale between updates',
    }))};
}
