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
