// -- Simulation Engine --
// Single source of truth for the Experimental (🔬) mode math.
// SimModePage owns the UI and chunked scheduling; every per-session rule lives
// here so the engine stays runnable in plain node and cannot drift from the UI.
//
// Causal model per spin: bets are decided from the droughts as they stood
// AFTER the previous spin, then the current spin resolves them, then droughts
// update. Solution bets are per-number with independent progression levels,
// matching how live Solution tracks bet (App.jsx activeBets).

function defaultSimConfig() {
  return {
    sessions: 100,
    spinsPerSession: 500,
    roulette: "european",
    strategies: [], // array of {type, config} same shape as live tracks
  };
}

// -- Group droughts (min member drought = spins since the group last hit) --
function dozenGroupDrought(droughts, d) {
  const nums=d===0?numberRange(1,12):d===1?numberRange(13,24):numberRange(25,36);
  return Math.min(...nums.map(n=>droughts[String(n)]||0));
}
function columnGroupDrought(droughts, c) {
  const nums=Array.from({length:12},(_,i)=>c+1+i*3);
  return Math.min(...nums.map(n=>droughts[String(n)]||0));
}
function evenMoneyGroupDrought(droughts, key) {
  const em=EVEN_MONEY.find(e=>e.key===key);
  if(!em) return 0;
  const nums=numberRange(1,36).filter(n=>em.pred(n));
  return Math.min(...nums.map(n=>droughts[String(n)]||0));
}
function numberRange(a,b){return Array.from({length:b-a+1},(_,i)=>a+i);}

// Fresh per-strategy result accumulators (the shape computeSimStats consumes)
function simNewResults(strategyCount) {
  return Array.from({length:strategyCount},()=>({
    sessions:[], totalPnl:0, totalWins:0, totalLosses:0, totalSeqLosses:0,
    stopLossHits:0, winStreaks:[], lossStreaks:[], currentStreak:{type:null,len:0},
    totalSequences:0, pnlHistory:[],
  }));
}

