// -- Nexus Casino recording bridge -------------------------------------------------------------
//
// The Roulette app remains a standalone application. When it is framed by the one Casino origin,
// this adapter gives it the same server-side recording contract as other installed modules without
// handing the frame a cookie or token. Every refusal stays a refusal on screen.

export const CASINO_SHELL_ORIGIN = 'https://casino.nexus-foundry.ai';
export const CASINO_BRIDGE_HELLO = 'nexus-casino:recording:hello';
export const CASINO_BRIDGE_REQUEST = 'nexus-casino:recording:request';
export const CASINO_BRIDGE_RESPONSE = 'nexus-casino:recording:response';
export const CASINO_BRIDGE_OPERATIONS = [
  'settings', 'history', 'start', 'pause', 'resume', 'stop', 'spin', 'layout', 'setLayout',
  'deleteSession', 'readState', 'writeState',
];

// Shell UI requests are separate from the mirrored recording/HTTP contract.
export const CASINO_UI_OPERATIONS = ['openReadBoard', 'readBoardResult'];

const casinoBridge = {
  installed: false,
  ready: false,
  counter: 0,
  pending: new Map(),
  listeners: new Set(),
};

function installCasinoBridge() {
  if(casinoBridge.installed || typeof window === 'undefined') return;
  casinoBridge.installed = true;
  window.addEventListener('message', function(event) {
    const data = event.data;
    if(!data || typeof data !== 'object') return;

    if(data.kind === CASINO_BRIDGE_HELLO) {
      // Both facts are browser-stamped. A payload cannot nominate another shell or another game.
      if(event.origin !== CASINO_SHELL_ORIGIN || event.source !== window.parent) return;
      if(data.gameId !== 'roulette') return;
      casinoBridge.ready = true;
      Array.from(casinoBridge.listeners).forEach(function(listener){ listener(); });
      return;
    }

    if(data.kind !== CASINO_BRIDGE_RESPONSE) return;
    if(event.origin !== CASINO_SHELL_ORIGIN || event.source !== window.parent) return;
    if(typeof data.id !== 'string') return;
    const settle = casinoBridge.pending.get(data.id);
    if(!settle) return;
    casinoBridge.pending.delete(data.id);
    settle({
      ok: data.ok === true,
      status: typeof data.status === 'number' ? data.status : 0,
      body: data.body,
      error: typeof data.error === 'string' ? data.error : null,
    });
  });
}

function waitForCasinoBridge(timeoutMs=12000) {
  installCasinoBridge();
  if(casinoBridge.ready) return Promise.resolve(true);
  if(window.parent===window) return Promise.resolve(false);
  return new Promise(function(resolve){
    let finished=false;
    const done=function(ready){
      if(finished)return;
      finished=true;
      clearTimeout(timer);
      casinoBridge.listeners.delete(listener);
      resolve(ready);
    };
    const listener=function(){done(true);};
    const timer=setTimeout(function(){done(false);},timeoutMs);
    casinoBridge.listeners.add(listener);
  });
}

function askCasino(op, payload) {
  installCasinoBridge();
  if(!casinoBridge.ready || window.parent === window) {
    return Promise.resolve({ok:false,status:0,error:'not-framed'});
  }
  if(CASINO_BRIDGE_OPERATIONS.indexOf(op) < 0 && CASINO_UI_OPERATIONS.indexOf(op) < 0) {
    return Promise.resolve({ok:false,status:400,error:'unknown operation'});
  }
  const id = 'roulette-'+(++casinoBridge.counter)+'-'+op;
  return new Promise(function(resolve){
    const timer = setTimeout(function(){
      casinoBridge.pending.delete(id);
      resolve({ok:false,status:0,error:'the Casino recording bridge did not answer'});
    }, 12000);
    casinoBridge.pending.set(id, function(result){ clearTimeout(timer); resolve(result); });
    window.parent.postMessage({kind:CASINO_BRIDGE_REQUEST,id,op,payload:payload||{}},CASINO_SHELL_ORIGIN);
  });
}

