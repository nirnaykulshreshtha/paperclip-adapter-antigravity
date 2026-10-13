import {mkdtemp, writeFile, chmod, rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
process.env.NODE_ENV = 'test';
export const FIXTURE_SUITE_VERSION = '0.4.0';
const exec=promisify(execFile);

export function makeMockToken(email) {
  const claims = Buffer.from(JSON.stringify({ email, name: email.split('@')[0] })).toString('base64url');
  const idToken = `header.${claims}.sig`;
  const json = JSON.stringify({
    token: { access_token: 'tok', refresh_token: 'ref', expiry: '2099-01-01T00:00:00Z' },
    id_token: idToken,
    auth_method: 'consumer',
  });
  return `go-keyring-base64:${Buffer.from(json).toString('base64')}`;
}

export async function fixture(t) {
  const root=await mkdtemp(path.join(tmpdir(),'agy-adapter-test-'));
  const prevPoolEnv = process.env.PAPERCLIP_ANTIGRAVITY_ACCOUNT_POOL_FILE;
  const prevTestPayload = process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD;
  t.after(async()=>{
    if (prevPoolEnv !== undefined) process.env.PAPERCLIP_ANTIGRAVITY_ACCOUNT_POOL_FILE = prevPoolEnv;
    else delete process.env.PAPERCLIP_ANTIGRAVITY_ACCOUNT_POOL_FILE;
    if (prevTestPayload !== undefined) process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD = prevTestPayload;
    else delete process.env.PAPERCLIP_TEST_KEYCHAIN_PAYLOAD;
    await rm(root,{force:true,recursive:true});
  });
  const primary=path.join(root,'primary');const secondary=path.join(root,'pilot');
  await (await import('node:fs/promises')).mkdir(primary);
  await exec('git',['init','-q','-b','main',primary]);
  await exec('git',['-C',primary,'config','user.email','test@example.invalid']);
  await exec('git',['-C',primary,'config','user.name','Test']);
  await writeFile(path.join(primary,'AGENTS.md'),'# Fixture');
  await exec('git',['-C',primary,'add','AGENTS.md']);
  await exec('git',['-C',primary,'commit','-m','init','-q']);
  await exec('git',['-C',primary,'worktree','add','-q','-b','pilot/test',secondary]);
  await writeFile(path.join(secondary,'.paperclip-antigravity-allow'),'ALLOW_PAPERCLIP_ANTIGRAVITY_LOCAL\n');
  const mockPoolFile = path.join(root, 'antigravity-accounts.json');
  process.env.PAPERCLIP_ANTIGRAVITY_ACCOUNT_POOL_FILE = mockPoolFile;
  await writeFile(mockPoolFile, JSON.stringify({ version: 1, activeAccount: null, accounts: [] }));
  const exe=path.join(root,'agy-stub');
  await writeFile(exe,`#!/usr/bin/env node
if(process.argv.includes('models')){console.log('gemini-3.8-flash-low    Gemini 3.8 Flash Low');process.exit(0);}
let chunks='';
process.stdin.on('data',d=>chunks+=d);
process.stdin.on('end',()=>{
 if(process.argv.includes('--version')){console.log('agy 1.3.3');process.exit(0);}
 if(process.argv.includes('models')){console.log('gemini-3.8-flash-low    Gemini 3.8 Flash Low');process.exit(0);}
 if(process.argv.includes('--dangerously-skip-permissions') || !process.argv.includes('--sandbox')){console.error('unsafe flags');process.exit(2);}
 const message=JSON.parse(chunks.trim()); const prompt=message.message.content;
 const scenario=prompt.match(/SCENARIO_([A-Z_]+)/)?.[1]||'OK';
 if(scenario==='HANG'){setInterval(()=>{},1000);return;}
 if(scenario==='MALFORMED'){console.log('{not JSON}');process.exit(0);}
 if(scenario==='NO_RESULT'){console.log(JSON.stringify({event:'init',conversation_id:'abcde-123'}));process.exit(0);}
 if(scenario==='QUOTA'){console.error('RESOURCE_EXHAUSTED: quota exceeded 429');process.exit(3);}
 if(scenario==='QUOTA_ONCE'){
   const fs = require('fs');
   const path = require('path');
   const os = require('os');
   const flag = path.join(os.tmpdir(), '.quota_once_hit_' + process.ppid);
   if(!fs.existsSync(flag)){
     fs.writeFileSync(flag, 'hit');
     console.error('RESOURCE_EXHAUSTED: quota exceeded 429. Resets in 30m.');
     process.exit(3);
   }
 }
 if(scenario==='AUTH_FAIL'){console.error('error getting token source: You are not logged into Antigravity.');process.exit(3);}
 if(scenario==='TURN_LIMIT'){console.error('turn_limit: max turns reached');process.exit(53);}
 if(scenario==='UNCLASSIFIED'){console.error('fatal: custom execution error occurred');process.exit(1);}
 if(process.argv.includes('--conversation') && scenario==='FAIL_RESUME'){console.error('conversation not found');process.exit(1);}
 if(scenario==='WRITE'){
   require('fs').writeFileSync('unexpected.txt','unauthorized');
 }
 console.log(JSON.stringify({event:'init',conversation_id:'abcde-123',init:{permission_mode:scenario==='AUTO_APPROVE'?'always-proceed':'request-review'}}));
 console.log(JSON.stringify({event:'step_update',step_update:{step_type:'agent_response',state:'DONE',text_delta:'done'}}));
 if(scenario==='SOFT_DENY')console.error('Tool permission denied by policy');
 const status=scenario==='ERROR'?'ERROR':'SUCCESS';
 console.log(JSON.stringify({event:'result',result:{status,conversation_id:'abcde-123',response:status==='SUCCESS'?'done':'',error:status==='ERROR'?'mock failure':undefined,usage:{input_tokens:123,output_tokens:4,cache_read_tokens:30}}}));
});
`);
  await chmod(exe,0o755);
  const config={command:exe,cwd:secondary,allowedWorkspaceRoot:secondary,executionMode:'planning',model:'gemini-3.8-flash-low',timeoutSec:30,accountPoolFile:mockPoolFile,validateSelectedModelOnRun:true};
  return {root,primary,secondary,exe,config,mockPoolFile};
}
export function fakeContext(config, taskTitle='SCENARIO_OK') {
  const logs=[]; const spawned=[];
  const ctx={runId:'run-123',agent:{id:'agent-123',companyId:'comp-123',name:'Delivery Lead',adapterConfig:config},
    runtime:{sessionId:null,sessionParams:null,sessionDisplayId:null,taskKey:'task-123'},
    config,context:{taskId:'task-123',taskTitle},authToken:'test-token',
    onLog:async(stream,text)=>logs.push([stream,text]),onSpawn:async(meta)=>spawned.push(meta)};
  return {ctx,logs,spawned};
}
export const helpers={
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE:'Agent {{agent.name}} / {{runId}}',
  renderTemplate:(s,data)=>s.replace(/{{\s*([\w.]+)\s*}}/g,(_m,k)=>k==='agent.name'?data.agent.name:k==='runId'?data.runId:''),
  buildPaperclipEnv: agent=>({PAPERCLIP_AGENT_ID:agent.id,PAPERCLIP_COMPANY_ID:agent.companyId}),
};

/** Deterministic model discovery for unit tests. Not wired to exported execute(ctx). */
export const testDeps = {
  discoverModels: async () => [{ id: 'gemini-3.8-flash-low', label: 'Fixture model' }],
};
