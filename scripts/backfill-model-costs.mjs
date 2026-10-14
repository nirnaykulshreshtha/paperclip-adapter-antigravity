/** Reads a scoped receipt export; writes only through Paperclip's audited correction API. */
import { readFile, writeFile } from 'node:fs/promises';
import { estimateAgyCost } from '../src/lib/agy-pricing.js';
const args=process.argv.slice(2);
const arg=key=>args.includes(key) ? args[args.indexOf(key)+1] : undefined;
const company=arg('--company'), receipts=arg('--receipts'), report=arg('--report');
if(!args.includes('--company') || !args.includes('--receipts') || !args.includes('--report')) throw new Error('Require --company, --receipts, --report; add --apply after reviewing the report');
const api=arg('--api') || 'http://localhost:3100';
const apply=args.includes('--apply');
const rows=JSON.parse(await readFile(receipts,'utf8'));
const results=[];
function cents(usd) { const [a,b='']=usd.split('.'); const digits=BigInt(a+b)*100n; const scale=b.length; const s=digits.toString().padStart(scale+1,'0'); return scale ? `${s.slice(0,-scale)}.${s.slice(-scale)}`.replace(/\.?0+$/,'') : s; }
for(const row of rows) {
  const usage=row.usage;
  if(row.costStatus!=='unpriced' || !usage || usage.usageSource!=='per_run' || usage.rawInputIncludesCached!==false) {
    results.push({id:row.id,runId:row.runId,status:'skipped',reason:'Requires unpriced receipt and proven per-run/exclusive-cache counters'});continue;
  }
  const pricing=await estimateAgyCost(row.model,usage,{at:new Date(row.occurredAt)});
  if(pricing.costStatus!=='estimated') {results.push({id:row.id,runId:row.runId,status:'skipped',reason:pricing.reason});continue;}
  const payload={idempotencyKey:`agy-dynamic-estimate-v1:${row.id}`,expectedCents:row.expectedCents,
    correctedCents:cents(pricing.costUsdExact),reason:'Backfill missing Standard text API-equivalent estimate from recorded per-run usage and dynamically fetched official model pricing; not a CLI invoice.',pricing:pricing.pricingProvenance};
  const result={id:row.id,runId:row.runId,model:row.model,status:'prepared',costUsdExact:pricing.costUsdExact,calculation:pricing.estimate,payload};
  if(apply) {
    const historyResponse=await fetch(`${api}/api/companies/${company}/accounting/events/${row.id}/adjustments`,{headers:process.env.PAPERCLIP_API_KEY?{Authorization:`Bearer ${process.env.PAPERCLIP_API_KEY}`}:{}});
    if(!historyResponse.ok) throw new Error(`Cannot verify correction history: HTTP ${historyResponse.status}`);
    const prior=(await historyResponse.json()).find(a=>a.idempotencyKey===payload.idempotencyKey);
    if(prior) {results.push({...result,status:'already_adjusted',adjustment:prior});continue;}

    const response=await fetch(`${api}/api/companies/${company}/accounting/events/${row.id}/adjustments`,{method:'POST',headers:{'Content-Type':'application/json',...(process.env.PAPERCLIP_API_KEY?{Authorization:`Bearer ${process.env.PAPERCLIP_API_KEY}`}:{})},body:JSON.stringify(payload)});
    if(!response.ok) {result.status='failed';result.error=(await response.text()).slice(0,1000);results.push(result);await writeFile(report,JSON.stringify(results,null,2));throw new Error(`Adjustment failed for ${row.id}: HTTP ${response.status}`);}
    result.status='adjusted';result.adjustment=await response.json();
  }
  results.push(result);
}
await writeFile(report,JSON.stringify(results,null,2));
console.log(JSON.stringify({mode:apply?'apply':'preview',counts:results.reduce((c,r)=>(c[r.status]=(c[r.status]||0)+1,c),{})}));
