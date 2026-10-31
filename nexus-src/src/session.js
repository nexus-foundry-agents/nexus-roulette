// -- Session, Track, Settings Factories --
function newSession(roulette, bankroll) {
  return {
    id:generateId(), name:"Session "+new Date().toLocaleDateString(),
    created:Date.now(), modified:Date.now(),
    roulette:roulette||"american", bankroll:bankroll||500,
    bankrollCurrent:bankroll||500, totalBuyIn:0, buyIns:[],
    spins:[], droughts:initDroughts(roulette||"american"), tracks:[], totalCashOut:0, cashOuts:[],
    sessionStartedAt:null, sessionEndedAt:null,
  };
}

// `color` overrides the generic rotation — pass pickTrackColor(...) so the
// track is coloured after the dozen/column it actually bets on.
function newTrack(type, colorIdx, config, color) {
  return {
    id:generateId(), type, color:color||TRACK_COLORS[colorIdx%TRACK_COLORS.length],
    state:"active", config:{...config}, level:0, pnl:0, bets:[],
    createdAtSpin:0, closedAtSpin:null, wins:0, sequences:0,
  };
}

// Clears the spin history and everything derived from it. Money and the session record are kept:
// bankroll, buy-ins, cash-outs, timing, and each track's pnl, state and config. loadApp recomputes
// bankrollCurrent from track pnl, so pnl has to survive for that recompute to land on the same value.
// The session is stamped modified = now: clearing the numbers is a change to the session.
// Returns a new object; the input is never mutated.
function clearSpins(sess, now) {
  const next = JSON.parse(JSON.stringify(sess));
  next.spins = [];
  resetDealerChanges(next);
  next.droughts = initDroughts(next.roulette);
  next.tracks = (next.tracks||[]).map(t => {
    const config = {...(t.config||{})};
    // A solution bet carries its own progression level; restart it the way addSolBet creates a bet.
    if(Array.isArray(config.activeBets)) config.activeBets = config.activeBets.map(b => ({...b, level:0, invest:0}));
    return {...t, config, bets:[], wins:0, sequences:0, level:0, createdAtSpin:0, closedAtSpin:null, parkedAtSpin:0};
  });
  next.modified = now;
  return next;
}

// What clearSpins changes, copied before it runs, so Undo can put exactly that back. Anything outside
// this snapshot (money, the session record, a buy-in or a track added after the clear) is not part of it.
function snapshotSpinState(sess) {
  return JSON.parse(JSON.stringify({
    spins: sess.spins,
    droughts: sess.droughts,
    dealerChanges: sess.dealerChanges,
    tracks: (sess.tracks||[]).map(t => ({
      id: t.id, bets: t.bets, wins: t.wins, sequences: t.sequences, level: t.level,
      createdAtSpin: t.createdAtSpin, closedAtSpin: t.closedAtSpin, parkedAtSpin: t.parkedAtSpin || 0,
      betProgress: Array.isArray(t.config && t.config.activeBets)
        ? t.config.activeBets.map(b => ({number: b.number, level: b.level, invest: b.invest})) : null,
    })),
  }));
}

// Puts back what snapshotSpinState recorded and stamps the session modified = now. Money is not in the
// snapshot, so a buy-in, cash-out or bankroll edit made after the clear survives. A track that did not
// exist at the snapshot is left as it is. A solution number added after the clear keeps its own progress.
function restoreSpinState(sess, snap, now) {
  const next = JSON.parse(JSON.stringify(sess));
  next.spins = JSON.parse(JSON.stringify(snap.spins));
  next.droughts = JSON.parse(JSON.stringify(snap.droughts));
  if(snap.dealerChanges!==undefined)next.dealerChanges=JSON.parse(JSON.stringify(snap.dealerChanges));
  else delete next.dealerChanges;
  const saved = {};
  snap.tracks.forEach(s => { saved[s.id] = s; });
  next.tracks = (next.tracks||[]).map(t => {
    const s = saved[t.id];
    if(!s) return t;
    const config = {...(t.config||{})};
    if(s.betProgress && Array.isArray(config.activeBets)) {
      const byNumber = {};
      s.betProgress.forEach(b => { byNumber[b.number] = b; });
      config.activeBets = config.activeBets.map(b => byNumber[b.number]
        ? {...b, level: byNumber[b.number].level, invest: byNumber[b.number].invest} : b);
    }
    return {...t, config, bets: s.bets, wins: s.wins, sequences: s.sequences, level: s.level,
      createdAtSpin: s.createdAtSpin, closedAtSpin: s.closedAtSpin, parkedAtSpin: s.parkedAtSpin || 0};
  });
  next.modified = now;
  return next;
}