// Do not wait for hello here: the shell must receive this request during the tap's activation.
export function openCasinoReadBoard(wheel) {
  if(wheel !== 'american' && wheel !== 'european') {
    return Promise.resolve({ok:false,status:400,error:'invalid wheel'});
  }
  return askCasino('openReadBoard',{wheel});
}

export function takeCasinoReadBoard() {
  return askCasino('readBoardResult');
}

function casinoSession(body) {
  const value = body && body.session;
  return value && typeof value.id === 'string' ? value : null;
}

export function recordingForMode(mode,gameRecording,liveRecording) {
  return mode==='game'?gameRecording:liveRecording;
}

// The count of spins a view left unsent, kept per mode so the next mount can say so. A page can close without
// running unmount, so the count is written whenever the queue changes, not only when the view unmounts.
const UNSENT_KEY_PREFIX='nexus-roulette.casino-unsent.';
function writeUnsentCount(mode,count){
  try{
    if(count>0) localStorage.setItem(UNSENT_KEY_PREFIX+mode,String(count));
    else localStorage.removeItem(UNSENT_KEY_PREFIX+mode);
  }catch(_error){}
}
function takeUnsentCount(mode){
  try{
    const key=UNSENT_KEY_PREFIX+mode;
    const stored=Number(localStorage.getItem(key))||0;
    localStorage.removeItem(key);
    return stored;
  }catch(_error){return 0;}
}

// The Casino copy for a Stop offered on a held queue. The count is the number of spins it would discard.
function stopOfferCopy(count){
  return spinsWaitingCopy(count)+' Press Stop again to discard '+count+(count===1?' unsent spin':' unsent spins')+' and end the recording.';
}