// Runs ONE full session. Streak accumulators inside `results` are updated via
// pushStreak as spins resolve. Returns per-strategy outcomes
// [{pnl,wins,losses,seqLosses,stopLossHits}], or null if shouldStop() fired
// mid-session — aborted sessions are discarded so partial data never skews stats.
function simRunSession(strategies, tables, wheelNums, spinsPerSession, results, shouldStop) {
  const sState = strategies.map(strat=>({
    level:0, pnl:0, wins:0, losses:0, seqLosses:0, stopLossHits:0,
    waitingForWin: !!(strat.config.parkRules&&strat.config.parkRules.waitForWin),
    parkedAfterLoss:false,
    activeBets:[], // solution: [{number, level}] — one progression per number, like live play
    chaseTarget:null, // auto-chase: {kind:"dozen"|"column", index} locked for the current sequence
  }));
  const droughts={};
  wheelNums.forEach(n=>{droughts[n]=0;});

  for(let sp=0; sp<spinsPerSession; sp++){
    if(shouldStop && shouldStop()) return null;
    const val = wheelNums[Math.floor(Math.random()*wheelNums.length)];

    strategies.forEach((strat,si)=>{
      const st=sState[si];
      const cfg=strat.config;
      const rules=cfg.parkRules||{};
      const tbl=tables[si];
      const unit=cfg.unit||1;

      if(rules.parkAfterLoss && st.parkedAfterLoss){ st.parkedAfterLoss=false; return; }

      if(strat.type==="fibonacci"){
        const autoChase=!!cfg.autoChase;
        const evts=autoChase?[]:(cfg.evenTargets||[]);
        let dts=autoChase?[]:(cfg.dozenTargets||[]), cts=autoChase?[]:(cfg.colTargets||[]);
        const betMode=(cfg.betMode||"progression")==="flat"?"flat":(evts.length>0?"martingale":"progression");
        const entering = betMode==="flat" || st.level===0;

        // Min-drought-to-enter is an ENTRY rule: it parks new sequences only,
        // never abandons a progression already in flight.
        if(rules.droughtThreshold && entering && !st.chaseTarget){
          let maxD=0;
          if(autoChase){
            for(let d=0;d<3;d++)maxD=Math.max(maxD,dozenGroupDrought(droughts,d));
            for(let c=0;c<3;c++)maxD=Math.max(maxD,columnGroupDrought(droughts,c));
          }
          else if(evts.length>0) evts.forEach(k=>{maxD=Math.max(maxD,evenMoneyGroupDrought(droughts,k));});
          else { dts.forEach(d=>{maxD=Math.max(maxD,dozenGroupDrought(droughts,d));}); cts.forEach(c=>{maxD=Math.max(maxD,columnGroupDrought(droughts,c));}); }
          if(maxD<rules.droughtThreshold)return;
        }

        // Auto-chase: lock onto the most-missed dozen/column at sequence start and
        // stay with it until it hits or the stop loss ends the sequence. Ties are
        // broken at random (operator ruling 2026-07-25).
        if(autoChase){
          if(!st.chaseTarget){
            const candidates=[];
            for(let d=0;d<3;d++)candidates.push({kind:"dozen",index:d,drought:dozenGroupDrought(droughts,d)});
            for(let c=0;c<3;c++)candidates.push({kind:"column",index:c,drought:columnGroupDrought(droughts,c)});
            const deepest=Math.max(...candidates.map(x=>x.drought));
            const tied=candidates.filter(x=>x.drought===deepest);
            st.chaseTarget=tied[Math.floor(Math.random()*tied.length)];
          }
          if(st.chaseTarget.kind==="dozen")dts=[st.chaseTarget.index]; else cts=[st.chaseTarget.index];
        }

        const numTargets=(evts.length||(dts.length+cts.length))||1;
        const isZ=val==="0"||val==="00";
        let hitCount=0;
        if(!isZ){
          if(evts.length>0){evts.forEach(k=>{const e=EVEN_MONEY.find(x=>x.key===k);if(e&&e.pred(+val))hitCount++;});}
          else{if(dts.includes(dozenOf(val)))hitCount++;if(cts.includes(columnOf(val)))hitCount++;}
        }
        const isHit=hitCount>0;

        // Wait-for-win: observe only, start betting after the first target hit
        if(st.waitingForWin){ if(isHit) st.waitingForWin=false; return; }

        const payMult=evts.length>0?2:3;
        const row=tbl[Math.min(st.level,tbl.length-1)];

        if(betMode==="flat"){
          if(isHit){ st.pnl+=(hitCount*payMult-numTargets)*unit; st.wins++; pushStreak(results[si],true); }
          else{
            st.pnl-=numTargets*unit; st.losses++; st.seqLosses++;
            pushStreak(results[si],false);
            if(rules.parkAfterLoss)st.parkedAfterLoss=true;
          }
          st.chaseTarget=null; // flat has no sequence — re-pick the coldest group every spin
        } else {
          if(isHit){
            st.pnl+=(hitCount*payMult*(row?row.c:1)-(row?row.c:1)*numTargets)*unit;
            st.wins++; st.level=0; st.chaseTarget=null;
            pushStreak(results[si],true);
          } else {
            st.pnl-=(row?row.c:1)*numTargets*unit; st.losses++;
            if(st.level<tbl.length-1){ st.level++; }
            else{ st.stopLossHits++; st.seqLosses++; st.level=0; st.chaseTarget=null; if(rules.parkAfterStopLoss)st.waitingForWin=true; }
            pushStreak(results[si],false);
            if(rules.parkAfterLoss)st.parkedAfterLoss=true;
          }
        }
      }

      if(strat.type==="solution"){
        const entry=cfg.entryThreshold||120;
        // Min-drought-to-enter raises the ENROLLMENT bar; bets already on the
        // table keep resolving normally.
        const effectiveEntry=Math.max(entry, rules.droughtThreshold||0);
        const valInRange=val!=="0"&&val!=="00"&&(droughts[val]||0)>=entry;

        if(rules.waitForWin && st.waitingForWin){
          if(valInRange) st.waitingForWin=false;
          return;
        }

        // Enroll every number that has crossed the entry threshold (bets for THIS spin,
        // decided from droughts as they stood after the previous spin)
        Object.keys(droughts).forEach(k=>{
          if(k!=="0"&&k!=="00"&&droughts[k]>=effectiveEntry&&!st.activeBets.find(b=>b.number===k)) st.activeBets.push({number:k,level:0});
        });

        const resolved=[];
        st.activeBets.forEach(b=>{
          const row=tbl[Math.min(b.level,tbl.length-1)];
          if(b.number===val){
            st.pnl+=((row?row.ret:0)-(row?row.c:1))*unit;
            st.wins++; resolved.push(b.number);
            pushStreak(results[si],true);
          } else {
            st.pnl-=(row?row.c:1)*unit; st.losses++;
            if(b.level<tbl.length-1){ b.level++; }
            else{ st.stopLossHits++; st.seqLosses++; b.level=0; if(rules.parkAfterStopLoss)st.waitingForWin=true; }
            pushStreak(results[si],false);
            if(rules.parkAfterLoss)st.parkedAfterLoss=true;
          }
        });
        if(resolved.length) st.activeBets=st.activeBets.filter(b=>!resolved.includes(b.number));
      }
    });

    // Droughts update AFTER every strategy has bet against this spin
    Object.keys(droughts).forEach(k=>droughts[k]++);
    droughts[val]=0;
  }

  return sState.map(st=>({
    pnl:Math.round(st.pnl*100)/100,
    wins:st.wins, losses:st.losses, seqLosses:st.seqLosses, stopLossHits:st.stopLossHits,
  }));
}

