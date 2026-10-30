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

const retryDelay = (milliseconds) => new Promise(function(resolve){ setTimeout(resolve,milliseconds); });

/**
 * Keep one idempotent spin at the head of the queue until the server gives a definitive answer.
 * A timeout or 5xx can happen after the database commit, so the retry MUST carry the identical
 * sequence and payload. `recorded:false` reconciles only after such an ambiguous attempt; on the
 * first attempt it means the client arrived with a stale sequence and must not advance over it.
 */
export async function sendCasinoSpinUntilReconciled(payload,send=askCasino,wait=retryDelay,onRetry,maxAttempts=3) {
  let ambiguous=false;
  for(let attempt=0;attempt<maxAttempts;attempt++) {
    let result;
    try{result=await send('spin',payload);}
    catch(error){result={ok:false,status:0,error:error&&error.message?error.message:'Casino recording request failed'};}
    if(result.ok) {
      const recorded=result.body&&result.body.recorded;
      if(recorded===true) return {...result,reconciled:false};
      if(recorded===false&&ambiguous) return {...result,reconciled:true};
      if(recorded===false) return {ok:false,status:409,error:'That recording sequence already existed before this spin.'};
      return {ok:false,status:0,error:'Casino returned no recording verdict for that spin.'};
    }
    if(result.status!==0&&result.status<500) return result;
    ambiguous=true;
    if(onRetry) onRetry(attempt+1);
    if(attempt+1<maxAttempts)await wait(Math.min(1000*(attempt+1),5000));
  }
  return {ok:false,status:0,ambiguous:true,error:'Casino still has not confirmed that spin; it remains queued locally.'};
}

/** The first request both records the pending spin and banks duration; it never waits to ask pause. */
export function sendCasinoSpinAndPause(payload,send=askCasino,wait=retryDelay,onRetry,maxAttempts=3) {
  return sendCasinoSpinUntilReconciled(
    {...payload,spin:{...payload.spin,pauseAfter:true}},send,wait,onRetry,maxAttempts,
  );
}

export function recordingForMode(mode,gameRecording,liveRecording) {
  return mode==='game'?gameRecording:liveRecording;
}

export function isRecordingDisabledResult(result){
  return !!(result&&result.status===409&&result.body&&result.body.error==='recording_disabled');
}

export function nextSequenceForSession(previousSessionId,previousSequence,nextSession){
  if(!nextSession||!Number.isInteger(nextSession.spins))return previousSequence;
  const fromServer=nextSession.spins+1;
  return previousSessionId===nextSession.id?Math.max(previousSequence,fromServer):fromServer;
}