function defaultParkRules() {
  return {
    droughtThreshold: null,    // park if no target has drought >= N (null = disabled)
    waitForWin: false,         // don't enter until first in-range number wins
    parkAfterStopLoss: false,  // park after stop loss, resume after next observed win
    parkAfterLoss: false,      // park after any miss, resume next spin
  };
}
function defaultFibCfg() { return{type:"fibonacci",unit:1,roi:15,betMode:"progression",dozenTargets:[],colTargets:[],evenTargets:[],stopLoss:200,parkRules:defaultParkRules()}; }
function defaultSolCfg() { return{type:"solution",unit:1,roi:10,entryThreshold:120,stopLoss:200,activeBets:[],parkRules:defaultParkRules()}; }

function computeMartingaleTable(maxChips) {
  const rows=[]; let invest=0, c=1;
  for(let lvl=1;lvl<=30;lvl++) {
    const newInvest=invest+c;
    if(maxChips!==undefined&&newInvest>maxChips) break;
    const ret=2*c, profit=ret-newInvest;
    if(profit<=0) break;
    rows.push({level:lvl,c,totalBet:c,totalInvest:newInvest,ret,profit,roi:profit/newInvest*100});
    invest=newInvest; c*=2;
  }
  return rows;
}

function defaultSettings() {
  return{ currency:"USD", defaultBuyIn:100, onboarded:false, vibration:true, showDroughtCounts:true, headStartUnseen:false, counterShows:"spins", percentileOutlines:true, tableMinBet:10, tableMaxBet:500, tableMaxTotal:10000 };
}

// Standalone keeps the historical keys. Embedded storage stays closed until the authenticated
// shell supplies an opaque account scope, so one account can never render or overwrite another
// account's device-local state on a shared browser.
let rouletteAccountStorageScope=window.parent===window?'standalone':null;
let rouletteAccountStorageWritable=window.parent===window;
function rouletteStorageKey(base){
  if(rouletteAccountStorageScope==='standalone')return base;
  return rouletteAccountStorageScope?base+':account:'+rouletteAccountStorageScope:null;
}
function beginRouletteAccountStorage(scope){
  if(typeof scope!=='string'||!/^[A-Za-z0-9_-]{32}$/.test(scope))return false;
  rouletteAccountStorageScope=scope;
  rouletteAccountStorageWritable=false;
  try{window.dispatchEvent(new CustomEvent('nexus-account-scope-ready'));}catch(_error){}
  return true;
}
function enableRouletteAccountStorage(){rouletteAccountStorageWritable=!!rouletteAccountStorageScope;}
function freshAppState(){
  return {savedSessions:[],currentSession:newSession(),gameSession:newSession(),settings:defaultSettings()};
}
function loadRouletteUiState(){
  const key=rouletteStorageKey('nexus_ui');
  if(!key)return {};
  try{return JSON.parse(localStorage.getItem(key)||'{}')||{};}catch(_error){return {};}
}
function saveRouletteUiState(value){
  const key=rouletteStorageKey('nexus_ui');
  if(!key||!rouletteAccountStorageWritable)return;
  try{localStorage.setItem(key,JSON.stringify(value));}catch(_error){}
}
function clearRouletteLocalState(){
  const appKey=rouletteStorageKey(STORAGE_KEY),uiKey=rouletteStorageKey('nexus_ui');
  if(appKey)localStorage.removeItem(appKey);
  if(uiKey)localStorage.removeItem(uiKey);
}

