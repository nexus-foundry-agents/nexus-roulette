// First-party Casino account sync. Standalone state remains local; the shell owns authentication.
const ROULETTE_SYNC_META_KEY='nexus-roulette-sync-v1';

function syncObject(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
function syncNumber(value){return Number.isSafeInteger(value)&&value>=0?value:0;}
function sessionModified(value){return syncObject(value)?syncNumber(value.modified)||syncNumber(value.created):0;}

function meaningfulAppState(appState){
  if(!syncObject(appState))return false;
  if(appState.settings&&appState.settings.onboarded===true)return true;
  if(Array.isArray(appState.savedSessions)&&appState.savedSessions.length)return true;
  return ['currentSession','gameSession'].some(function(key){
    const session=appState[key];
    return syncObject(session)&&((session.spins||[]).length||(session.tracks||[]).length||session.sessionStartedAt);
  });
}

export function legacySnapshotModifiedAt(appState){
  if(!meaningfulAppState(appState))return 0;
  const saved=Array.isArray(appState.savedSessions)?appState.savedSessions:[];
  return Math.max(0,...saved.map(sessionModified),sessionModified(appState.currentSession),sessionModified(appState.gameSession));
}

function syncMetaStorageKey(){return rouletteStorageKey(ROULETTE_SYNC_META_KEY);}

export function syncMetaFromStored(stored,appState){
  if(stored!==null){
    try{
      const value=JSON.parse(stored);
      if(syncObject(value))return {modifiedAt:syncNumber(value.modifiedAt),resetAt:syncNumber(value.resetAt)};
    }catch(_error){}
  }
  return {modifiedAt:legacySnapshotModifiedAt(appState),resetAt:0};
}

function readSyncMeta(appState){
  const key=syncMetaStorageKey();
  let stored=null;
  try{stored=key?localStorage.getItem(key):null;}catch(_error){}
  return syncMetaFromStored(stored,appState);
}

function writeSyncMeta(meta){
  try{
    const key=syncMetaStorageKey();
    if(key)localStorage.setItem(key,JSON.stringify(meta));
  }catch(_error){}
}

export function nextLocalSyncMeta(previous,now){
  return {
    modifiedAt:advanceSyncClock(previous,now),
    resetAt:syncNumber(previous&&previous.resetAt),
  };
}

export function advanceSyncClock(previous,now){
  const prior=Math.max(syncNumber(previous&&previous.modifiedAt),syncNumber(previous&&previous.resetAt));
  const logical=prior<Number.MAX_SAFE_INTEGER?prior+1:prior;
  return Math.max(syncNumber(now),logical);
}

export function nextResetSyncMeta(previous,now){
  const next=advanceSyncClock(previous,now);
  return {modifiedAt:next,resetAt:next};
}

export function rouletteSnapshot(appState,meta){
  return {schema:1,modifiedAt:syncNumber(meta&&meta.modifiedAt),resetAt:syncNumber(meta&&meta.resetAt),appState};
}

export function readRouletteSnapshot(value){
  if(!syncObject(value)||value.schema!==1||!syncObject(value.appState))return null;
  return rouletteSnapshot(value.appState,{modifiedAt:syncNumber(value.modifiedAt),resetAt:syncNumber(value.resetAt)});
}

function canonicalSyncString(value){
  if(Array.isArray(value))return '['+value.map(canonicalSyncString).join(',')+']';
  if(syncObject(value))return '{'+Object.keys(value).sort().filter(function(key){
    return value[key]!==undefined;
  }).map(function(key){
    return JSON.stringify(key)+':'+canonicalSyncString(value[key]);
  }).join(',')+'}';
  return JSON.stringify(value)??'null';
}

function canonicalWinner(left,right){
  return canonicalSyncString(left)>=canonicalSyncString(right)?left:right;
}

function mergeSavedSessions(left,right){
  const merged=new Map();
  (Array.isArray(left)?left:[]).concat(Array.isArray(right)?right:[]).forEach(function(session){
    if(!syncObject(session)||typeof session.id!=='string')return;
    const current=merged.get(session.id);
    if(!current||sessionModified(session)>sessionModified(current))merged.set(session.id,session);
    else if(sessionModified(session)===sessionModified(current))merged.set(session.id,canonicalWinner(current,session));
  });
  return Array.from(merged.values()).sort(function(a,b){
    return syncNumber(a.created)-syncNumber(b.created)||a.id.localeCompare(b.id);
  });
}

/** Session union is deterministic; envelope time resolves singleton preferences and active slots. */
export function mergeRouletteSnapshots(leftValue,rightValue){
  const left=readRouletteSnapshot(leftValue),right=readRouletteSnapshot(rightValue);
  if(!left)return right;
  if(!right)return left;
  // A reset is a monotonic account epoch, not merely another wall-clock edit. A device that has
  // not observed that epoch must first adopt it, even if it made a later offline edit; otherwise
  // its pre-reset snapshot can resurrect the history the reset deliberately removed.
  if(left.resetAt>right.resetAt)return left;
  if(right.resetAt>left.resetAt)return right;
  const newer=right.modifiedAt>left.modifiedAt?right:
    left.modifiedAt>right.modifiedAt?left:canonicalWinner(left,right);
  const older=newer===right?left:right;
  const appState={...older.appState,...newer.appState};
  appState.savedSessions=mergeSavedSessions(left.appState.savedSessions,right.appState.savedSessions);
  appState.currentSession=newer.appState.currentSession||older.appState.currentSession;
  appState.gameSession=newer.appState.gameSession||older.appState.gameSession;
  appState.settings=newer.appState.settings||older.appState.settings;
  return rouletteSnapshot(appState,{
    modifiedAt:Math.max(left.modifiedAt,right.modifiedAt),
    resetAt:Math.max(left.resetAt,right.resetAt),
  });
}

export function conflictCandidate(queued,remote,latestLocal){
  return mergeRouletteSnapshots(latestLocal||queued,remote);
}

export function shouldApplySyncReceipt(requestedVersion,currentVersion){
  return requestedVersion===currentVersion;
}

function stateFromResponse(result){
  const state=result&&result.body&&result.body.state;
  if(!state||!Number.isSafeInteger(state.revision))return null;
  const data=readRouletteSnapshot(state.data);
  return data?{revision:state.revision,data}:null;
}

function scopeFromResponse(result){
  const scope=result&&result.body&&result.body.scope;
  return typeof scope==='string'&&/^[A-Za-z0-9_-]{32}$/.test(scope)?scope:null;
}

export function useCasinoAccountSync(appState,setAppState){
  const [status,setStatus]=useState(window.parent===window?'local':'checking');
  const [problem,setProblem]=useState(null);
  const [deviceSaved,setDeviceSaved]=useState(window.parent===window);
  const revision=React.useRef(0),hydrated=React.useRef(false),appRef=React.useRef(appState);
  const meta=React.useRef(readSyncMeta(appState)),applyHash=React.useRef(null);
  const lastLocalHash=React.useRef(JSON.stringify(appState));
  const timer=React.useRef(null),serial=React.useRef(Promise.resolve()),dirty=React.useRef(0);
  appRef.current=appState;

  const applySnapshot=React.useCallback(function(snapshot){
    const hash=JSON.stringify(snapshot.appState);
    meta.current={modifiedAt:snapshot.modifiedAt,resetAt:snapshot.resetAt};
    writeSyncMeta(meta.current);
    applyHash.current=hash;
    lastLocalHash.current=hash;
    appRef.current=snapshot.appState;
    const saved=saveApp(snapshot.appState);
    setDeviceSaved(saved);
    setAppState(snapshot.appState);
    return saved;
  },[setAppState]);

  useEffect(function(){
    const saved=function(){setDeviceSaved(true);};
    const failed=function(){setDeviceSaved(false);};
    window.addEventListener('nexus-save-success',saved);
    window.addEventListener('nexus-save-failed',failed);
    return function(){
      window.removeEventListener('nexus-save-success',saved);
      window.removeEventListener('nexus-save-failed',failed);
    };
  },[]);

  const push=React.useCallback(async function(candidate,requestedVersion){
    let next=candidate;
    for(let attempt=0;attempt<4;attempt++){
      setStatus('syncing');
      const result=await askCasino('writeState',{expectedRevision:revision.current,data:next});
      if(result.ok){
        const stored=stateFromResponse(result);
        if(!stored){setStatus('unavailable');setProblem('Casino returned an invalid sync receipt.');return false;}
        revision.current=stored.revision;
        const current=shouldApplySyncReceipt(requestedVersion,dirty.current);
        if(current)applySnapshot(stored.data);
        setStatus(current?'synced':'syncing');setProblem(null);
        return true;
      }
      if(result.status!==409){
        setStatus('unavailable');setProblem(result.error||'Casino account sync is unavailable.');return false;
      }
      const current=stateFromResponse(result);
      if(!current){setStatus('unavailable');setProblem('Casino returned an invalid conflict snapshot.');return false;}
      revision.current=current.revision;
      next=conflictCandidate(next,current.data,rouletteSnapshot(appRef.current,meta.current));
      if(!next){setStatus('unavailable');setProblem('Casino account state uses an unsupported format.');return false;}
    }
    setStatus('unavailable');setProblem('Casino account state changed repeatedly; this device kept its local copy.');
    return false;
  },[applySnapshot]);

  const queuePush=React.useCallback(function(candidate,requestedVersion=dirty.current){
    serial.current=serial.current.then(async function(){
      await push(candidate,requestedVersion);
    });
  },[push]);

  useEffect(function(){
    let cancelled=false;
    if(window.parent===window){hydrated.current=true;return undefined;}
    void (async function(){
      if(!await waitForCasinoBridge()){
        if(!cancelled){setStatus('unavailable');setProblem('Open Roulette through a signed-in Casino page to sync devices.');}
        return;
      }
      const result=await askCasino('readState');
      if(cancelled)return;
      if(!result.ok){
        const unavailableScope=scopeFromResponse(result);
        if(unavailableScope&&beginRouletteAccountStorage(unavailableScope)){
          const scopedApp=loadApp();
          meta.current=readSyncMeta(scopedApp);
          const local=rouletteSnapshot(scopedApp,meta.current);
          enableRouletteAccountStorage();hydrated.current=true;
          const saved=applySnapshot(local);
          setStatus('unavailable');setProblem(saved
            ? 'Casino cloud sync is unavailable. Changes remain saved for this account on this device.'
            : 'Casino cloud sync and browser storage are unavailable. Changes are not saved.');
        }else{
          setStatus('unavailable');setProblem(result.error||'Not saved: Casino account storage is unavailable.');
        }
        return;
      }
      const scope=scopeFromResponse(result);
      if(!scope||!beginRouletteAccountStorage(scope)){
        setStatus('unavailable');setProblem('Casino returned no valid account storage scope.');return;
      }
      const scopedApp=loadApp();
      appRef.current=scopedApp;
      meta.current=readSyncMeta(scopedApp);
      const local=rouletteSnapshot(scopedApp,meta.current);
      const raw=result.body&&result.body.state;
      if(raw===null){
        enableRouletteAccountStorage();hydrated.current=true;applySnapshot(local);queuePush(local);return;
      }
      const remote=stateFromResponse(result);
      if(!remote){
        enableRouletteAccountStorage();hydrated.current=true;applySnapshot(local);
        setStatus('unavailable');setProblem('Casino account state uses an unsupported format.');return;
      }
      revision.current=remote.revision;
      const merged=mergeRouletteSnapshots(local,remote.data);
      if(!merged){
        enableRouletteAccountStorage();hydrated.current=true;applySnapshot(local);
        setStatus('unavailable');setProblem('Casino account state could not be merged.');return;
      }
      enableRouletteAccountStorage();
      hydrated.current=true;
      applySnapshot(merged);
      if(JSON.stringify(merged)!==JSON.stringify(remote.data))queuePush(merged);
      else {setStatus('synced');setProblem(null);}
    })();
    return function(){cancelled=true;if(timer.current)clearTimeout(timer.current);};
  },[applySnapshot,queuePush]);

  useEffect(function(){
    if(!hydrated.current)return;
    const hash=JSON.stringify(appState);
    if(applyHash.current===hash){applyHash.current=null;lastLocalHash.current=hash;return;}
    if(lastLocalHash.current===hash)return;
    lastLocalHash.current=hash;
    const requestedVersion=++dirty.current;
    const now=Date.now();
    meta.current=nextLocalSyncMeta(meta.current,now);
    writeSyncMeta(meta.current);
    if(window.parent===window)return;
    if(timer.current)clearTimeout(timer.current);
    timer.current=setTimeout(function(){queuePush(rouletteSnapshot(appRef.current,meta.current),requestedVersion);},900);
    return function(){if(timer.current)clearTimeout(timer.current);};
  },[appState,queuePush]);

  return {status,problem,deviceSaved};
}

export function markRouletteAccountReset(){
  writeSyncMeta(nextResetSyncMeta(readSyncMeta(loadApp()),Date.now()));
}

export function CasinoSyncBar({sync}){
  const text=sync.status==='local'?(sync.deviceSaved?'Saved on this device · export and import through Casino to add it to an account':'Not saved · browser storage unavailable'):
    sync.status==='checking'?'Checking account sync…':sync.status==='syncing'?'Syncing with your Casino account…':
    sync.status==='synced'?'Synced with your Casino account':
    sync.deviceSaved?'Saved for this account on this device · cloud sync unavailable':
    'Not saved · Casino account storage unavailable';
  return React.createElement('section',{
    'aria-label':'Roulette account sync',
    style:{width:'100%',minHeight:30,padding:'6px 10px',borderRadius:9,border:'1px solid #2d4057',background:'#0c1520',fontSize:10,color:sync.status==='unavailable'?'#fbbf24':'#94a3b8',textAlign:'center'},
  },React.createElement('span',null,text),sync.problem?React.createElement('span',{
    role:'alert',style:{display:'block',marginTop:3,color:'#fbbf24'},
  },sync.problem):null);
}
