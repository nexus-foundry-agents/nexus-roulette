// -- Nexus Casino spin queue -------------------------------------------------------------------------
//
// The spins Casino has not confirmed yet, sent strictly in spin order. Everything the queue needs from its
// surroundings arrives through `deps`, so the queue is tested without the bridge or the screen.
// nexus-src/build.js concatenates this file ahead of casino-recording.mjs, which reads these names from the
// bundle scope.

export const SPIN_RETRY_MS = 10000;
const SPIN_ATTEMPTS = 3;
const SPIN_RETRY_COPY = 'Casino has not confirmed that spin yet. Retrying the same sequence.';
const PAIR_RETRY_COPY = 'Casino has not confirmed the spin-and-pause yet. Retrying the same sequence.';

export const retryDelay = (milliseconds) => new Promise(function(resolve){ setTimeout(resolve,milliseconds); });

/**
 * Keep one idempotent spin at the head of the queue until the server gives a definitive answer.
 * A timeout or 5xx can happen after the database commit, so the retry MUST carry the identical
 * sequence and payload. `recorded:false` reconciles only after such an ambiguous attempt; on the
 * first attempt it means the client arrived with a stale sequence and must not advance over it.
 * `priorAmbiguous` carries an ambiguous attempt made by an earlier call, so a later retry reconciles
 * the same way instead of reading the server's duplicate answer as a stale sequence.
 */
export async function sendCasinoSpinUntilReconciled(payload,send=askCasino,wait=retryDelay,onRetry,maxAttempts=3,priorAmbiguous=false) {
  let ambiguous=priorAmbiguous;
  for(let attempt=0;attempt<maxAttempts;attempt++) {
    let result;
    try{result=await send('spin',payload);}
    catch(error){result={ok:false,status:0,error:error&&error.message?error.message:'Casino recording request failed'};}
    if(result.ok) {
      const recorded=result.body&&result.body.recorded;
      if(recorded===true) return {...result,reconciled:false};
      if(recorded===false&&ambiguous) return {...result,reconciled:true};
      if(recorded===false) return {ok:false,status:409,ambiguous,error:'That recording sequence already existed before this spin.'};
      return {ok:false,status:0,ambiguous:true,error:'Casino returned no recording verdict for that spin.'};
    }
    if(result.status!==0&&result.status<500) return {...result,ambiguous};
    ambiguous=true;
    if(onRetry) onRetry(attempt+1);
    if(attempt+1<maxAttempts)await wait(Math.min(1000*(attempt+1),5000));
  }
  return {ok:false,status:0,ambiguous:true,error:'Casino still has not confirmed that spin; it remains queued locally.'};
}

/** The first request both records the pending spin and banks duration; it never waits to ask pause. */
export function sendCasinoSpinAndPause(payload,send=askCasino,wait=retryDelay,onRetry,maxAttempts=3,priorAmbiguous=false) {
  return sendCasinoSpinUntilReconciled(
    {...payload,spin:{...payload.spin,pauseAfter:true}},send,wait,onRetry,maxAttempts,priorAmbiguous,
  );
}

/** The problem line for spins Casino has not confirmed. */
export function spinsWaitingCopy(count) {
  return count+(count===1?' spin':' spins')+' waiting to send to Casino.';
}

/** The problem line for spins that were queued and never saved, with the reason. */
export function spinsNotSavedCopy(count,reason) {
  return count+(count===1?' spin was':' spins were')+' not saved to Casino: '+reason+'.';
}

/** Casino refused the spin for a reason that retrying the same request cannot change (a 4xx). */
export function isDefinitiveRefusal(result) {
  return result.status!==0&&result.status<500;
}

export function isRecordingDisabledResult(result){
  return !!(result&&result.status===409&&result.body&&result.body.error==='recording_disabled');
}

export function nextSequenceForSession(previousSessionId,previousSequence,nextSession){
  if(!nextSession||!Number.isInteger(nextSession.spins))return previousSequence;
  const fromServer=nextSession.spins+1;
  return previousSessionId===nextSession.id?Math.max(previousSequence,fromServer):fromServer;
}

/**
 * Spins Casino has not confirmed yet, sent strictly in spin order. A spin is numbered and bound to its
 * session on its first send. Every retry of that send carries the same sequence and request id, so Casino
 * sees the same spin again and never records it twice. A spin leaves the queue when Casino confirms it.
 * Two answers drop the whole queue and say how many spins were not saved: Casino refusing recording, and
 * Casino saying the session the spins belonged to has ended.
 *
 * deps.resolveSession() -> {ok:true,session} | {ok:false,off:true} | {ok:false,error}
 * deps.send(op,payload), deps.wait(ms) (defaults to retryDelay), deps.pauseRequested() -> boolean
 * deps.reread() -> {ok:true,session|null} | {ok:false,error}   (the session as Casino holds it now)
 * deps.report(text|null), deps.confirmed(body), deps.recordingOff(count), deps.ended(session|null)
 * deps.drained(), deps.schedule(fn,ms) -> cancel
 *
 * Returned: enqueue; submit (a new spin; a held queue only takes it, and the retry timer sends it);
 * flush (a round now); observe; waiting; held; discard (drops every queued spin and returns the count);
 * dispose (after it, nothing is sent, reported or confirmed).
 */