function loadApp() {
  try {
    const key=rouletteStorageKey(STORAGE_KEY);
    if(!key)return freshAppState();
    const raw = localStorage.getItem(key);
    if(!raw) { console.warn("NEXUS: No saved data found in localStorage (key="+key+")"); return freshAppState(); }
    const d = JSON.parse(raw);
    if(d) {
      if(!d.settings) d.settings = defaultSettings();
      if(!d.settings.currency) d.settings.currency = "USD";
      if(!d.settings.defaultBuyIn) d.settings.defaultBuyIn = 100;
      if(d.settings.onboarded === undefined) d.settings.onboarded = true; // existing users skip
      if(d.settings.tableMinBet === undefined) d.settings.tableMinBet = 10;
      if(d.settings.tableMaxBet === undefined) d.settings.tableMaxBet = 500;
      if(d.settings.tableMaxTotal === undefined) d.settings.tableMaxTotal = 10000;
      if(!d.currentSession) d.currentSession = newSession();
      if(!d.gameSession) d.gameSession = newSession(d.currentSession.roulette, d.currentSession.bankroll);
      if(!d.gameSession.totalBuyIn) d.gameSession.totalBuyIn = 0;
      if(!d.gameSession.buyIns) d.gameSession.buyIns = [];
      if(!d.gameSession.totalCashOut) d.gameSession.totalCashOut = 0;
      if(!d.gameSession.cashOuts) d.gameSession.cashOuts = [];
      if(!d.currentSession.totalBuyIn) d.currentSession.totalBuyIn = 0;
      if(!d.currentSession.buyIns) d.currentSession.buyIns = [];
      if(!d.currentSession.totalCashOut) d.currentSession.totalCashOut = 0;
      if(!d.currentSession.cashOuts) d.currentSession.cashOuts = [];
      if(d.currentSession.sessionStartedAt===undefined) d.currentSession.sessionStartedAt = null;
      if(d.currentSession.sessionEndedAt===undefined) d.currentSession.sessionEndedAt = null;
      // Venue migration (F11): sessions saved before venues existed have no venue keys and are left as they were.
      [d.currentSession, d.gameSession].concat(d.savedSessions||[]).forEach(migrateSessionVenue);
      // Park points (migrateParkPoints): a parked track with none gets its session's spin count at load. Same sessions as the venue migration.
      [d.currentSession, d.gameSession].concat(d.savedSessions||[]).forEach(migrateParkPoints);
      // Auto-recalibrate bankroll from track P&Ls to fix any float drift.
      // Both live sessions have the same shape and the same drift exposure.
      [d.currentSession, d.gameSession].forEach(sess => {
        sess.bankrollCurrent = Math.round((
          sess.bankroll +
          (sess.totalBuyIn||0) -
          (sess.totalCashOut||0) +
          (sess.tracks||[]).reduce((sum,t) => sum + t.pnl*(t.config.unit||1), 0)
        )*100)/100;
      });
      const sess = d.currentSession;
      console.log("NEXUS: Loaded "+((d.savedSessions||[]).length)+" saved sessions, current has "+sess.spins.length+" spins");
      return d;
    }
  } catch(e) { console.error("NEXUS: loadApp crashed:", e); }
  return freshAppState();
}

function saveApp(state) {
  const key=rouletteStorageKey(STORAGE_KEY);
  if(!key||!rouletteAccountStorageWritable)return false;
  const saved=writeRouletteStorage(localStorage,key,state,function(e){
    console.error("NEXUS: saveApp FAILED:", e);
    // Surfaced as an in-app banner (App listens for this event) — never a
    // blocking browser dialog.
    try{ window.dispatchEvent(new CustomEvent("nexus-save-error",{detail:e.message})); }catch(_e){}
  });
  try{window.dispatchEvent(new CustomEvent(saved?"nexus-save-success":"nexus-save-failed"));}catch(_error){}
  return saved;
}

