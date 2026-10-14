#!/usr/bin/env node
// Controlled local benchmark. No real AGY invocation or credentials are used.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { createJournal } from '../src/lib/journal.js';
import { createStreamDelivery } from '../src/lib/stream-delivery.js';
import { createOrderedDelivery } from '../src/lib/ordered-delivery.js';

const exec = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(),'agy-performance-'));
const measure = async fn => { const start=performance.now();const result=await fn();return {elapsedMs:Math.round(performance.now()-start),...result}; };
try {
  // Compare the committed journal implementation with the working implementation.
  // This benchmark requires a Git checkout; it is intended for local development.
  const repository=fileURLToPath(new URL('../',import.meta.url));
  const {stdout:source}=await exec('git',['-C',repository,'show','HEAD:src/lib/journal.js']);
  const baseline=(await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).createJournal;
  const journals=[];
  for (const [label,create] of [['committed',baseline],['working',createJournal]]) {
    journals.push({label,...await measure(async()=>{
      const journal=await create({runId:label,root});
      for(let i=0;i<1000;i++)await journal.append('cli.event',{index:i,text:'text '.repeat(50)});
      await journal.append('run.terminal',{status:'success'});await journal.close();
      const records=(await readFile(journal.file,'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(records.length,1001);
      assert.deepEqual(records.map(e=>e.sequence),Array.from({length:1001},(_,i)=>i+1));
      return {records:records.length,writes:journal.snapshot?.().writes??1001};
    })});
  }
  const delta='A repeated text delta. ';
  const baselineStream=await measure(async()=>{
    for(let i=0;i<1000;i++){await delay(1);await delay(1);}
    return {textCallbacks:1000,progressCallbacks:1000};
  });
  const optimizedStream=await measure(async()=>{
    let text='',textCallbacks=0,progressCallbacks=0;
    const publication=createOrderedDelivery(async item=>{
      await delay(1);
      if(item.kind==='text'){text+=item.text;textCallbacks++;}else progressCallbacks++;
    });
    const stream=createStreamDelivery({onText:text=>publication.append({kind:'text',text}),onProgress:value=>publication.append({kind:'progress',value})});
    for(let i=0;i<1000;i++){await stream.text(delta);stream.progress({message:String(i)});}
    await stream.close();await publication.flush();
    assert.equal(text,delta.repeat(1000));
    return {textCallbacks,progressCallbacks,publication:publication.snapshot()};
  });
  console.log(JSON.stringify({workload:'1000 journal records; 1000 text deltas and progress snapshots; simulated 1 ms per callback',journals,stream:{perDeltaBaseline:baselineStream,working:optimizedStream}},null,2));
} finally {await rm(root,{recursive:true,force:true});}
