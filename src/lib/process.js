import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createOutputInactivityMonitor, resolveInactivityTimeout, formatInactivityErrorMessage } from './inactivity-monitor.js';

/** Process group cancellation on POSIX; bounded stdout, bounded stderr, bounded NDJSON event size. */
export async function runAgy({ command, args, cwd, env, prompt, timeoutMs, graceMs, maxBytes, signal, onSpawn, onEvent, onStderr, outputInactivityTimeoutMs }) {
  if (signal?.aborted) return {code:null, signal:'ABORT', timedOut:false, aborted:true, stderr:'', final:null, reason:'Aborted before spawn'};
  return await new Promise((resolve) => {
    let proc;
    let stdoutBytes=0, stderr='', partial='', malformed=false, final=null, stdoutTruncated=false;
    let timeoutId, killId, timedOut=false, aborted=false, closed=false, settled=false, spawnError=null;
    let inactivityTimedOut = false;
    let pending = Promise.resolve();
    // Slow event consumers must not build an unbounded in-memory queue. Pause
    // both streams and let OS pipe buffers apply backpressure until handlers catch up.
    const HIGH_WATER = 128;
    const LOW_WATER = 48;
    let queueDepth = 0;
    const queueMetrics = { enqueued: 0, peakDepth: 0, peakWaitMs: 0, totalWaitMs: 0, handlerErrors: 0, pausedCount: 0 };
    let streamsPaused = false;
    const pauseStreams = () => {
      if (streamsPaused || queueDepth < HIGH_WATER) return;
      streamsPaused = true;
      queueMetrics.pausedCount++;
      proc?.stdout?.pause();
      proc?.stderr?.pause();
    };
    const resumeStreams = () => {
      if (!streamsPaused || queueDepth > LOW_WATER) return;
      streamsPaused = false;
      proc?.stdout?.resume();
      proc?.stderr?.resume();
    };
    const decoder = new StringDecoder('utf8');
    const queue = (fn) => {
      const enqueuedAt = performance.now();
      queueDepth++;
      queueMetrics.enqueued++;
      queueMetrics.peakDepth = Math.max(queueMetrics.peakDepth, queueDepth);
      pauseStreams();
      pending = pending.then(async () => {
        const waitMs = performance.now() - enqueuedAt;
        queueMetrics.peakWaitMs = Math.max(queueMetrics.peakWaitMs, waitMs);
        queueMetrics.totalWaitMs += waitMs;
        try { await fn(); }
        catch (e) {
          queueMetrics.handlerErrors++;
          spawnError ||= e;
          requestStop('SIGTERM');
        } finally {
          queueDepth--;
          resumeStreams();
        }
      });
    };
    const inactivityRes = resolveInactivityTimeout(outputInactivityTimeoutMs);
    let inactivityMonitor = null;
    if (inactivityRes.mode !== 'disabled') {
      inactivityMonitor = createOutputInactivityMonitor({
        timeoutMs: inactivityRes.timeoutMs,
        onFire: (state) => {
          inactivityTimedOut = true;
          const elapsed = (state.firedAt || Date.now()) - state.spawnedAt;
          spawnError ||= new Error(formatInactivityErrorMessage(elapsed));
          requestStop('SIGTERM');
        },
      });
    }

    const cleanup = () => {
      clearTimeout(timeoutId); clearTimeout(killId);
      inactivityMonitor?.stop();
      signal?.removeEventListener('abort',abort);
    };
    const killGroup=(sig)=>{
      if(!proc?.pid) return;
      if(process.platform !== 'win32') {
        try {process.kill(-proc.pid,sig);return;}catch{}
      }
      try{proc.kill(sig);}catch{}
    };
    const requestStop=(sig)=>{
      killGroup(sig);
      if(!killId) killId=setTimeout(()=>killGroup('SIGKILL'),graceMs);
    };
    const abort=()=>{aborted=true;requestStop('SIGTERM');};
    const finish=async(code,sig)=>{
      if(settled) return; settled=true; cleanup();
      await pending;
      resolve({code,signal:sig,timedOut,inactivityTimedOut,aborted,stderr,final,malformed,stdoutTruncated,reason:spawnError?.message,queueMetrics:{...queueMetrics,avgWaitMs:queueMetrics.enqueued ? queueMetrics.totalWaitMs/queueMetrics.enqueued : 0}});
    };
    try {
      proc=spawn(command,args,{cwd,env,stdio:['pipe','pipe','pipe'],shell:false,detached:process.platform!=='win32',windowsHide:true});
    } catch(e){ resolve({code:null,signal:null,timedOut:false,aborted:false,stderr:'',final:null,reason:e.message});return; }
    proc.on('error',(err)=>{spawnError=err;});
    proc.on('spawn',()=>{
      if(signal?.aborted)abort();
      queue(async()=>{await onSpawn?.({pid:proc.pid,processGroupId:process.platform==='win32'?null:proc.pid,startedAt:new Date().toISOString()});});
      const message = JSON.stringify({event:'user',message:{content:prompt}})+'\n';
      proc.stdin.on('error',()=>{});
      proc.stdin.end(message);
    });
    signal?.addEventListener('abort',abort,{once:true});
    if(timeoutMs>0) timeoutId=setTimeout(()=>{timedOut=true;requestStop('SIGTERM');},timeoutMs);
    const processLine=(line)=>{
      if(!line.trim())return;
      try{
        const evt=JSON.parse(line);
        if(!evt || typeof evt.event!=='string') {malformed=true;return;}
        if(evt.event==='result') {
          if(final!==null) {malformed=true;return;}
          final=evt.result;
        }
        queue(async()=>{ const decision=await onEvent?.(evt); if(decision===false){spawnError ||= new Error('Antigravity runtime permission policy is unsafe');requestStop('SIGTERM');} });
      } catch { malformed=true; }
    };
    proc.stdout.on('data',(buf)=>{
      stdoutBytes+=buf.length;
      inactivityMonitor?.noteOutputChunk('stdout', buf.toString('utf8'));
      if(stdoutBytes>maxBytes) {stdoutTruncated=true;requestStop('SIGTERM');return;}
      partial+=decoder.write(buf);
      if(partial.length>maxBytes) {stdoutTruncated=true;requestStop('SIGTERM');return;}
      let ix;while((ix=partial.indexOf('\n'))>=0){const l=partial.slice(0,ix);partial=partial.slice(ix+1);processLine(l);}
    });
    proc.stderr.on('data',(buf)=>{
      const text=buf.toString('utf8');
      inactivityMonitor?.noteOutputChunk('stderr', text);
      stderr=(stderr+text).slice(-65536);
      queue(()=>onStderr?.(text));
    });
    proc.on('close',(code,sig)=>{
      partial+=decoder.end();if(partial.trim())processLine(partial);
      closed=true;
      void finish(code,sig);
    });
  });
}