export function createSpinQueue(deps) {
  const entries=[];
  const cursor={sessionId:null,next:1};
  const wait=deps.wait||retryDelay;
  let chain=Promise.resolve();
  let cancelRetry=null;
  let isHeld=false;
  let heldDetail='';
  let disposed=false;
  // Moves on every discard, end and dispose, so a round that resumes after one of them stops at once.
  let epoch=0;

  function observe(session) {
    if(!session||!Number.isInteger(session.spins)) return;
    cursor.next=nextSequenceForSession(cursor.sessionId,cursor.next,session);
    cursor.sessionId=session.id;
  }
  function stopRetry() {
    const cancel=cancelRetry;
    cancelRetry=null;
    if(cancel) cancel();
  }
  function scheduleRetry() {
    if(disposed||cancelRetry||!entries.length||!deps.schedule) return;
    cancelRetry=deps.schedule(function(){ cancelRetry=null; void runRound(true); },SPIN_RETRY_MS)||function(){};
  }
  function reportHeld() {
    if(!disposed) deps.report(spinsWaitingCopy(entries.length)+(heldDetail?' '+heldDetail:''));
  }
  // The queue keeps every spin and says why. The retry timer makes the next attempt.
  function hold(detail) {
    if(disposed) return false;
    if(!entries.length){ isHeld=false; return false; }
    isHeld=true;
    heldDetail=detail||'';
    reportHeld();
    scheduleRetry();
    return false;
  }
  // Drops every queued spin. An ambiguous head may already be in Casino's record, so its number stays used.
  function dropEntries() {
    const head=entries[0];
    if(head&&head.ambiguous&&head.sessionId!==null&&cursor.sessionId===head.sessionId) {
      cursor.next=Math.max(cursor.next,head.sequence+1);
    }
    entries.length=0;
    epoch+=1;
    isHeld=false;
    heldDetail='';
    stopRetry();
  }
  function refuseRecording() {
    const count=entries.length;
    dropEntries();
    deps.recordingOff(count);
    return false;
  }
  // A definitive refusal of the head: Casino is asked for the session as it stands. If the session has ended,
  // the queue is dropped and counted. If it is live, the head takes the next number from Casino's count and
  // keeps its request id. The retry timer sends it, so a live session that keeps refusing is not hammered.
  async function settleRefusal(head,result,current) {
    const read=await deps.reread();
    if(!current()) return false;
    if(!read||!read.ok) return hold(read&&read.error?read.error:'Casino did not answer the session check.');
    const session=read.session;
    if(!session||session.id!==head.sessionId||session.status==='stopped') {
      const count=entries.length;
      dropEntries();
      if(deps.ended) deps.ended(session||null);
      deps.report(spinsNotSavedCopy(count,'the session ended'));
      return false;
    }
    observe(session);
    head.sequence=cursor.next;
    return hold(result.error||('Casino did not record that spin ('+result.status+').'));
  }
  function enqueue(spin) {
    entries.push({
      requestId:crypto.randomUUID(),
      spin:{...spin,net:spin.returned-spin.staked},
      sessionId:null,sequence:null,pauseAfter:false,ambiguous:false,
    });
    return entries.length;
  }
  async function drain() {
    const round=epoch;
    const current=function(){ return !disposed&&epoch===round; };
    while(entries.length) {
      const head=entries[0];
      if(head.sessionId===null) {
        const resolved=await deps.resolveSession();
        if(!current()) return false;
        if(!resolved.ok) return resolved.off?refuseRecording():hold(resolved.error);
        observe(resolved.session);
        head.sessionId=resolved.session.id;
        head.sequence=cursor.next;
      }
      // Decided at every send from the intent as it stands now. Only the last queued spin can carry the pause.
      head.pauseAfter=entries.length===1&&!!deps.pauseRequested();
      const payload={sessionId:head.sessionId,spin:{...head.spin,requestId:head.requestId,sequence:head.sequence}};
      const copy=head.pauseAfter?PAIR_RETRY_COPY:SPIN_RETRY_COPY;
      const onRetry=function(){ if(current()) deps.report(copy); };
      const result=head.pauseAfter
        ? await sendCasinoSpinAndPause(payload,deps.send,wait,onRetry,SPIN_ATTEMPTS,head.ambiguous)
        : await sendCasinoSpinUntilReconciled(payload,deps.send,wait,onRetry,SPIN_ATTEMPTS,head.ambiguous);
      if(!current()) return false;
      if(!result.ok) {
        if(isRecordingDisabledResult(result)) return refuseRecording();
        if(isDefinitiveRefusal(result)) return settleRefusal(head,result,current);
        head.ambiguous=head.ambiguous||result.ambiguous===true;
        return hold(result.error||('Casino did not record that spin ('+result.status+').'));
      }
      entries.shift();
      isHeld=false;
      heldDetail='';
      if(cursor.sessionId===head.sessionId) cursor.next=head.sequence+1;
      deps.confirmed(result.body);
      deps.report(null);
    }
    if(!current()) return false;
    stopRetry();
    deps.report(null);
    if(deps.drained) deps.drained();
    return true;
  }
  // One round, in order. A round the timer or a caller forces runs even while held; a round asked for by a new
  // spin does not, because the retry timer owns the retries of a held queue.
  function runRound(forced) {
    chain=chain.then(function(){
      if(disposed) return false;
      if(!entries.length) return true;
      if(isHeld&&!forced){ reportHeld(); return false; }
      return drain();
    }).catch(function(error){
      return hold(error&&error.message?error.message:'Casino recording failed.');
    });
    return chain;
  }
  return {
    enqueue,
    flush:function(){ return runRound(true); },
    submit:function(spin){
      enqueue(spin);
      if(isHeld){ reportHeld(); return Promise.resolve(false); }
      return runRound(false);
    },
    observe,
    waiting:function(){ return entries.length; },
    held:function(){ return isHeld&&entries.length>0; },
    discard:function(){
      const count=entries.length;
      if(count) dropEntries();
      return count;
    },
    dispose:function(){
      disposed=true;
      epoch+=1;
      isHeld=false;
      stopRetry();
    },
  };
}