/** One central recording session. Local Roulette sessions remain unchanged. */
export function useCasinoRecording(mode,active) {
  const [availability,setAvailabilityState] = useState('unknown');
  const [session,setSession] = useState(null);
  const [problem,setProblemState] = useState(null);
  const [tick,setTick] = useState(0);
  const sessionRef = React.useRef(null);
  const refreshing = React.useRef(null);
  const queue = React.useRef(Promise.resolve());
  const resumedAt = React.useRef(Date.now());
  const activeRef = React.useRef(active);
  const pauseOwner = React.useRef('none');
  const pausePending = React.useRef(false);
  const stopOffer = React.useRef(null);
  const lifecycleTransition = React.useRef(null);
  const recorder = React.useRef(null);
  const latest = React.useRef(null);
  const availabilityRef = React.useRef('unknown');
  const mounted = React.useRef(true);
  const discardPending = React.useRef(false);
  // Spins refused while a discard waits. They are stated on screen once the discard finishes.
  const stoppingRefusals = React.useRef(0);
  sessionRef.current = session;
  activeRef.current = active;

  const setAvailability = React.useCallback(function(next){
    availabilityRef.current=next;
    setAvailabilityState(next);
  },[]);

  // Nothing is written to the screen once the view has closed.
  const setProblem = React.useCallback(function(text){
    if(mounted.current) setProblemState(text);
  },[]);

  const adopt = React.useCallback(function(next){
    if(recorder.current) recorder.current.observe(next);
    if(!mounted.current) return;
    setSession(next);
    sessionRef.current = next;
  },[]);

  const refresh = React.useCallback(function(){
    if(refreshing.current)return refreshing.current;
    const pending=(async function(){
      if(!await waitForCasinoBridge()){setAvailability('unavailable');return 'unavailable';}
      const settings=await askCasino('settings');
      if(!settings.ok){setAvailability('unavailable');return 'unavailable';}
      const enabled=!!(settings.body&&settings.body.settings&&settings.body.settings.recordingEnabled===true);
      setAvailability(enabled?'on':'off');
      if(!enabled)return 'off';
      const history=await askCasino('history');
      if(!history.ok)return 'on';
      let running=history.body&&history.body.running&&history.body.running[mode];
      if(running&&running.status==='running'&&!activeRef.current){
        pauseOwner.current='auto';
        const paused=await askCasino('pause',{sessionId:running.id});
        if(paused.ok)running=casinoSession(paused.body)||running;
        else pauseOwner.current='none';
      }
      if(running)adopt(running);
      return 'on';
    })();
    refreshing.current=pending;
    void pending.finally(function(){if(refreshing.current===pending)refreshing.current=null;});
    return pending;
  },[mode,adopt,setAvailability]);

  useEffect(function(){
    installCasinoBridge();
    refresh();
    const ready = function(){ refresh(); };
    casinoBridge.listeners.add(ready);
    return function(){ casinoBridge.listeners.delete(ready); };
  },[refresh]);

  useEffect(function(){
    if(!session || session.status!=='running') return undefined;
    const timer = setInterval(function(){ setTick(function(value){return value+1;}); },1000);
    return function(){ clearInterval(timer); };
  },[session && session.status]);
  useEffect(function(){ resumedAt.current=Date.now(); },[session && session.id,session && session.status]);

  const resolveSession = React.useCallback(async function(){
    const existing = sessionRef.current;
    if(existing && existing.status!=='stopped') return {ok:true,session:existing};
    const result = await askCasino('start',{mode});
    if(!result.ok) {
      return result.status===409
        ? {ok:false,off:true}
        : {ok:false,error:result.error||'Casino refused to start the recording session.'};
    }
    const next = casinoSession(result.body);
    if(!next) return {ok:false,error:'Casino returned no recording session.'};
    adopt(next);
    return {ok:true,session:next};
  },[mode,adopt]);

  // The session as Casino holds it now. The queue asks this after a definitive refusal of a spin.
  const rereadSession = React.useCallback(async function(){
    const history = await askCasino('history');
    if(!history.ok) return {ok:false,error:history.error||'Casino did not answer the session check.'};
    const running = history.body&&history.body.running&&history.body.running[mode];
    return {ok:true,session:running&&typeof running.id==='string'?running:null};
  },[mode]);

  const flushPendingSpins = React.useCallback(function(){
    return recorder.current.flush();
  },[]);

  // Keeps the count of spins this view holds, so the next mount can say so if the page closes first.
  const syncUnsent = React.useCallback(function(){
    writeUnsentCount(mode,recorder.current?recorder.current.waiting():0);
  },[mode]);

  // A spin is never dropped once it is part of a running recording. A held queue only takes it, and the retry
  // timer sends the queue. Recording that has not started (off, not connected, or paused) still refuses the spin.
  const record = React.useCallback(function(spin){
    // A spin made while the queue discards is refused: it is never queued, so it is neither counted as discarded nor sent on.
    const refuse=function(){
      stoppingRefusals.current+=1;
      setProblem(spinsNotSavedCopy(stoppingRefusals.current,'recording is stopping'));
    };
    if(discardPending.current) return refuse();
    queue.current = queue.current.then(async function(){
      if(!recorder.current.waiting()){
        const live = sessionRef.current;
        if(live && live.status==='paused'){
          setProblem(spinsNotSavedCopy(1,'recording is paused')+' Resume it before the next spin.');
          return;
        }
        if(!(live && live.status==='running')){
          if(availabilityRef.current==='unknown'||availabilityRef.current==='unavailable')await refresh();
          if(availabilityRef.current!=='on')return;
        }
      }
      // The last check before the enqueue: an await above may have let a discard begin.
      if(discardPending.current) return refuse();
      const pending=recorder.current.submit(spin);
      syncUnsent();
      await pending;
    });
  },[refresh,setProblem,syncUnsent]);

  const lifecycle = React.useCallback(function(op){
    // A discard owns the queue while it waits. A Resume then does nothing and says nothing.
    if(discardPending.current) return Promise.resolve(false);
    const task=queue.current.then(async function(){
      // A Resume on a queue held behind a paused session resumes Casino first. Flushing first would send the held
      // spins to the paused session, have them refused, and the resume would never be sent.
      const resumingHeld = op==='resume' && recorder.current.pausedHeld();
      const flushed = resumingHeld || await flushPendingSpins();
      // A discard that began during the flush refused it. That refusal is the discard's to report, not a reason to say "cannot resume".
      if(discardPending.current) return false;
      if(!flushed){
        const waiting=recorder.current.waiting();
        if(waiting) setProblem(spinsWaitingCopy(waiting)+' Casino cannot '+op+' until they are confirmed.');
        return false;
      }
      const live = sessionRef.current;
      if(!live) return false;
      const result = await askCasino(op,{sessionId:live.id});
      if(!result.ok){ setProblem(result.error||('Casino refused to '+op+' the session.')); return false; }
      setProblem(null);
      adopt(casinoSession(result.body));
      if(resumingHeld) await flushPendingSpins();
      // A stopped session has no pause left to carry.
      if(op==='stop'){ pauseOwner.current='none'; pausePending.current=false; }
      return true;
    });
    queue.current=task;
    return task;
  },[adopt,flushPendingSpins,setProblem]);

  // On a held queue Pause does not wait for the retries. Its intent is kept, and applied once the queue has drained.
  const deferPause = React.useCallback(function(){
    pausePending.current=true;
    setProblem(spinsWaitingCopy(recorder.current.waiting())+' Casino will pause after they are confirmed.');
    return 'deferred';
  },[setProblem]);

  const pauseImmediately = React.useCallback(function(owner){
    // A discard owns the queue while it waits. A Pause then does nothing and says nothing.
    if(discardPending.current) return Promise.resolve(false);
    const previousOwner=pauseOwner.current;
    pauseOwner.current=owner;
    if(recorder.current.held()) return Promise.resolve(deferPause());
    const task=queue.current.then(async function(){
      const live=sessionRef.current;
      if(!live){pauseOwner.current=previousOwner;return false;}
      const flushed=await flushPendingSpins();
      if(discardPending.current){pauseOwner.current=previousOwner;return false;}
      if(!flushed){
        if(recorder.current.waiting()) return deferPause();
        pauseOwner.current='none';
        return false;
      }
      const current=sessionRef.current||live;
      if(current.status==='paused'){pausePending.current=false;return true;}
      const result=await askCasino('pause',{sessionId:current.id});
      if(!result.ok){
        setProblem(result.error||'Casino refused to pause the recording session.');
        pauseOwner.current='none';
        return false;
      }
      pausePending.current=false;
      setProblem(null);
      adopt(casinoSession(result.body)||current);
      return true;
    });
    queue.current=task;
    return task;
  },[adopt,deferPause,flushPendingSpins,setProblem]);

  // The second press discards the queued spins, once a send in flight has finished, and then ends the recording.
  // The count is the queue's own. A spin whose send may have been recorded is stated as may have been saved.
  const discardAndStop = React.useCallback(async function(){
    if(discardPending.current) return;
    discardPending.current=true;
    // Shown while the discard waits for a send in flight, so a second press is answered on screen.
    setProblem('Discarding unsent spins…');
    // The spins refused while the discard waited are stated after its line, and the count is then taken.
    const withRefusals=function(text){
      const refused=stoppingRefusals.current;
      stoppingRefusals.current=0;
      const note=refused?spinsNotSavedCopy(refused,'recording is stopping'):null;
      return [text,note].filter(Boolean).join(' ')||null;
    };
    try{
      const outcome=await recorder.current.discard();
      stopOffer.current=null;
      pausePending.current=false;
      const notSaved=outcome.count?spinsDroppedCopy(outcome.count,outcome.maybeSaved,'recording was stopped'):null;
      syncUnsent();
      const live=sessionRef.current;
      if(!live){ setProblem(withRefusals(notSaved)); return; }
      // Set only after the discard, so a discarded queue sends no pause. Cleared again once Casino confirms the stop.
      const previousOwner=pauseOwner.current;
      pauseOwner.current='manual';
      const result=await askCasino('stop',{sessionId:live.id});
      if(!result.ok){
        pauseOwner.current=previousOwner;
        setProblem(withRefusals((notSaved?notSaved+' ':'')+(result.error||'Casino refused to stop the recording session.')));
        return;
      }
      pauseOwner.current='none';
      setProblem(withRefusals(notSaved));
      adopt(casinoSession(result.body)||live);
    }finally{
      discardPending.current=false;
    }
  },[adopt,setProblem,syncUnsent]);

  // On a held queue the first Stop changes nothing but the offer, which names the spins a second press would discard.
  const stopNow = React.useCallback(function(){
    if(discardPending.current) return;
    if(recorder.current.held()){
      if(stopOffer.current===null){
        stopOffer.current=recorder.current.waiting();
        setProblem(stopOfferCopy(stopOffer.current));
        return;
      }
      void discardAndStop();
      return;
    }
    void lifecycle('stop');
  },[discardAndStop,lifecycle,setProblem]);

  // Called when the queue empties. A pause that could not ride on a spin is applied now.
  const pauseWhenDrained = React.useCallback(function(){
    if(!pausePending.current) return;
    void pauseImmediately(pauseOwner.current==='none'?'manual':pauseOwner.current);
  },[pauseImmediately]);

  // The queue's own problem lines. While a Stop is offered the offer stays, with the count it would discard.
  function reportQueue(text){
    syncUnsent();
    // A discard that waits keeps its own line; the queue's retry copy does not replace it.
    if(discardPending.current) return;
    if(text===null){ stopOffer.current=null; setProblem(null); return; }
    if(stopOffer.current!==null){ setProblem(stopOfferCopy(recorder.current.waiting())); return; }
    setProblem(pausePending.current?text+' Casino will pause after they are confirmed.':text);
  }

  // The queue is created once per hook instance. Its callbacks read the latest render's functions.
  latest.current = {resolveSession,rereadSession,adopt,setAvailability,setProblem,reportQueue,pauseWhenDrained,syncUnsent};
  if(!recorder.current) recorder.current = createSpinQueue({
    resolveSession:function(){ return latest.current.resolveSession(); },
    reread:function(){ return latest.current.rereadSession(); },
    send:function(op,payload){ return askCasino(op,payload); },
    pauseRequested:function(){ return pauseOwner.current!=='none'; },
    report:function(text){ latest.current.reportQueue(text); },
    confirmed:function(body,info){
      const next=casinoSession(body)||sessionRef.current;
      latest.current.adopt(next);
      // A reconciled spin that carried a pause still owes it when Casino reports the session as running, unless the
      // user has withdrawn the pause since. The pause is applied once the queue drains.
      if(info&&info.reconciled&&info.pauseCarried&&pauseOwner.current!=='none'&&!(next&&next.status==='paused')) pausePending.current=true;
    },
    recordingOff:function(count){
      stopOffer.current=null;
      pausePending.current=false;
      latest.current.syncUnsent();
      latest.current.setAvailability('off');
      latest.current.setProblem(count===1
        ? 'Casino recording is off. That spin was not saved.'
        : 'Casino recording is off. '+count+' spins were not saved.');
    },
    ended:function(current){
      stopOffer.current=null;
      pausePending.current=false;
      latest.current.adopt(current&&current.status!=='stopped'?current:null);
    },
    drained:function(){ latest.current.pauseWhenDrained(); },
    schedule:function(callback,milliseconds){
      const handle=setTimeout(callback,milliseconds);
      return function(){ clearTimeout(handle); };
    },
  });

  useEffect(function(){
    mounted.current=true;
    // A remount (StrictMode, or the view opening again) reopens the same queue, so the spins it holds still go out.
    const queued=recorder.current?recorder.current.waiting():0;
    if(recorder.current) recorder.current.reopen();
    const unsent=takeUnsentCount(mode);
    // A count left by a view that closed. Spins still queued in this page are not from before the page closed.
    if(unsent>0&&!queued) setProblem(unsent+(unsent===1?' spin was':' spins were')+' not sent to Casino before the page closed.');
    syncUnsent();
    return function(){
      mounted.current=false;
      if(recorder.current){
        writeUnsentCount(mode,recorder.current.waiting());
        recorder.current.dispose();
      }
    };
  },[]);

  useEffect(function(){
    const live=sessionRef.current;
    if(!live)return;
    if(!active&&live.status==='running'&&pauseOwner.current==='none'&&!lifecycleTransition.current){
      pauseOwner.current='auto';
      lifecycleTransition.current='pause';
      void pauseImmediately('auto').then(function(ok){
        lifecycleTransition.current=null;
        if(!ok)pauseOwner.current='none';
        setTick(function(value){return value+1;});
      });
    } else if(active&&live.status==='paused'&&pauseOwner.current==='auto'&&!lifecycleTransition.current){
      lifecycleTransition.current='resume';
      void lifecycle('resume').then(function(ok){
        lifecycleTransition.current=null;
        if(ok)pauseOwner.current='none';
        setTick(function(value){return value+1;});
      });
    }
  },[active,session&&session.status,pauseImmediately,lifecycle,tick]);

  const elapsedMs = session
    ? (session.activeMs||0)+(session.status==='running'?Date.now()-resumedAt.current:0)
    : 0;
  void tick;
  return {
    availability,session,elapsedMs,problem,record,
    pause:function(){void pauseImmediately('manual');},
    resume:function(){pauseOwner.current='none';pausePending.current=false;void lifecycle('resume');},
    stop:function(){stopNow();},
  };
}

