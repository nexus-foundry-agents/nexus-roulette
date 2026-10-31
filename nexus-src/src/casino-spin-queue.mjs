// -- Nexus Casino spin queue -------------------------------------------------------------------------
//
// The spins Casino has not confirmed yet, sent strictly in spin order. Everything the queue needs from its
// surroundings arrives through `deps`, so the queue is tested without the bridge or the screen.
// nexus-src/build.js concatenates this file ahead of casino-recording.mjs, which reads these names from the
// bundle scope.

export const SPIN_RETRY_MS = 10000;
const SPIN_ATTEMPTS = 3;
// A live session that refuses the same head this many times in a row loses that spin, and only that spin.
export const SPIN_REFUSAL_LIMIT = 3;
const SPIN_RETRY_COPY = 'Casino has not confirmed that spin yet. Retrying the same sequence.';
const PAIR_RETRY_COPY = 'Casino has not confirmed the spin-and-pause yet. Retrying the same sequence.';

export const retryDelay = (milliseconds) => new Promise(function(resolve){ setTimeout(resolve,milliseconds); });

// The request id names one spin on every retry, so it must differ between spins. randomUUID needs a secure context.
// Without it the id is read from getRandomValues in the same UUID shape. Without that too, it is the time and a
// counter: unique within a page, and between pages only by the time.
let requestIdCounter = 0;
function uuidFromHex(hex) {
  return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20,32);
}
export function newRequestId() {
  const source = typeof crypto !== 'undefined' ? crypto : null;
  if(source && typeof source.randomUUID === 'function') return source.randomUUID();
  if(source && typeof source.getRandomValues === 'function') {
    try {
      const bytes = source.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      return uuidFromHex(Array.from(bytes, function(byte){ return byte.toString(16).padStart(2,'0'); }).join(''));
    } catch(_error) {
      // Fall through to the time and a counter.
    }
  }
  requestIdCounter += 1;
  const count = requestIdCounter.toString(16).padStart(8,'0').slice(-8);
  const time = Date.now().toString(16).padStart(12,'0').slice(-12);
  return count+'-0000-4000-8000-'+time;
}

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

/** The problem line while a paused session holds the queue. Its spins wait for a resume. */
export function pausedHoldCopy(count) {
  return 'Casino recording is paused. Resume it to send '+count+(count===1?' waiting spin.':' waiting spins.');
}

/** The problem line for spins that were queued and never saved, with the reason. */
export function spinsNotSavedCopy(count,reason) {
  return count+(count===1?' spin was':' spins were')+' not saved to Casino: '+reason+'.';
}

/**
 * The problem line for spins the queue dropped. A spin whose send may have been recorded is counted as may
 * have been saved, and never as not saved.
 */
export function spinsDroppedCopy(count,maybeSaved,reason) {
  const maybe=Math.min(count,maybeSaved||0);
  const notSaved=count-maybe;
  const parts=[];
  if(maybe) parts.push(maybe+(maybe===1?' spin may have':' spins may have')+' been saved to Casino');
  if(notSaved) parts.push(notSaved+(notSaved===1?' spin was':' spins were')+' not saved to Casino');
  return parts.join(' and ')+': '+reason+'.';
}