function computeMetrics(session) {
  const perTrack = session.tracks.map(t => {
    const ws=t.bets.filter(b=>b.outcome==="win").length;
    const ls=t.bets.filter(b=>b.outcome==="loss").length;
    return{id:t.id,type:t.type,color:t.color,state:t.state,
      pnlDollars:t.pnl*(t.config.unit||1),totalBets:t.bets.length,
      wins:ws,losses:ls,winRate:t.bets.length>0?ws/t.bets.length:0,
      maxLevel:t.bets.reduce((m,b)=>Math.max(m,b.level),0),
      jackpots:t.bets.filter(b=>b.cat==="jackpot").length};
  });
  // Net P&L = everything the player holds (chips on the table + cash already
  // pocketed) minus everything they put in. Cash-outs move winnings out of the
  // visible bankroll — they are NOT losses, so they must be added back.
  const totalInvested = session.bankroll + (session.totalBuyIn||0);
  return{spins:session.spins.length,netPnL:session.bankrollCurrent+(session.totalCashOut||0)-totalInvested,
    bankrollStart:session.bankroll,bankrollCurrent:session.bankrollCurrent,
    totalBuyIn:session.totalBuyIn||0,perTrack};
}

// -- Venue (F11): where a session was played --
// A session's venue is optional, and so is every field in it. kind is 'machine' or 'table'. A machine carries
// maker, model and version; a table carries table and dealer. dealerChanges is [{fromSpin, dealer}] in spin
// order: the dealer in effect from spin index fromSpin until the next entry. venue.dealer always equals the
// dealer of the last entry. Text is trimmed, never truncated.
const VENUE_FIELDS=['casino','maker','model','version','table','dealer'];

function venueText(value){return typeof value==='string'&&value.trim()?value.trim():null;}

// The venue in its stored shape, or null when nothing is recorded.
function normalizeVenue(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const out={};
  const casino=venueText(raw.casino);
  if(casino)out.casino=casino;
  if(raw.kind==='machine'||raw.kind==='table'){
    out.kind=raw.kind;
    (raw.kind==='machine'?['maker','model','version']:['table','dealer']).forEach(key=>{
      const text=venueText(raw[key]);
      if(text)out[key]=text;
    });
  }
  return Object.keys(out).length?out:null;
}

function sortedDealerChanges(list){
  return list
    .filter(e=>!!e&&typeof e==='object'&&Number.isSafeInteger(e.fromSpin)&&e.fromSpin>=0&&(e.dealer===null||typeof e.dealer==='string'))
    .map(e=>({fromSpin:e.fromSpin,dealer:venueText(e.dealer)}))
    .sort((a,b)=>a.fromSpin-b.fromSpin);
}

// Sessions saved before venues existed carry neither key and come back exactly as they were. A malformed
// venue reads as no venue. Runs on load, for the live sessions and every saved session.
function migrateSessionVenue(sess){
  if(!sess||typeof sess!=='object')return sess;
  if('venue' in sess)sess.venue=normalizeVenue(sess.venue);
  if('dealerChanges' in sess)sess.dealerChanges=Array.isArray(sess.dealerChanges)?sortedDealerChanges(sess.dealerChanges):[];
  if('label' in sess)sess.label=normalizeLabel(sess.label);
  return sess;
}

// Park points. A park stamps the spin count it was made at (parkToggle, and the import's park in session-files.jsx), and
// spin-apply.js's lastParkSpin reads it. A parked track with no park point was parked before the stamp existed, or came in
// without one. It gets the session's spin count at load: the conservative mark, so no spin before this load can be corrected
// into a record the park has already fixed. A park point already stamped is never moved, so a later load changes nothing.
function migrateParkPoints(sess){
  if(!sess||typeof sess!=='object'||!Array.isArray(sess.tracks))return sess;
  const at=Array.isArray(sess.spins)?sess.spins.length:0;
  sess.tracks.forEach(t=>{if(t&&t.state==='parked'&&!Number.isSafeInteger(t.parkedAtSpin))t.parkedAtSpin=at;});
  return sess;
}

