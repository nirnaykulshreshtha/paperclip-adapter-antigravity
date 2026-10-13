#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { journalPath } from '../src/lib/journal.js';

const args=process.argv.slice(2);
if(!args.length){console.error('Usage: node scripts/trace-report.mjs <runId|trace.jsonl> [report.html]');process.exit(2);}
const input=args[0].endsWith('.jsonl')?path.resolve(args[0]):journalPath(args[0],process.env.AGY_TRACE_DIR||path.join(os.homedir(),'.paperclip','antigravity-traces'));
const output=path.resolve(args[1]||'antigravity-run-history.html');
const lines=(await readFile(input,'utf8')).trim().split(/\r?\n/);
const events=[];
for(let n=0;n<lines.length;n++){
  try {events.push(JSON.parse(lines[n]));}catch{events.push({sequence:n+1,kind:'journal.invalid_line',data:{error:'Malformed line'}});}
}
// HTML escape via textContent in browser, and prohibit closing the embedded JSON script.
const data=JSON.stringify(events).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026');
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Antigravity execution history</title><style>
:root{font:14px/1.5 system-ui,-apple-system,sans-serif;color-scheme:dark;background:#111317;color:#e5e7eb}body{max-width:1150px;margin:24px auto;padding:0 20px}header{display:flex;align-items:center;gap:20px;justify-content:space-between}input,select{background:#21252d;border:1px solid #414754;border-radius:8px;padding:10px;color:inherit}input{width:48%}details{border:1px solid #323840;border-radius:8px;margin:8px 0;background:#1a1d23}summary{cursor:pointer;display:flex;align-items:center;gap:14px;padding:12px;list-style:none}summary:hover{background:#272c34}.time{font-variant-numeric:tabular-nums;color:#a6adbb;min-width:110px}.kind{font-weight:650;min-width:175px}.failed,.interrupted,.exception{color:#ff8787}.completed,.success{color:#88d69b}.name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:600px;overflow:auto;margin:0;padding:16px;border-top:1px solid #343b45;color:#bcc5d2}small{color:#a6adbb}#count{margin:18px 0;color:#b7bfcc}button{border:1px solid #4b5260;background:#272c34;color:inherit;border-radius:8px;padding:8px 12px;cursor:pointer}</style></head><body>
<header><div><h1>Antigravity execution history</h1><small>Offline trace viewer · data is contained in this HTML file; do not share traces without checking for sensitive information.</small></div><button id="download">Export JSON</button></header><p id="count"></p><div><input id="search" placeholder="Search tool, path, output, errors..." aria-label="Search events"> <select id="filter"><option value="">All events</option><option value="tool.">Tool calls</option><option value="cli.">Raw CLI</option><option value="paperclip.">Paperclip</option><option value="phase.">Stages</option><option value="run.">Run lifecycle</option></select></div><main id="events"></main>
<script id="trace" type="application/json">${data}</script><script>
const events=JSON.parse(document.getElementById('trace').textContent),el=document.getElementById('events'),count=document.getElementById('count');
const text=(tag,cls,value)=>{const e=document.createElement(tag);e.className=cls;e.textContent=String(value??'');return e;};
function render(){const query=document.getElementById('search').value.toLowerCase(),filter=document.getElementById('filter').value;el.replaceChildren();let selected=events.filter(e=>e.kind?.startsWith(filter)&&(!query||JSON.stringify(e).toLowerCase().includes(query)));count.textContent=selected.length+' of '+events.length+' recorded events';const fragment=document.createDocumentFragment();for(const event of selected){const details=document.createElement('details'),summary=document.createElement('summary');const d=event.data||{};summary.append(text('span','time',event.timestamp?.slice(11,23)||'—'));summary.append(text('span','kind '+(d.status||''),event.kind));summary.append(text('span','name',d.name||d.target||d.message||d.eventType||d.phase||''));const pre=text('pre','',JSON.stringify(event,null,2));details.append(summary,pre);fragment.append(details);}el.append(fragment);}
document.getElementById('search').addEventListener('input',render);document.getElementById('filter').addEventListener('change',render);document.getElementById('download').addEventListener('click',()=>{const blob=new Blob([JSON.stringify(events,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='antigravity-trace.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);});render();
</script></body></html>`;
await writeFile(output,html,{mode:0o600});
console.log(`${events.length} events -> ${output}`);