/** The problem line for the one head that a live session refused three times in a row. */
export function refusedSpinCopy(maybeSaved,reason) {
  const text=String(reason).replace(/\.$/,'');
  return (maybeSaved?'1 spin may have been saved to Casino: ':'1 spin could not be saved to Casino: ')+text+'.';
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
 * A drop always says how many spins it dropped: Casino refusing recording (every queued spin), Casino saying
 * the session the spins belonged to has ended (every queued spin), and a live session refusing the same head
 * three times in a row (that head alone).
 *
 * deps.resolveSession() -> {ok:true,session} | {ok:false,off:true} | {ok:false,error}
 * deps.send(op,payload), deps.wait(ms) (defaults to retryDelay), deps.pauseRequested() -> boolean
 * deps.reread() -> {ok:true,session|null} | {ok:false,error}   (the session as Casino holds it now)
 * deps.report(text|null), deps.confirmed(body,info), deps.recordingOff(count), deps.ended(session|null)
 * deps.drained(), deps.schedule(fn,ms) -> cancel
 *
 * info = {reconciled, pauseCarried}: the spin was confirmed after an ambiguous send, and an attempt of it
 * carried pauseAfter.
 *
 * Returned: enqueue; submit (a new spin; a held queue only takes it, and the retry timer sends it); flush
 * (a round now); observe; waiting; held; pausedHeld (held behind a paused session); discard (async: waits
 * for a send in flight, drops every queued spin, resolves {count, maybeSaved}); reopen (after dispose, takes
 * spins again); dispose (after it, nothing is sent, reported or confirmed).
 */
export function createSpinQueue(deps) {
  const entries=[];
  const cursor={sessionId:null,next:1};
  const wait=deps.wait||retryDelay;
  let chain=Promise.resolve();
  let cancelRetry=null;
  let isHeld=false;
  let heldDetail='';
  let heldPaused=false;
  let disposed=false;
  // Set while a discard waits for a send in flight. The round stops before its next send, and the discard drops what is left.
  let discarding=false;
  // The line about spins dropped earlier. It stays on screen until the next spin is made.
  let notice=null;
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
  // Every problem line goes through here, so the line about dropped spins is not lost to a status line.
  function say(text) {
    if(disposed) return;
    deps.report(notice ? (text ? notice+' '+text : notice) : text);
  }
  function reportHeld() {
    say(heldPaused ? pausedHoldCopy(entries.length) : spinsWaitingCopy(entries.length)+(heldDetail?' '+heldDetail:''));
  }
  // The queue keeps every spin and says why. A live hold is retried on the timer. A paused hold waits for a
  // resume, and sends nothing to a session Casino says is paused.
  function hold(detail,paused) {
    if(disposed) return false;
    if(!entries.length){ isHeld=false; return false; }
    isHeld=true;
    heldDetail=detail||'';
    heldPaused=!!paused;
    reportHeld();
    if(heldPaused) stopRetry(); else scheduleRetry();
    return false;
  }
  function clearHold() {
    isHeld=false;
    heldDetail='';
    heldPaused=false;
  }
  // Drops the head alone. An ambiguous head may already be in Casino's record, so its number stays used.
  function dropHead() {
    const head=entries.shift();
    if(head&&head.ambiguous&&head.sessionId!==null&&cursor.sessionId===head.sessionId) {
      cursor.next=Math.max(cursor.next,head.sequence+1);
    }
    return head;
  }
  // Drops every queued spin.
  function dropEntries() {
    dropHead();
    entries.length=0;
    epoch+=1;
    clearHold();
    stopRetry();
  }
  function refuseRecording() {
    const count=entries.length;
    dropEntries();
    deps.recordingOff(count);
    return false;
  }
  // A definitive refusal of the head. Casino is asked for the session as it stands.
  //  - The session has ended: every queued spin is dropped and counted.
  //  - The session is paused: the queue holds, with no renumber and no retry, until a resume.
  //  - The session is live: the head takes the next number from Casino's count, unless it was sent ambiguously,
  //    since an earlier attempt may already hold its number. Three refusals in a row drop that head alone.
  // Returns true when one spin was dropped and the queue should go on now.
  async function settleRefusal(head,result,current) {
    const read=await deps.reread();
    if(!current()||discarding) return false;
    if(!read||!read.ok) return hold(read&&read.error?read.error:'Casino did not answer the session check.');
    const session=read.session;
    if(!session||session.id!==head.sessionId||session.status==='stopped') {
      const count=entries.length;
      const maybe=head.ambiguous?1:0;
      dropEntries();
      if(deps.ended) deps.ended(session||null);
      say(spinsDroppedCopy(count,maybe,'the session ended'));
      return false;
    }
    if(session.status==='paused') {
      head.refusals=0;
      return hold('',true);
    }
    observe(session);
    head.refusals=(head.refusals||0)+1;
    const reason=result.error||('Casino did not record that spin ('+result.status+').');
    if(head.refusals>=SPIN_REFUSAL_LIMIT) {
      const maybe=head.ambiguous?1:0;
      dropHead();
      clearHold();
      notice=refusedSpinCopy(maybe,reason);
      say(null);
      return true;
    }
    if(!head.ambiguous) head.sequence=cursor.next;
    return hold(reason);
  }
  function enqueue(spin) {
    // A new spin is the next action, so the line about earlier drops gives way to the queue's own status.
    notice=null;
    entries.push({
      requestId:newRequestId(),
      spin:{...spin,net:spin.returned-spin.staked},
      sessionId:null,sequence:null,
      pauseAfter:false,pauseSent:false,ambiguous:false,refusals:0,
    });
    return entries.length;
  }
  async function drain() {
    const round=epoch;
    const current=function(){ return !disposed&&epoch===round; };
    while(entries.length) {
      if(discarding) return false;
      const head=entries[0];
      if(head.sessionId===null) {
        const resolved=await deps.resolveSession();
        if(!current()||discarding) return false;
        if(!resolved.ok) return resolved.off?refuseRecording():hold(resolved.error);
        observe(resolved.session);
        head.sessionId=resolved.session.id;
        head.sequence=cursor.next;
      }
      // Decided at every send from the intent as it stands now. Only the last queued spin can carry the pause.
      head.pauseAfter=entries.length===1&&!!deps.pauseRequested();
      if(head.pauseAfter) head.pauseSent=true;
      const payload={sessionId:head.sessionId,spin:{...head.spin,requestId:head.requestId,sequence:head.sequence}};
      const copy=head.pauseAfter?PAIR_RETRY_COPY:SPIN_RETRY_COPY;
      const onRetry=function(){ if(current()) say(copy); };
      const result=head.pauseAfter
        ? await sendCasinoSpinAndPause(payload,deps.send,wait,onRetry,SPIN_ATTEMPTS,head.ambiguous)
        : await sendCasinoSpinUntilReconciled(payload,deps.send,wait,onRetry,SPIN_ATTEMPTS,head.ambiguous);
      // The send above started. A round abandoned after it marks the head ambiguous only when Casino may hold the spin: a success,
      // a timeout or a 5xx. A definitive refusal (a 4xx, such as a stale sequence) means Casino did not record it, so the next round
      // renumbers it instead of reading Casino's next answer as proof of an earlier record.
      if(!current()){ if(result.ok||result.ambiguous===true||!isDefinitiveRefusal(result)) head.ambiguous=true; return false; }
      if(!result.ok) {
        // A failure that may have reached Casino marks the head for good, whatever the answer says next.
        head.ambiguous=head.ambiguous||result.ambiguous===true;
        if(discarding) return false;
        if(isRecordingDisabledResult(result)) return refuseRecording();
        if(isDefinitiveRefusal(result)) {
          if(await settleRefusal(head,result,current)) continue;
          return false;
        }
        head.refusals=0;
        return hold(result.error||('Casino did not record that spin ('+result.status+').'));
      }
      entries.shift();
      clearHold();
      if(cursor.sessionId===head.sessionId) cursor.next=head.sequence+1;
      deps.confirmed(result.body,{reconciled:result.reconciled===true,pauseCarried:head.pauseSent===true});
      say(null);
    }
    if(!current()) return false;
    stopRetry();
    say(null);
    if(deps.drained) deps.drained();
    return true;
  }
  // One round, in order. A round the timer or a caller forces runs even while held; a round asked for by a new
  // spin does not, because the retry timer owns the retries of a held queue.
  function runRound(forced) {
    chain=chain.then(function(){
      if(disposed||discarding) return false;
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
    pausedHeld:function(){ return isHeld&&heldPaused&&entries.length>0; },
    discard:function(){
      discarding=true;
      return chain.then(function(){
        const outcome={count:entries.length,maybeSaved:entries.length&&entries[0].ambiguous?1:0};
        if(outcome.count) dropEntries();
        discarding=false;
        return outcome;
      });
    },
    // The view mounted again on the same recorder: the queue takes spins again, and sends what it still holds.
    reopen:function(){
      if(!disposed) return;
      disposed=false;
      if(entries.length) void runRound(true);
    },
    dispose:function(){
      disposed=true;
      epoch+=1;
      clearHold();
      stopRetry();
    },
  };
}
