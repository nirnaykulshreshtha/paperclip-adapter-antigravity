import { createHash } from 'node:crypto';
export const GOOGLE_PRICING_URL = 'https://ai.google.dev/gemini-api/docs/pricing';
const clean = html => html.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
function rate(cell, at) {
  const rows = clean(cell).split('\n').map(s=>s.trim()).filter(s=>s && !/storage|per hour/i.test(s));
  const candidates = rows.map(text => {
    const m = /^\$(\d+(?:\.\d+)?)\s*(?:through|starting)?\s*([A-Za-z]+ \d{1,2}, \d{4})?\.?$/.exec(text);
    if (!m) throw new Error(`Ambiguous token price: ${text}`);
    if (!m[2]) return { value:m[1], applies:true };
    const date = Date.parse(m[2]+' 00:00:00 GMT');
    if (!Number.isFinite(date)) throw new Error('Invalid rate effective date');
    return {value:m[1], applies:text.includes('through') ? +at < date+86400000 : +at >= date};
  }).filter(r=>r.applies);
  if (candidates.length!==1) throw new Error('No unique rate for run timestamp');
  return candidates[0].value;
}
export function parseGoogleRates(html, selectedModel, at = new Date()) {
  if (!/^gemini-[a-z0-9.-]+$/.test(selectedModel) || !Number.isFinite(+at)) throw new Error('Unsupported model or timestamp');
  const sections=[...html.matchAll(/<h2\b[^>]*id="([^"]+)"[^>]*>[\s\S]*?<\/h2>([\s\S]*?)(?=<h2\b|$)/gi)];
  const direct=sections.find(s=>s[1]===selectedModel);
  const canonical = direct ? selectedModel : selectedModel.replace(/-(low|medium|high)$/, '');
  const section=direct ?? sections.find(s=>s[1]===canonical);
  if (!section) throw new Error(`No official pricing section for ${selectedModel}`);
  if (!section[2].includes(`/models/${canonical}`)) throw new Error('Official model code cannot be verified');
  const standard=/<h3\b[^>]*>Standard<\/h3>([\s\S]*?)(?=<h3\b|$)/i.exec(section[2]);
  const table=standard && /<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(standard[1]);
  if (!table || !/Paid Tier, per 1M tokens in USD/.test(clean(table[1]))) throw new Error('Missing Standard USD per-million table');
  const fields={ 'Input price':'input_cost_per_token', 'Output price (including thinking tokens)':'output_cost_per_token', 'Context caching price':'cache_read_input_token_cost' };
  const rates={};
  for (const row of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells=[...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)];
    const field=cells[0] && fields[clean(cells[0][1])];
    if (field) { if(cells.length!==3 || rates[field]) throw new Error('Ambiguous pricing row'); rates[field]=rate(cells[2][1],at); }
  }
  if (Object.keys(rates).length!==3) throw new Error('Incomplete text/cache pricing');
  return {canonicalModel:canonical, ratesPerMillion:rates, sourceUrl:`${GOOGLE_PRICING_URL}#${canonical}`};
}
export function createGoogleRateClient({fetchImpl=globalThis.fetch, now=()=>Date.now(), ttlMs=3600000}={}) {
  let cached=null, flight=null;
  async function load() {
    if(cached && now()-cached.fetchedMs < ttlMs) return cached;
    if(flight) return flight;
    flight=(async()=>{
      const response=await fetchImpl(GOOGLE_PRICING_URL,{signal:AbortSignal.timeout(12000),redirect:'error',headers:{'Accept':'text/html'}});
      if(!response.ok) throw new Error(`Official pricing HTTP ${response.status}`);
      const html=await response.text();
      if(Buffer.byteLength(html)>2*1024*1024 || html.length<100) throw new Error('Invalid official pricing document size');
      const fetchedMs=now();
      cached={html,fetchedMs,verifiedAt:new Date(fetchedMs).toISOString(),expiresAt:new Date(fetchedMs+ttlMs).toISOString(),sha256:createHash('sha256').update(html).digest('hex')};
      return cached;
    })();
    try{return await flight;}finally{flight=null;}
  }
  return { async get(model, at=new Date()) {const doc=await load();return {...parseGoogleRates(doc.html,model,at),verifiedAt:doc.verifiedAt,expiresAt:doc.expiresAt,sha256:doc.sha256};} };
}
export const googleRateClient=createGoogleRateClient();
