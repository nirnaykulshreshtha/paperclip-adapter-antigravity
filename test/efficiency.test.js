import test from 'node:test';
import assert from 'node:assert/strict';
import {createEfficiencyTracker} from '../src/lib/efficiency.js';

test('tracks identical requests and unchanged results without warning on changed output',()=>{
 const t=createEfficiencyTracker();
 t.start('1','view_file',{path:'a',start:1});t.complete('1','first',false);
 t.start('2','view_file',{start:1,path:'a'});assert.equal(t.complete('2','changed',false),false);
 t.start('3','view_file',{path:'a',start:1});assert.equal(t.complete('3','changed',false),false);
 t.start('4','view_file',{path:'a',start:1});assert.equal(t.complete('4','changed',false),true);
 t.start('5','view_file',{path:'a',start:2});assert.equal(t.complete('5','changed',false),false);
 assert.equal(t.snapshot().exactRepeatCalls,3);
 assert.equal(t.snapshot().unchangedRepeatResults,2);
 assert.equal(JSON.stringify(t.snapshot()).includes('path'),false);
});
test('repeat detection survives verified conversation turns without retaining raw requests or outputs',()=>{
 let tracker=createEfficiencyTracker();
 tracker.start('1','view_file',{path:'private-file'});tracker.complete('1','private-output',false);
 tracker=createEfficiencyTracker(tracker.history());
 tracker.start('1','view_file',{path:'private-file'});assert.equal(tracker.complete('1','private-output',false),false);
 tracker=createEfficiencyTracker(tracker.history());
 tracker.start('1','view_file',{path:'private-file'});assert.equal(tracker.complete('1','private-output',false),true);
 assert.equal(tracker.snapshot().exactRepeatCalls,1);
 assert.equal(tracker.snapshot().unchangedRepeatResults,1);
 assert.ok(!JSON.stringify(tracker.history()).includes('private'));
 assert.equal(createEfficiencyTracker().snapshot().exactRepeatCalls,0);
});
test('repeat history stays bounded and rejects untrusted session contents',()=>{
 const tracker=createEfficiencyTracker({requests:[['raw command',999999999]],results:[['raw output',1]]});
 for(let i=0;i<200;i++){tracker.start(String(i),'view_file',{path:String(i)});tracker.complete(String(i),'output',false);}
 assert.equal(tracker.history().requests.length,64);assert.equal(tracker.history().results.length,64);
 assert.ok(!JSON.stringify(tracker.history()).includes('raw'));
});
test('deduplicates repeated lifecycle events and records failed calls',()=>{
 const t=createEfficiencyTracker();t.start('x','run_command',{command:'test'});t.start('x','run_command',{command:'test'});
 t.complete('x','failure',true);t.complete('x','failure',true);
 assert.equal(t.snapshot().toolCalls,1);assert.equal(t.snapshot().completedToolCalls,1);assert.equal(t.snapshot().failedToolCalls,1);
});