// The dealer recorded last, which is the dealer now at the table, or null.
function dealerNow(sess){
  const list=sess.dealerChanges||[];
  return list.length?list[list.length-1].dealer:null;
}

// The dealer in effect at spin index i, or null before the first recorded dealer.
function dealerAtSpin(sess,i){
  let dealer=null;
  (sess.dealerChanges||[]).forEach(e=>{if(e.fromSpin<=i)dealer=e.dealer;});
  return dealer;
}

// The spans of a session that share one dealer, from spin 0 to spinCount: [{from, to, dealer}], empty spans dropped.
function dealerSegments(sess,spinCount){
  const starts=[0].concat((sess.dealerChanges||[]).map(e=>e.fromSpin));
  const bounds=starts.filter((v,i)=>starts.indexOf(v)===i&&(v<spinCount||v===0)).sort((a,b)=>a-b);
  return bounds.map((from,i)=>({
    from,
    to:i+1<bounds.length?Math.min(bounds[i+1],spinCount):spinCount,
    dealer:dealerAtSpin(sess,from),
  })).filter(seg=>seg.to>seg.from);
}

// Records the dealer from spin index fromSpin, replacing a change already recorded at that index.
function setDealerAt(sess,dealer,fromSpin){
  const list=(sess.dealerChanges||[]).filter(e=>e.fromSpin!==fromSpin);
  list.push({fromSpin,dealer:venueText(dealer)});
  sess.dealerChanges=list.sort((a,b)=>a.fromSpin-b.fromSpin);
}

// A live session records a dealer change at the spin it starts from. An ended session records its starting
// dealer at spin 0.
function dealerSpinFor(sess,spinCount){return sess.sessionEndedAt?0:spinCount;}

// An ended session whose dealer changed after its start keeps those changes as recorded; its dealer is not
// edited from the venue picker.
function dealerLocked(sess){
  return !!sess.sessionEndedAt&&(sess.dealerChanges||[]).some(e=>e.fromSpin>0);
}

// A copy of the session with its venue set to venueInput (any shape; normalized here). For a table, a dealer that
// differs from the one in effect is recorded: the first dealer a session has covers it from spin 0, and a later
// change starts at spinCount (or at spin 0 for an ended session). A locked dealer is not changed. The input is not mutated.
function withVenue(sess,venueInput,spinCount){
  const next=JSON.parse(JSON.stringify(sess));
  const venue=normalizeVenue(venueInput);
  next.venue=venue;
  if(venue&&venue.kind==='table'){
    const want=venue.dealer||null;
    const first=!(next.dealerChanges||[]).length;
    if(want!==dealerNow(next)&&!dealerLocked(next))setDealerAt(next,want,first?0:dealerSpinFor(next,spinCount));
    const now=dealerNow(next);
    if(now)venue.dealer=now;
    else delete venue.dealer;
  }
  return next;
}

// Spin indices restart at zero when the spins are cleared, so the dealer in effect is recorded from spin 0 again.
function resetDealerChanges(sess){
  if(!Array.isArray(sess.dealerChanges))return;
  const now=dealerNow(sess);
  sess.dealerChanges=now?[{fromSpin:0,dealer:now}]:[];
}

