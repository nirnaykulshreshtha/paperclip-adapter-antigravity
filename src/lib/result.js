export const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
import { normalizeRepeatHistory } from './efficiency.js?v=0.6.0-performance';
export function validateTerminal(raw) {
  if (!isObj(raw) || !['SUCCESS','ERROR','CANCELED','INTERRUPTED','INVALID','WAITING','RUNNING'].includes(raw.status)) {
    throw new Error('Missing or invalid Antigravity terminal result');
  }
  if (typeof raw.response !== 'string') throw new Error('Antigravity result missing response');
  const id = raw.conversation_id;
  if (id !== undefined && id !== null && (typeof id !== 'string' || id.length > 200)) throw new Error('Invalid conversation ID');
  return raw;
}
// Backward-compatible utility; calculations are implemented in usage.js.
import { usageSince } from './usage.js';
export function usageOf(result, previous) {
  return usageSince(result?.usage, previous?.usageTotals ?? null, {isResume: Boolean(previous?.conversationId)});
}

export function errorText(e) {
  if (typeof e === 'string') return e.slice(0,2000);
  if (e instanceof Error) return e.message.slice(0,2000);
  return String(e).slice(0,2000);
}
export function looksLikePermissionDenial(stderr) {
  return /(?:permission (?:was )?(?:denied|rejected)|approval (?:was )?(?:denied|required|rejected)|tool (?:call )?(?:was )?denied|soft.denied|requires (?:user )?approval)/i.test(stderr);
}
export function sessionIdFrom(params) {
  const x = isObj(params) ? params.conversationId : null;
  return typeof x === 'string' && /^[\w-]{5,200}$/.test(x) ? x : null;
}
export const sessionCodec = {
  deserialize(value) {
    const id = sessionIdFrom(value);
    if (!id || !isObj(value) || typeof value.cwd !== 'string') return null;
    return { repeatHistory:normalizeRepeatHistory(value.repeatHistory), conversationId:id,cwd:value.cwd,taskKey:typeof value.taskKey==='string'?value.taskKey:'',workspaceId:typeof value.workspaceId==='string'?value.workspaceId:'',model:typeof value.model==='string'?value.model:null,account:typeof value.account==='string'?value.account:null,usageTotals:value.usageTotals && typeof value.usageTotals==='object'?{...value.usageTotals}:null,usageScope:'cumulative',...(value.resumeRequired===true?{resumeRequired:true}:{}),promptSignature:typeof value.promptSignature==='string' && /^sha256:[0-9a-f]{64}$/.test(value.promptSignature)?value.promptSignature:null,contextFingerprint:typeof value.contextFingerprint==='string' && /^sha256:[0-9a-f]{64}$/.test(value.contextFingerprint)?value.contextFingerprint:null };
  },
  serialize(value) {
    const id = sessionIdFrom(value);
    if (!id || !isObj(value) || typeof value.cwd !== 'string') return null;
    return { repeatHistory:normalizeRepeatHistory(value.repeatHistory), conversationId:id,cwd:value.cwd,taskKey:typeof value.taskKey==='string'?value.taskKey:'',workspaceId:typeof value.workspaceId==='string'?value.workspaceId:'',model:typeof value.model==='string'?value.model:null,account:typeof value.account==='string'?value.account:null,usageTotals:value.usageTotals && typeof value.usageTotals==='object'?{...value.usageTotals}:null,usageScope:'cumulative',...(value.resumeRequired===true?{resumeRequired:true}:{}),promptSignature:typeof value.promptSignature==='string' && /^sha256:[0-9a-f]{64}$/.test(value.promptSignature)?value.promptSignature:null,contextFingerprint:typeof value.contextFingerprint==='string' && /^sha256:[0-9a-f]{64}$/.test(value.contextFingerprint)?value.contextFingerprint:null };
  },
  getDisplayId(value) { return sessionIdFrom(value); },
};
