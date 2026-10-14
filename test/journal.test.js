import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createJournal,journalPath} from '../src/lib/journal.js';
test('journal records sequenced, sanitized tool calls across completion and interruption',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'agy-journal-'));
 try {
  const journal=await createJournal({runId:'run/../../escape',root,token:'abc123-secret'});
  await Promise.all([
   journal.append('tool.started',{executionId:'tool-1',name:'view_file',parameters:{TargetFile:'/workspace/a.js',Authorization:'abc123-secret'}}),
   journal.append('tool.completed',{executionId:'tool-1',output:'hello abc123-secret',durationMs:23}),
   journal.append('tool.interrupted',{executionId:'tool-2',name:'run_command',parameters:{password:'abc123-secret'}}),
  ]);
  await journal.close();
  const raw=await readFile(journal.file,'utf8');
  const events=raw.trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(e=>e.sequence),[1,2,3]);
  assert.deepEqual(events.map(e=>e.kind),['tool.started','tool.completed','tool.interrupted']);
  assert.equal(events[0].data.parameters.Authorization,'[REDACTED]');
  assert.equal(events[1].data.output,'hello [REDACTED_TOKEN]');
  assert.equal(events[2].data.parameters.password,'[REDACTED]');
  assert.ok(journal.file.startsWith(root));
  assert.equal(journal.file,journalPath('run/../../escape',root));
 }finally {await rm(root,{recursive:true,force:true});}
});

test('journal batches burst records and flushes a durable ordered terminal boundary',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'agy-journal-batch-'));
 try {
  const journal=await createJournal({runId:'burst',root,flushIntervalMs:60_000});
  for(let i=0;i<1000;i++)await journal.append('cli.event',{i});
  await journal.append('run.terminal',{status:'success'});
  const events=(await readFile(journal.file,'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.length,1001);
  assert.deepEqual(events.map(e=>e.sequence),Array.from({length:1001},(_,i)=>i+1));
  assert.deepEqual(events.slice(0,1000).map(e=>e.data.i),Array.from({length:1000},(_,i)=>i));
  assert.ok(journal.snapshot().writes<10,JSON.stringify(journal.snapshot()));
  await journal.close();
  const reopened=await createJournal({runId:'burst',root});
  await reopened.append('run.terminal',{status:'success'});await reopened.close();
  const tail=(await readFile(journal.file,'utf8')).trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(tail.sequence,1002);
 }finally {await rm(root,{recursive:true,force:true});}
});
test('journal retains the terminal reserve and monotonic sequence after truncation',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'agy-journal-limit-'));
 try {
  const journal=await createJournal({runId:'limit',root,maxBytes:2048,flushIntervalMs:60_000});
  for(let i=0;i<20;i++)await journal.append('cli.event',{output:'x'.repeat(300)});
  await journal.append('run.terminal',{status:'failed'});await journal.close();
  const raw=await readFile(journal.file,'utf8'),events=raw.trim().split('\n').map(JSON.parse);
  assert.ok(Buffer.byteLength(raw)<=2048);
  assert.equal(events.at(-1).kind,'run.terminal');
  assert.equal(events.filter(e=>e.kind==='journal.truncated').length,1);
  assert.ok(events.every((e,i)=>i===0 || e.sequence>events[i-1].sequence));
 }finally {await rm(root,{recursive:true,force:true});}
});