function pushStreak(result, isWin) {
  const cur = result.currentStreak;
  if(cur.type===null){ cur.type=isWin; cur.len=1; }
  else if(cur.type===isWin){ cur.len++; }
  else {
    if(cur.type) result.winStreaks.push(cur.len);
    else result.lossStreaks.push(cur.len);
    cur.type=isWin; cur.len=1;
  }
}

function computeSimStats(result) {
  const sessions = result.sessions;
  if(!sessions.length) return null;
  const pnls = sessions.map(s=>s.pnl).sort((a,b)=>a-b);
  const n = pnls.length;
  const pct = p => pnls[Math.floor(p*n/100)]||0;

  function streakDist(arr){
    const max=arr.length?Math.max(...arr):0;
    const dist={};
    arr.forEach(l=>{dist[l]=(dist[l]||0)+1;});
    const total=arr.length||1;
    return Array.from({length:max},(_,i)=>({len:i+1,count:dist[i+1]||0,pct:((dist[i+1]||0)/total*100)}));
  }

  const avgWinStreak = result.winStreaks.length ? result.winStreaks.reduce((a,b)=>a+b,0)/result.winStreaks.length : 0;
  const avgLossStreak = result.lossStreaks.length ? result.lossStreaks.reduce((a,b)=>a+b,0)/result.lossStreaks.length : 0;

  return {
    totalPnl: result.totalPnl,
    avgPnlPerSession: result.totalPnl / n,
    winRate: result.totalSequences > 0 ? result.totalWins/result.totalSequences : 0,
    p25: pct(25), p50: pct(50), p75: pct(75),
    minPnl: pnls[0], maxPnl: pnls[n-1],
    longestWinStreak: result.winStreaks.length ? Math.max(...result.winStreaks) : 0,
    longestLossStreak: result.lossStreaks.length ? Math.max(...result.lossStreaks) : 0,
    avgWinStreak, avgLossStreak,
    winStreakDist: streakDist(result.winStreaks),
    lossStreakDist: streakDist(result.lossStreaks),
    stopLossHits: result.stopLossHits,
    stopLossRate: n > 0 ? result.stopLossHits/n : 0,
    sessionPnls: pnls,
  };
}
