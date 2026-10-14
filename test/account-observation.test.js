import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { observeExecutionAccount } from '../src/lib/account.js';
import { writeObservedStatus } from '../src/lib/statusline.js';
import { makeMockToken } from './fixtures.js';

async function isolate(t) {
 const root=await mkdtemp(path.join(tmpdir(),'agy-observation-'));
 const keys=['PAPERCLIP_AGY_STATUS_FILE','PAPERCLIP_TEST_KEYCHAIN_PAYLOAD','PAPERCLIP_ANTIGRAVITY_LIVE_KEYCHAIN'];
 const before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 process.env.PAPERCLIP_AGY_STATUS_FILE=path.join(root,'status.json');
 process.env.PAPERCLIP_ANTIGRAVITY_LIVE_KEYCHAIN='1';
 t.after(async()=>{for(const key of keys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}await rm(root,{recursive:true,force:true});});
 return process.env.PAPERCLIP_AGY_STATUS_FILE;
}
test('a fresh execution observes keychain once and changes its private generation when credentials rotate',async t=>{
 await isolate(t);let calls=0,raw=makeMockToken('first@example.com');
 const runner=async()=>{calls++;return {stdout:raw};};
 const first=await observeExecutionAccount(runner,'darwin');
 assert.equal(calls,1);assert.equal(first.active.email,'first@example.com');
 assert.equal(first.validationIdentity.expired,false);
 assert.ok(!JSON.stringify(first).includes(raw));
 const decoded=JSON.parse(Buffer.from(raw.slice('go-keyring-base64:'.length),'base64').toString());
 decoded.token.access_token='rotated';raw='go-keyring-base64:'+Buffer.from(JSON.stringify(decoded)).toString('base64');
 const second=await observeExecutionAccount(runner,'darwin');
 assert.equal(second.active.email,first.active.email);
 assert.notEqual(second.validationIdentity.credentialVersion,first.validationIdentity.credentialVersion);
});
test('unavailable, expired or unverifiable credentials cannot authorize validation reuse',async t=>{
 await isolate(t);
 const unknown=await observeExecutionAccount(async()=>{throw Error('keychain denied');},'darwin');
 assert.equal(unknown.validationIdentity.credentialVersion,null);assert.equal(unknown.validationIdentity.expired,true);
 for(const expiry of [null,'invalid','2000-01-01T00:00:00Z']) {
  const data=JSON.parse(Buffer.from(makeMockToken('first@example.com').slice('go-keyring-base64:'.length),'base64').toString());
  data.token.expiry=expiry;
  const raw='go-keyring-base64:'+Buffer.from(JSON.stringify(data)).toString('base64');
  assert.equal((await observeExecutionAccount(async()=>({stdout:raw}),'darwin')).validationIdentity.expired,true);
 }
});
test('fresh terminal and headless credential disagreement fails before dispatch',async t=>{
 const file=await isolate(t);
 await writeObservedStatus({email:'terminal@example.com'},file);
 await assert.rejects(observeExecutionAccount(async()=>({stdout:makeMockToken('headless@example.com')}),'darwin'),/disagree/);
});
