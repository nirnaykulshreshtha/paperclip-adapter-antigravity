import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgyModels, discoverAgyModels } from '../src/lib/models.js';

const accountList = `gemini-3.8-flash-high     Gemini 3.8 Flash (High)
gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)
gemini-3.8-flash-low      Gemini 3.8 Flash (Low)
gemini-3.7-flash-high     Gemini 3.7 Flash (High)
gemini-3.7-flash-medium   Gemini 3.7 Flash (Medium)
gemini-3.7-flash-low      Gemini 3.7 Flash (Low)
gemini-3.6-flash-high     Gemini 3.6 Flash (High)
gemini-3.6-flash-medium   Gemini 3.6 Flash (Medium)
gemini-3.6-flash-low      Gemini 3.6 Flash (Low)
gemini-3.1-pro-high       Gemini 3.1 Pro (High)
gemini-3.1-pro-low        Gemini 3.1 Pro (Low)
claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)
gpt-oss-120b-medium       GPT-OSS 120B (Medium)
`;

test('live catalog parses the exact fourteen user-supplied account models',()=>{
 const models=parseAgyModels(accountList);
 assert.equal(models.length,14);
 assert.equal(models[0].id,'gemini-3.8-flash-high');
 assert.equal(models.at(-1).id,'gpt-oss-120b-medium');
 assert.ok(!models.some(m=>m.id==='default'));
});
test('non-interactive macOS process runs model listing in a pseudoterminal',async()=>{
 let seen;
 const models=await discoverAgyModels({config:{command:'/path/agy'}},async(cmd,args,opts)=>{
   seen={cmd,args,opts};
   return {stdout:accountList,stderr:''};
 },'darwin');
 assert.equal(seen.cmd,'python3');
 assert.equal(seen.args[0],'-u');
 assert.match(seen.args[1], /pty-models\.py$/);
 assert.equal(seen.args[2],'/path/agy');
 assert.equal(seen.opts.shell,false);
 assert.equal(models.length,14);
});
test('model listing on stderr is parsed without any second invocation',async()=>{
 let calls=0;
 const models=await discoverAgyModels({config:{command:'/path/agy'}},async()=>{
   calls++;return {stdout:'',stderr:accountList};
 },'linux');
 assert.equal(calls,1);
 assert.equal(models.length,14);
});
test('account discovery failures are not hidden by a saved list or default model',async()=>{
 await assert.rejects(discoverAgyModels({config:{command:'/path/agy'}},async()=>({stdout:'',stderr:'account unavailable'}),'linux'),/no valid model/);
 await assert.rejects(discoverAgyModels({config:{command:'/path/agy'}},async()=>{throw Object.assign(new Error('timed out'),{code:'ETIMEDOUT'});},'linux'),/timed out/);
});
test('control sequences and duplicate model names are handled safely',()=>{
 const models=parseAgyModels(`\x1b[32mgemini-3.8-flash-low   Gemini 3.8 Flash (Low)\x1b[0m\r\ngemini-3.8-flash-low   Same\n`);
 assert.deepEqual(models,[{id:'gemini-3.8-flash-low',label:'Gemini 3.8 Flash (Low)'}]);
});

// Integration-level smoke test: unlike a mocked execFile, this launches the
// real PTY helper from a non-TTY Node subprocess. A synthetic agy executable
// demands that stdin/stdout/stderr are terminals and prints account-like rows.
test('PTY helper supplies a terminal without any parent terminal', async (t) => {
  const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = await mkdtemp(path.join(tmpdir(), 'agy-pty-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'agy');
  await writeFile(executable, `#!/usr/bin/env python3
import os, sys
if sys.argv[1:] != ['models']: sys.exit(65)
if not (os.isatty(0) and os.isatty(1) and os.isatty(2)): sys.exit(67)
print('gemini-3.8-flash-high     Gemini 3.8 Flash (High)')
print('claude-sonnet-4-6        Claude Sonnet 4.6 (Thinking)')
`);
  await chmod(executable, 0o755);
  const models = await discoverAgyModels({ config: { command: executable } }, undefined, 'darwin');
  assert.deepEqual(models.map(x => x.id), ['gemini-3.8-flash-high', 'claude-sonnet-4-6']);
});

test('PTY helper propagates real agy error rather than inventing default models', async (t) => {
  const { mkdtemp, writeFile, chmod, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const root = await mkdtemp(path.join(tmpdir(), 'agy-pty-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'agy');
  await writeFile(executable, '#!/usr/bin/env python3\nimport sys\nprint("Authentication required", file=sys.stderr)\nsys.exit(17)\n');
  await chmod(executable, 0o755);
  await assert.rejects(discoverAgyModels({ config: { command: executable } }, undefined, 'darwin'), /discovery failed \(17\)/i);
});