/** One central recording session. Local Roulette sessions remain unchanged. */
export function useCasinoRecording(mode,active) {
  const [availability,setAvailabilityState] = useState('unknown');
  const [session,setSession] = useState(null);
  const [problem,setProblem] = useState(null);
  const [tick,setTick] = useState(0);
  const sessionRef = React.useRef(null);
  const sequence = React.useRef(1);
  const starting = React.useRef(null);
  const refreshing = React.useRef(null);
  const queue = React.useRef(Promise.resolve());
  const resumedAt = React.useRef(Date.now());
  const activeRef = React.useRef(active);
  const pauseOwner = React.useRef('none');
  const lifecycleTransition = React.useRef(null);
  const pendingSpin = React.useRef(null);
  const availabilityRef = React.useRef('unknown');
  sessionRef.current = session;
  activeRef.current = active;

  const setAvailability = React.useCallback(function(next){
    availabilityRef.current=next;
    setAvailabilityState(next);
  },[]);

  const adopt = React.useCallback(function(next){
    sequence.current=nextSequenceForSession(sessionRef.current&&sessionRef.current.id,sequence.current,next);
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

  const ensureSession = React.useCallback(async function(){
    const existing = sessionRef.current;
    if(existing && existing.status!=='stopped') return existing;
    if(starting.current) return starting.current;
    starting.current = (async function(){
      const result = await askCasino('start',{mode});
      if(!result.ok){
        if(result.status===409) setAvailability('off');
        else setProblem(result.error||'Casino refused to start the recording session.');
        return null;
      }
      const next = casinoSession(result.body);
      if(next){ adopt(next); setProblem(null); }
      return next;
    })();
    try { return await starting.current; }
    finally { starting.current=null; }
  },[mode,adopt,setAvailability]);

  const flushPendingSpin = React.useCallback(async function(){
    const pending=pendingSpin.current;
    if(!pending)return true;
    const pauseRequested=pauseOwner.current!=='none';
    const result=pauseRequested
      ? await sendCasinoSpinAndPause(pending,askCasino,retryDelay,function(){
          setProblem('Casino has not confirmed the spin-and-pause yet. Retrying the same sequence.');
        })
      : await sendCasinoSpinUntilReconciled(pending,askCasino,retryDelay,function(){
          setProblem('Casino has not confirmed that spin yet. Retrying the same sequence.');
        });
    if(!result.ok){
      if(isRecordingDisabledResult(result)){
        pendingSpin.current=null;
        setAvailability('off');
        setProblem('Casino recording is off. That spin was not saved.');
        return true;
      }
      setProblem(result.error||('Casino did not record that spin ('+result.status+').'));
      return false;
    }
    pendingSpin.current=null;
    sequence.current=pending.spin.sequence+1;
    setProblem(null);
    adopt(casinoSession(result.body)||sessionRef.current);
    return true;
  },[adopt,setAvailability]);

  const record = React.useCallback(function(spin){
    queue.current = queue.current.then(async function(){
      if(!await flushPendingSpin())return;
      if(availabilityRef.current==='unknown'||availabilityRef.current==='unavailable')await refresh();
      if(availabilityRef.current!=='on')return;
      const live = await ensureSession();
      if(!live) return;
      if(live.status!=='running'){
        setProblem('Casino recording is paused. Resume it before the next spin.');
        return;
      }
      const seq = sequence.current;
      pendingSpin.current={
        sessionId:live.id,
        spin:{...spin,requestId:crypto.randomUUID(),sequence:seq,net:spin.returned-spin.staked},
      };
      await flushPendingSpin();
    });
  },[refresh,ensureSession,flushPendingSpin]);

  const lifecycle = React.useCallback(function(op){
    const task=queue.current.then(async function(){
      if(!await flushPendingSpin()){
        setProblem('Casino cannot '+op+' while an earlier spin is still unconfirmed. It remains queued locally.');
        return false;
      }
      const live = sessionRef.current;
      if(!live) return false;
      const result = await askCasino(op,{sessionId:live.id});
      if(!result.ok){ setProblem(result.error||('Casino refused to '+op+' the session.')); return false; }
      setProblem(null);
      adopt(casinoSession(result.body));
      return true;
    });
    queue.current=task;
    return task;
  },[adopt,flushPendingSpin]);

  const pauseImmediately = React.useCallback(function(owner){
    const previousOwner=pauseOwner.current;
    pauseOwner.current=owner;
    const task=queue.current.then(async function(){
      const live=sessionRef.current;
      if(!live){pauseOwner.current=previousOwner;return false;}
      if(!await flushPendingSpin()){
        setProblem('Casino cannot pause while an earlier spin is still unconfirmed. It remains queued locally.');
        pauseOwner.current='none';
        return false;
      }
      const current=sessionRef.current||live;
      if(current.status==='paused')return true;
      const result=await askCasino('pause',{sessionId:current.id});
      if(!result.ok){
        setProblem(result.error||'Casino refused to pause the recording session.');
        pauseOwner.current='none';
        return false;
      }
      setProblem(null);
      adopt(casinoSession(result.body)||current);
      return true;
    });
    queue.current=task;
    return task;
  },[adopt,flushPendingSpin]);

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
    resume:function(){pauseOwner.current='none';void lifecycle('resume');},
    stop:function(){pauseOwner.current='manual';void lifecycle('stop');},
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
