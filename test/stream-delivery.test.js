import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createStreamDelivery } from '../src/lib/stream-delivery.js';

test('bursts retain every text delta and deliver only the latest replaceable progress',async()=>{
  const texts=[], progress=[];
  const delivery=createStreamDelivery({onText:async text=>texts.push(text),onProgress:async value=>progress.push(value),intervalMs:60_000,maxTextBytes:64*1024});
  for(let i=0;i<1000;i++){await delivery.text('🙂');delivery.progress({message:String(i)});}
  await delivery.flush();
  assert.equal(texts.join(''),'🙂'.repeat(1000));
  assert.deepEqual(progress,[{message:'999'}]);
  assert.deepEqual(delivery.snapshot(),{textDeltas:1000,textBatches:1,progressUpdates:1000,progressDelivered:1});
  await delivery.close();
});
test('slow consumers apply bounded backpressure and callback delivery never overlaps',async()=>{
  let finish, active=0, peak=0;
  const texts=[];
  const delivery=createStreamDelivery({maxTextBytes:4,intervalMs:60_000,onText:async text=>{
    active++;peak=Math.max(peak,active);texts.push(text);
    if(text==='1234')await new Promise(resolve=>{finish=resolve;});
    active--;
  }});
  const first=delivery.text('1234');
  await setImmediate();
  const second=delivery.text('5678');
  await setImmediate();
  assert.deepEqual(texts,['1234']);
  finish();await Promise.all([first,second]);await delivery.close();
  assert.deepEqual(texts,['1234','5678']);assert.equal(peak,1);
});
test('callback errors remain visible at boundaries and close rather than silently dropping output',async()=>{
  const delivery=createStreamDelivery({onText:async()=>{throw Error('persistence failed');},intervalMs:60_000});
  await delivery.text('must be audited');
  await assert.rejects(delivery.flush(),/persistence failed/);
  await assert.rejects(delivery.text('later'),/persistence failed/);
  await assert.rejects(delivery.close(),/persistence failed/);
});
test('timer flushes low-volume streams before completion',async()=>{
  let received;
  const observed=new Promise(resolve=>{received=resolve;});
  const delivery=createStreamDelivery({onText:async text=>received(text),intervalMs:5});
  await delivery.text('live text');
  // A referenced timer keeps the test alive while the delivery timer is unref'd.
  const keepAlive=setTimeout(()=>received('timeout'),1000);
  try{assert.equal(await observed,'live text');}finally{clearTimeout(keepAlive);await delivery.close();}
});
