import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelValidationCache } from '../src/lib/model-validation-cache.js';

const models = [{id:'model-1'},{id:'model-2'}];
test('validation reuses only the same identity within its TTL and never caches unknown identities', async () => {
  let time=0, calls=0;
  const cache=createModelValidationCache({ttlMs:60,now:()=>time});
  const load=async()=>{calls++;return models;};
  assert.equal((await cache.get('account-a:credential-1:binary-1',load)).cacheHit,false);
  const reused=await cache.get('account-a:credential-1:binary-1',load);
  assert.equal(reused.cacheHit,true);
  reused.models[0].id='mutated';
  assert.equal((await cache.get('account-a:credential-1:binary-1',load)).models[0].id,'model-1');
  for(const key of ['account-b:credential-1:binary-1','account-a:credential-2:binary-1','account-a:credential-1:binary-2',null,null]) await cache.get(key,load);
  assert.equal(calls,6);
  time=60;
  assert.equal((await cache.get('account-a:credential-1:binary-1',load)).cacheHit,false);
});
test('concurrent lookups share discovery; invalidation prevents an in-flight result repopulating the cache',async()=>{
  const cache=createModelValidationCache();
  let finish,calls=0;
  const load=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
  const first=cache.get('identity',load), second=cache.get('identity',load);
  assert.equal(calls,1);
  cache.clear();finish(models);
  const stale=await first;await second;
  stale.confirm('model-1');
  assert.equal((await cache.get('identity',async()=>{calls++;return models;})).cacheHit,false);
  assert.equal(calls,2);
});
test('errors never authorize a later run and successful turns renew only the selected model',async()=>{
  let time=0;
  const cache=createModelValidationCache({ttlMs:60,now:()=>time});
  await assert.rejects(cache.get('identity',async()=>{throw Error('auth failed');}),/auth failed/);
  const first=await cache.get('identity',async()=>models);
  time=100;first.confirm('model-1');
  assert.deepEqual((await cache.get('identity',async()=>{throw Error('unexpected lookup');})).models,[{id:'model-1'}]);
  time=160;
  await assert.rejects(cache.get('identity',async()=>{throw Error('refresh failed');}),/refresh failed/);
  await assert.rejects(cache.get('identity',async()=>[]),/No models/);
});