function roundedMoney(value){ return Math.round((value+Number.EPSILON)*1000000)/1000000; }
function emptyWagers(){ return {stakes:{},staked:0,returned:0}; }
function addWager(summary,key,staked,returned){
  if(staked>0) summary.stakes[key]=roundedMoney((summary.stakes[key]||0)+staked);
  summary.staked=roundedMoney(summary.staked+staked);
  summary.returned=roundedMoney(summary.returned+returned);
}

/** Exact settlement for the manual chips that are on the rendered table. */
export function summarizeManualWagers(bets,outcome,deps) {
  const covered = deps && deps.betCoveredNumbers ? deps.betCoveredNumbers : betCoveredNumbers;
  const payout = deps && deps.betPayoutMult ? deps.betPayoutMult : betPayoutMult;
  const summary=emptyWagers();
  (bets||[]).forEach(function(bet){
    const amount=Number(bet.amount)||0;
    const win=covered(bet.type,bet.target).indexOf(outcome)>=0;
    addWager(summary,'manual:'+bet.type+':'+String(bet.target),amount,win?amount*payout(bet.type):0);
  });
  return summary;
}

/** Exact settlement for every active progression/solution/custom track before it advances. */
export function summarizeTrackWagers(tracks,outcome,deps) {
  const tableFor = deps && deps.computeTableForTrack ? deps.computeTableForTrack : computeTableForTrack;
  const evens = deps && deps.evenMoney ? deps.evenMoney : EVEN_MONEY;
  const dozen = deps && deps.dozenOf ? deps.dozenOf : dozenOf;
  const column = deps && deps.columnOf ? deps.columnOf : columnOf;
  const covered = deps && deps.betCoveredNumbers ? deps.betCoveredNumbers : betCoveredNumbers;
  const payout = deps && deps.betPayoutMult ? deps.betPayoutMult : betPayoutMult;
  const summary=emptyWagers();

  (tracks||[]).forEach(function(track){
    if(track.state!=='active') return;
    const unit=track.config.unit||1;
    const table=tableFor(track);
    if(track.type==='fibonacci'){
      const dozens=track.config.dozenTargets||[];
      const columns=track.config.colTargets||[];
      const evenTargets=track.config.evenTargets||[];
      const flat=(track.config.betMode||'progression')==='flat';
      const row=table[Math.min(track.level,table.length-1)];
      const chips=flat?1:(row?row.c:1);
      const zero=outcome==='0'||outcome==='00';
      const targets=evenTargets.length
        ? evenTargets.map(function(key){return {key:'even:'+key,hit:!zero&&!!(evens.find(function(e){return e.key===key;})||{}).pred(+outcome),mult:2};})
        : dozens.map(function(value){return {key:'dozen:'+value,hit:!zero&&dozen(outcome)===value,mult:3};})
          .concat(columns.map(function(value){return {key:'column:'+value,hit:!zero&&column(outcome)===value,mult:3};}));
      (targets.length?targets:[{key:'unconfigured',hit:false,mult:0}]).forEach(function(target){
        const stake=chips*unit;
        addWager(summary,'track:'+track.id+':'+target.key,stake,target.hit?stake*target.mult:0);
      });
    } else if(track.type==='solution'){
      (track.config.activeBets||[]).forEach(function(bet){
        const row=table[Math.min(bet.level,table.length-1)];
        const stake=(row?row.c:1)*unit;
        addWager(summary,'track:'+track.id+':number:'+bet.number,stake,bet.number===outcome?(row?row.ret:36)*unit:0);
      });
    } else if(track.type==='custom'){
      const row=table[Math.min(track.level,table.length-1)];
      const multiple=row?row.c:1;
      (track.config.positions||[]).forEach(function(position){
        const stake=position.baseAmount*multiple*unit;
        const win=covered(position.type,position.target).indexOf(outcome)>=0;
        addWager(summary,'track:'+track.id+':'+position.type+':'+String(position.target),stake,win?stake*payout(position.type):0);
      });
    }
  });
  return summary;
}

