export const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
export function validateTerminal(raw) {
  if (!isObj(raw) || !['SUCCESS','ERROR','CANCELED','INTERRUPTED','INVALID','WAITING','RUNNING'].includes(raw.status)) {
    throw new Error('Missing or invalid Antigravity terminal result');
  }
  if (typeof raw.response !== 'string') throw new Error('Antigravity result missing response');
  const id = raw.conversation_id;
  if (id !== undefined && id !== null && (typeof id !== 'string' || id.length > 200)) throw new Error('Invalid conversation ID');
  return raw;
}
export function usageOf(result, prior) {
  const u = isObj(result.usage) ? result.usage : {};
  const input = Number.isSafeInteger(u.input_tokens) && u.input_tokens >= 0 ? u.input_tokens : 0;
  const output = Number.isSafeInteger(u.output_tokens) && u.output_tokens >= 0 ? u.output_tokens : 0;
  const cached = Number.isSafeInteger(u.cache_read_tokens) && u.cache_read_tokens >= 0 ? u.cache_read_tokens : 0;
  // Antigravity's usage counters may be cumulative across resumed conversations.
  // Paperclip can calculate deltas from session_cumulative receipts if scoped consistently.
  return {usage:{inputTokens:input,outputTokens:output,cachedInputTokens:cached}, usageBasis:'session_cumulative'};
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
    return { conversationId:id,cwd:value.cwd,taskKey:typeof value.taskKey==='string'?value.taskKey:'',workspaceId:typeof value.workspaceId==='string'?value.workspaceId:'',usageScope:'cumulative' };
  },
  serialize(value) {
    const id = sessionIdFrom(value);
    if (!id || !isObj(value) || typeof value.cwd !== 'string') return null;
    return { conversationId:id,cwd:value.cwd,taskKey:typeof value.taskKey==='string'?value.taskKey:'',workspaceId:typeof value.workspaceId==='string'?value.workspaceId:'',usageScope:'cumulative' };
  },
  getDisplayId(value) { return sessionIdFrom(value); },
};
