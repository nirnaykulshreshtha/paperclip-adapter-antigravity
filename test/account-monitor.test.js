import test from 'node:test';
import assert from 'node:assert/strict';
import { monitorAccount } from '../src/lib/account-monitor.js';

test('a running task observes account switches once and stops polling on completion', async () => {
  let email='first@example.com';
  let calls=0;
  const changes=[];
  let changed;
  const change=new Promise(resolve=>{changed=resolve;});
  const stop=monitorAccount({initialEmail:email,intervalMs:5,
    detect:async()=>{calls++;return email ? {email} : null;},
    onChange:async(next,previous)=>{changes.push([next,previous]);changed();}});
  try {
    email=null;
    await new Promise(resolve=>setTimeout(resolve,15));
    assert.deepEqual(changes,[]);
    email='second@example.com';
    await change;
    await new Promise(resolve=>setTimeout(resolve,15));
    assert.deepEqual(changes,[['second@example.com','first@example.com']]);
  } finally {await stop();}
  const stoppedCalls=calls;
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(calls,stoppedCalls);
});
