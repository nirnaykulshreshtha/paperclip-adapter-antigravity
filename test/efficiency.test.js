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
test('deduplicates repeated lifecycle events and records failed calls',()=>{
 const t=createEfficiencyTracker();t.start('x','run_command',{command:'test'});t.start('x','run_command',{command:'test'});
 t.complete('x','failure',true);t.complete('x','failure',true);
 assert.equal(t.snapshot().toolCalls,1);assert.equal(t.snapshot().completedToolCalls,1);assert.equal(t.snapshot().failedToolCalls,1);
});