export function mergeWagerSummaries() {
  const merged=emptyWagers();
  Array.from(arguments).forEach(function(summary){
    Object.keys(summary.stakes||{}).forEach(function(key){
      merged.stakes[key]=roundedMoney((merged.stakes[key]||0)+summary.stakes[key]);
    });
    merged.staked=roundedMoney(merged.staked+(summary.staked||0));
    merged.returned=roundedMoney(merged.returned+(summary.returned||0));
  });
  return merged;
}

function casinoDuration(ms){
  const total=Math.max(0,Math.floor(ms/1000)), seconds=total%60, minutes=Math.floor(total/60)%60;
  const hours=Math.floor(total/3600), pad=function(value){return String(value).padStart(2,'0');};
  return hours?hours+':'+pad(minutes)+':'+pad(seconds):minutes+':'+pad(seconds);
}

export function CasinoRecordingBar({recording,label}) {
  let text='';
  if(recording.availability==='unknown') text='Checking Nexus Casino recording before the first spin…';
  else if(recording.availability==='unavailable') text='Not connected to Nexus Casino — nothing is being recorded.';
  else if(recording.availability==='off') text='Casino recording is off for Roulette.';
  else if(!recording.session) text='Casino recording is on. This session starts on the first spin.';
  else text=(recording.session.status==='running'?'Recording':recording.session.status==='paused'?'Paused':'Stopped')+
    ' · '+casinoDuration(recording.elapsedMs)+' · '+recording.session.spins+' spins';

  const controls=[];
  if(recording.availability==='on'&&recording.session&&recording.session.status!=='stopped'){
    controls.push(React.createElement('button',{
      key:'toggle',type:'button',onClick:recording.session.status==='running'?recording.pause:recording.resume,
      className:'nf-btn nf-btn--sm',
    },recording.session.status==='running'?'Pause':'Resume'));
    controls.push(React.createElement('button',{
      key:'stop',type:'button',onClick:recording.stop,title:'Ends this central recording session permanently.',
      className:'nf-btn nf-btn--danger nf-btn--sm',
    },'Stop'));
  }
  return React.createElement('section',{
    'aria-label':label+' Casino recording',
    style:{width:'100%',display:'flex',alignItems:'center',justifyContent:'center',gap:8,flexWrap:'wrap',padding:'7px 10px',borderRadius:9,border:'1px solid #2d4057',background:'#0c1520',fontSize:10,color:'#94a3b8'},
  },React.createElement('span',null,text),controls,
  recording.problem?React.createElement('span',{role:'alert',style:{width:'100%',color:'#f87171'}},recording.problem):null);
}
