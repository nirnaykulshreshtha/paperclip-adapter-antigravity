import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createOrderedDelivery } from '../src/lib/ordered-delivery.js';

test('slow persistence runs independently until its bounded budget applies backpressure',async()=>{
  let release,active=0,peak=0;
  const received=[];
  const delivery=createOrderedDelivery(async value=>{
    active++;peak=Math.max(peak,active);
    if(value===1)await new Promise(resolve=>{release=resolve;});
    received.push(value);active--;
  },{maxItems:2,maxBytes:100});
  await delivery.append(1);await delivery.append(2);
  let accepted=false;
  const third=delivery.append(3).then(()=>{accepted=true;});
  await setImmediate();assert.equal(accepted,false);assert.deepEqual(received,[]);
  release();await third;await delivery.flush();
  assert.deepEqual(received,[1,2,3]);assert.equal(peak,1);
  assert.equal(delivery.snapshot().peakItems,2);
  assert.ok(delivery.snapshot().backpressureCount>0);
});
test('byte budget applies backpressure and flush propagates sticky callback failure',async()=>{
  const delivery=createOrderedDelivery(async()=>{throw Error('disk unavailable');},{maxBytes:8});
  await delivery.append('12345678');
  await assert.rejects(delivery.flush(),/disk unavailable/);
  await assert.rejects(delivery.append('later'),/disk unavailable/);
  assert.throws(()=>delivery.check(),/disk unavailable/);
});
test('frequent append/flush boundaries neither lose nor reorder events',async()=>{
  const received=[];
  const delivery=createOrderedDelivery(async value=>{received.push(value);});
  for(let i=0;i<200;i++){await delivery.append(i);if(i%3===0)await delivery.flush();}
  await delivery.flush();
  assert.deepEqual(received,Array.from({length:200},(_,i)=>i));
  assert.equal(delivery.snapshot().delivered,200);
});