// The value offered in one venue field's list: each value that saved sessions, the current session (dealers
// recorded mid-session included) or an entry typed by hand has used, once (case-insensitive, the latest spelling
// kept), most recent first. A session counts at its last change.
function venueOptions(field,sessions,entries){
  const seen={};
  const put=(value,at)=>{
    const text=venueText(value);
    if(!text)return;
    const key=text.toLowerCase();
    if(!seen[key]||at>=seen[key].at)seen[key]={value:text,at};
  };
  (sessions||[]).forEach(s=>{
    if(!s||typeof s!=='object')return;
    const at=Math.max(0,Number(s.modified)||0,Number(s.created)||0);
    const venue=normalizeVenue(s.venue);
    if(venue)put(venue[field],at);
    if(field==='dealer')(s.dealerChanges||[]).forEach(e=>put(e.dealer,at));
  });
  (entries||[]).forEach(e=>{if(e&&e.field===field)put(e.value,Number(e.at)||0);});
  return Object.keys(seen).map(k=>seen[k])
    .sort((a,b)=>b.at-a.at||a.value.localeCompare(b.value))
    .map(x=>x.value);
}

// The choices a field offers: its list without the value already applied, which the trigger shows (rule 78).
function venueChoiceList(options,current){
  const applied=(current||'').toLowerCase();
  return (options||[]).filter(o=>o.toLowerCase()!==applied);
}

// The settings list of values typed by hand, with each new value added once per field (case-insensitive).
// The newest spelling and time replace an older entry for the same value.
function addVenueEntries(entries,added,now){
  const out=(entries||[]).filter(e=>e&&VENUE_FIELDS.indexOf(e.field)>=0&&typeof e.value==='string');
  (added||[]).forEach(a=>{
    const value=venueText(a&&a.value);
    if(!value||VENUE_FIELDS.indexOf(a.field)<0)return;
    const key=a.field+'|'+value.toLowerCase();
    const entry={field:a.field,value,at:now};
    const i=out.findIndex(e=>e.field+'|'+e.value.toLowerCase()===key);
    if(i>=0)out[i]=entry;
    else out.push(entry);
  });
  return out;
}

// The one-line venue shown in the Live header and the session list. Empty when no venue is recorded.
function venueLine(venue){
  const v=normalizeVenue(venue);
  if(!v)return '';
  const parts=[v.casino];
  if(v.kind==='machine')parts.push([v.maker,v.model,v.version].filter(Boolean).join(' '));
  if(v.kind==='table')parts.push(v.table,v.dealer?'Dealer '+v.dealer:null);
  return parts.filter(Boolean).join(' · ');
}

function venueMachineLabel(v){return [v.maker,v.model,v.version].filter(Boolean).join(' ')||'No machine details';}
function venueTableLabel(v,dealer){return (v.table||'No table label')+' · '+(dealer||'no dealer');}

// Spin counts across saved sessions, by casino, machine, and table and dealer. A table session is split at its
// dealer changes. Spins in sessions with no venue are counted on their own line, so every row reconciles with
// the total. Counts only.
function venueSpinCounts(sessions){
  const out={total:0,noVenue:0,casino:{},machine:{},table:{}};
  const add=(map,label,n)=>{map[label]=(map[label]||0)+n;};
  (sessions||[]).forEach(s=>{
    const spins=Array.isArray(s.spins)?s.spins.length:0;
    out.total+=spins;
    const v=normalizeVenue(s.venue);
    if(!v){out.noVenue+=spins;return;}
    add(out.casino,v.casino||'No casino name',spins);
    if(v.kind==='machine')add(out.machine,venueMachineLabel(v),spins);
    if(v.kind==='table')dealerSegments(s,spins).forEach(seg=>add(out.table,venueTableLabel(v,seg.dealer),seg.to-seg.from));
  });
  return out;
}

// A count map as rows, largest first.
function venueCountRows(map){
  return Object.keys(map||{}).map(label=>({label,count:map[label]}))
    .sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label));
}

// -- Session label and resume (F13) --
// A saved session may carry an optional label: trimmed, at most 60 characters, or null when empty.
const SESSION_LABEL_MAX=60;
function normalizeLabel(value){
  if(typeof value!=='string')return null;
  return value.trim().slice(0,SESSION_LABEL_MAX).trim()||null;
}

