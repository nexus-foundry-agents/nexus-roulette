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
  return{ currency:"USD", defaultBuyIn:100, onboarded:false, vibration:true, tableMinBet:10, tableMaxBet:500, tableMaxTotal:10000 };
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
