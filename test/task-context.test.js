import test from 'node:test';
import assert from 'node:assert/strict';
import {taskContext,dependencySummary} from '../src/lib/task-context.js';
import {buildPrompt,staticTaskDigest} from '../src/server/execute.js';
import {helpers} from './fixtures.js';

test('delivers nested Paperclip assignments and detects description changes on resume',()=>{
 const context={paperclipWake:{issue:{id:'issue-1',identifier:'BUC-5',title:'Issuance',description:'Required acceptance gaps',parentId:'parent'},ancestors:[{id:'parent',title:'OTP umbrella'}],blockedBy:[{identifier:'BUC-7',status:'done'}]}};
 const ctx={context,agent:{id:'agent',companyId:'company'}};
 const config={maxPromptBytes:100000,executionMode:'implementation'};
 const prompt=buildPrompt(ctx,config,'',helpers,'',{workspaceCwd:'/trusted/feature',workspaceBranch:'feature'});
 assert.match(prompt,/Task title: Issuance/);assert.match(prompt,/Required acceptance gaps/);
 assert.match(prompt,/Parent epic title: OTP umbrella/);assert.match(prompt,/BUC-7 \(done\)/);
 assert.match(prompt,/Assigned checkout: \/trusted\/feature/);
 const old=staticTaskDigest(context);
 context.paperclipWake.issue.description='Changed acceptance criteria';
 assert.notEqual(staticTaskDigest(context),old);
 assert.match(buildPrompt(ctx,config,'',helpers,'',{compactResume:true,staticContextChanged:true}),/Changed acceptance criteria/);
});
test('explicit context wins and dependency objects never become object Object',()=>{
 assert.equal(taskContext({taskTitle:'Explicit',paperclipWake:{issue:{title:'Nested'}}}).taskTitle,'Explicit');
 assert.equal(dependencySummary(['BUC-3',{identifier:'BUC-7',status:'done'}]),'BUC-3, BUC-7 (done)');
});

test('cooperative budget survives UI config and validates bounds without skipping required checks',async()=>{
 const {normalizeConfig}=await import('../src/lib/config.js');
 const {buildAntigravityLocalConfig}=await import('../src/ui/build-config.js');
 const raw={cwd:'/worktrees/task',allowedWorkspaceRoot:'/worktrees',model:'fixture-model',investigationBudget:8};
 const cfg=normalizeConfig(buildAntigravityLocalConfig(raw));
 assert.equal(cfg.investigationBudget,8);
 assert.throws(()=>normalizeConfig({...raw,investigationBudget:3}),/4–100/);
 assert.match(buildPrompt({context:{},agent:{id:'a'}},cfg,'',helpers),/Initial investigation budget: 8 tool calls/);
 assert.equal(taskContext({paperclipWake:{unresolvedBlockerSummaries:[{identifier:'BUC-7',status:'todo'}]}}).dependencies[0].identifier,'BUC-7');
});