// The mode a saved session resumes into: 'game' for a Game session, otherwise 'live' (sessions saved before modes
// existed carry no mode and are Live, as the Stats list has always shown them).
function savedSessionMode(sess){return sess&&sess.mode==='game'?'game':'live';}

// The part of a session a save writes, without the stamps a save or a rename sets (modified, metrics, mode).
function sessionContent(sess){
  const copy=JSON.parse(JSON.stringify(sess));
  delete copy.modified;
  delete copy.metrics;
  delete copy.mode;
  return JSON.stringify(copy);
}

// How many spins of the current session the saved copy does not have. When the saved spins are a prefix of the
// current spins, the difference is the unsaved count; any other change to the spin history counts every current spin.
function unsavedSpinCount(sess,savedList){
  const spins=Array.isArray(sess&&sess.spins)?sess.spins:[];
  const saved=(savedList||[]).find(x=>!!x&&x.id===sess.id);
  if(!saved)return spins.length;
  const savedSpins=Array.isArray(saved.spins)?saved.spins:[];
  if(savedSpins.length<=spins.length&&savedSpins.every((v,i)=>v===spins[i]))return spins.length-savedSpins.length;
  return spins.length;
}

// True when the current session holds work the saved list does not: a session never saved that has spins, tracks,
// buy-ins or cash-outs, or a saved session whose content has changed since it was saved.
function sessionHasUnsavedWork(sess,savedList){
  if(!sess)return false;
  const saved=(savedList||[]).find(x=>!!x&&x.id===sess.id);
  if(!saved)return (sess.spins||[]).length>0||(sess.tracks||[]).length>0||(sess.buyIns||[]).length>0||(sess.cashOuts||[]).length>0;
  return sessionContent(sess)!==sessionContent(saved);
}

// Resumes a saved session. The session that is current under activeMode is saved first when it holds work the saved
// list does not have; then the saved copy becomes the current session of its own mode, exactly as it was saved. A Game
// session goes to gameSession, any other to currentSession. Returns a new state object and does not mutate the input.
// The state is returned unchanged when the id is not saved or is already the current session of the active mode.
function resumeSavedSession(state,id,activeMode,now){
  const saved=(state.savedSessions||[]).find(x=>!!x&&x.id===id);
  const activeKey=activeMode==='game'?'gameSession':'currentSession';
  const current=state[activeKey];
  if(!saved||(current&&current.id===id))return state;
  const next=JSON.parse(JSON.stringify(state));
  next.savedSessions=next.savedSessions||[];
  const liveCurrent=next[activeKey];
  if(liveCurrent&&sessionHasUnsavedWork(liveCurrent,next.savedSessions)){
    const copy=JSON.parse(JSON.stringify(liveCurrent));
    copy.modified=now;
    copy.mode=activeMode==='game'?'game':'live';
    copy.metrics=computeMetrics(copy);
    const at=next.savedSessions.findIndex(x=>!!x&&x.id===copy.id);
    if(at>=0)next.savedSessions[at]=copy;
    else next.savedSessions.push(copy);
    next[activeKey]=JSON.parse(JSON.stringify(copy));
  }
  next[savedSessionMode(saved)==='game'?'gameSession':'currentSession']=JSON.parse(JSON.stringify(saved));
  return next;
}

// Sets the label of a saved session, and of the live copy with the same id so that a later save keeps it. The new
// label is stamped with now as modified, so the sync merge keeps this copy over an older one. Returns a new state object.
function renameSavedSession(state,id,label,now){
  const next=JSON.parse(JSON.stringify(state));
  const value=normalizeLabel(label);
  next.savedSessions=(next.savedSessions||[]).map(x=>{
    if(!x||x.id!==id)return x;
    x.label=value;
    x.modified=now;
    return x;
  });
  ['currentSession','gameSession'].forEach(key=>{
    const live=next[key];
    if(live&&live.id===id){live.label=value;live.modified=now;}
  });
  return next;
}
