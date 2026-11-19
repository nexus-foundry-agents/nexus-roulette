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
    bankrollMode: false,   // carry P&L across sessions from one buy-in
    bankrollStart: 500,    // the buy-in (separate from any per-strategy stop loss)
    repeatExperiments: 1,  // run the whole configured experiment N times with identical parameters
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
    totalSequences:0, pnlHistory:[], totalStaked:0,
    rawLossStreaks:[], rawOpen:{}, // every miss run on the strategy's targets from spin 1, betting or not
    satOutSessions:0, // sessions where the strategy never placed a single bet
    bankrollStart:null, bankrollCurrent:null, busted:false, bustedAtSession:null, // bankroll mode
  }));
}

// Runs ONE full session. Streak accumulators inside `results` are updated via
// pushStreak as spins resolve. Returns per-strategy outcomes
// [{pnl,wins,losses,seqLosses,stopLossHits}], or null if shouldStop() fired
// mid-session — aborted sessions are discarded so partial data never skews stats.
function simRunSession(strategies, tables, wheelNums, spinsPerSession, results, shouldStop, activeMask) {
  const sessionStates = strategies.map(strategy=>({
    level:0, pnl:0, wins:0, losses:0, seqLosses:0, stopLossHits:0,
    staked:0, // total money placed on the felt this session (drives expected-loss math)
    trough:0, peak:0, // deepest drawdown / highest running P&L within this session
    waitingForWin: !!(strategy.config.parkRules&&strategy.config.parkRules.waitForWin),
    parkedAfterLoss:false,
    activeBets:[], // solution: [{number, level}] — one progression per number, like live play
    chaseTarget:null, // auto-chase: {kind:"dozen"|"column", index} locked for the current sequence
  }));
  const droughts={};
  wheelNums.forEach(n=>{droughts[n]=0;});

  for(let spinIndex=0; spinIndex<spinsPerSession; spinIndex++){
    if(shouldStop && shouldStop()) return null;
    const winningNumber = wheelNums[Math.floor(Math.random()*wheelNums.length)];

    strategies.forEach((strategy,strategyIndex)=>{
      if(activeMask && activeMask[strategyIndex]===false) return; // busted in bankroll mode — out of the game
      const strategyState=sessionStates[strategyIndex];
      const config=strategy.config;
      const rules=config.parkRules||{};
      const progressionTable=tables[strategyIndex];
      const unit=config.unit||1;

      if(rules.parkAfterLoss && strategyState.parkedAfterLoss){ strategyState.parkedAfterLoss=false; return; }

      if(strategy.type==="fibonacci"){
        const autoChase=!!config.autoChase;
        const evenMoneyTargets=autoChase?[]:(config.evenTargets||[]);
        let dozenTargets=autoChase?[]:(config.dozenTargets||[]), columnTargets=autoChase?[]:(config.colTargets||[]);
        const betMode=(config.betMode||"progression")==="flat"?"flat":(evenMoneyTargets.length>0?"martingale":"progression");
        const entering = betMode==="flat" || strategyState.level===0;

        // Min-drought-to-enter is an ENTRY rule: it parks new sequences only,
        // never abandons a progression already in flight.
        if(rules.droughtThreshold && entering && !strategyState.chaseTarget){
          let deepestGroupDrought=0;
          if(autoChase){
            for(let d=0;d<3;d++)deepestGroupDrought=Math.max(deepestGroupDrought,dozenGroupDrought(droughts,d));
            for(let c=0;c<3;c++)deepestGroupDrought=Math.max(deepestGroupDrought,columnGroupDrought(droughts,c));
          }
          else if(evenMoneyTargets.length>0) evenMoneyTargets.forEach(k=>{deepestGroupDrought=Math.max(deepestGroupDrought,evenMoneyGroupDrought(droughts,k));});
          else { dozenTargets.forEach(d=>{deepestGroupDrought=Math.max(deepestGroupDrought,dozenGroupDrought(droughts,d));}); columnTargets.forEach(c=>{deepestGroupDrought=Math.max(deepestGroupDrought,columnGroupDrought(droughts,c));}); }
          if(deepestGroupDrought<rules.droughtThreshold)return;
        }

        // Auto-chase: lock onto the most-missed dozen/column at sequence start and
        // stay with it until it hits or the stop loss ends the sequence. Ties are
        // broken at random (operator ruling 2026-07-25).
        if(autoChase){
          if(!strategyState.chaseTarget){
            const candidates=[];
            for(let d=0;d<3;d++)candidates.push({kind:"dozen",index:d,drought:dozenGroupDrought(droughts,d)});
            for(let c=0;c<3;c++)candidates.push({kind:"column",index:c,drought:columnGroupDrought(droughts,c)});
            const deepest=Math.max(...candidates.map(x=>x.drought));
            const tied=candidates.filter(x=>x.drought===deepest);
            strategyState.chaseTarget=tied[Math.floor(Math.random()*tied.length)];
          }
          if(strategyState.chaseTarget.kind==="dozen")dozenTargets=[strategyState.chaseTarget.index]; else columnTargets=[strategyState.chaseTarget.index];
        }

        const numTargets=(evenMoneyTargets.length||(dozenTargets.length+columnTargets.length))||1;
        const isZeroPocket=winningNumber==="0"||winningNumber==="00";
        let hitCount=0;
        if(!isZeroPocket){
          if(evenMoneyTargets.length>0){evenMoneyTargets.forEach(k=>{const e=EVEN_MONEY.find(x=>x.key===k);if(e&&e.pred(+winningNumber))hitCount++;});}
          else{if(dozenTargets.includes(dozenOf(winningNumber)))hitCount++;if(columnTargets.includes(columnOf(winningNumber)))hitCount++;}
        }
        const isHit=hitCount>0;

        // Wait-for-win: observe only, start betting after the first target hit
        if(strategyState.waitingForWin){ if(isHit) strategyState.waitingForWin=false; return; }

        const payMult=evenMoneyTargets.length>0?2:3;
        const row=progressionTable[Math.min(strategyState.level,progressionTable.length-1)];
        strategyState.staked+=(betMode==="flat"?numTargets:(row?row.c:1)*numTargets)*unit;

        if(betMode==="flat"){
          if(isHit){ strategyState.pnl+=(hitCount*payMult-numTargets)*unit; strategyState.wins++; pushStreak(results[strategyIndex],true); }
          else{
            strategyState.pnl-=numTargets*unit; strategyState.losses++; strategyState.seqLosses++;
            pushStreak(results[strategyIndex],false);
            if(rules.parkAfterLoss)strategyState.parkedAfterLoss=true;
          }
          strategyState.chaseTarget=null; // flat has no sequence — re-pick the coldest group every spin
        } else {
          if(isHit){
            strategyState.pnl+=(hitCount*payMult*(row?row.c:1)-(row?row.c:1)*numTargets)*unit;
            strategyState.wins++; strategyState.level=0; strategyState.chaseTarget=null;
            pushStreak(results[strategyIndex],true);
          } else {
            strategyState.pnl-=(row?row.c:1)*numTargets*unit; strategyState.losses++;
            if(strategyState.level<progressionTable.length-1){ strategyState.level++; }
            else{ strategyState.stopLossHits++; strategyState.seqLosses++; strategyState.level=0; strategyState.chaseTarget=null; if(rules.parkAfterStopLoss)strategyState.waitingForWin=true; }
            pushStreak(results[strategyIndex],false);
            if(rules.parkAfterLoss)strategyState.parkedAfterLoss=true;
          }
        }
      }

      if(strategy.type==="solution"){
        const entry=config.entryThreshold||120;
        // Min-drought-to-enter raises the ENROLLMENT bar; bets already on the
        // table keep resolving normally.
        const effectiveEntry=Math.max(entry, rules.droughtThreshold||0);
        const valInRange=solutionInRangeMember(droughts,winningNumber,entry);

        if(rules.waitForWin && strategyState.waitingForWin){
          if(valInRange) strategyState.waitingForWin=false;
          return;
        }

        // Enroll every number that has crossed the entry threshold (bets for THIS spin,
        // decided from droughts as they stood after the previous spin)
        wheelNums.forEach(k=>{
          if(solutionInRangeMember(droughts,k,effectiveEntry)&&!strategyState.activeBets.find(b=>b.number===k)) strategyState.activeBets.push({number:k,level:0});
        });

        const resolved=[];
        strategyState.activeBets.forEach(b=>{
          const row=progressionTable[Math.min(b.level,progressionTable.length-1)];
          strategyState.staked+=(row?row.c:1)*unit;
          if(b.number===winningNumber){
            strategyState.pnl+=((row?row.ret:0)-(row?row.c:1))*unit;
            strategyState.wins++; resolved.push(b.number);
            pushStreak(results[strategyIndex],true);
          } else {
            strategyState.pnl-=(row?row.c:1)*unit; strategyState.losses++;
            if(b.level<progressionTable.length-1){ b.level++; }
            else{ strategyState.stopLossHits++; strategyState.seqLosses++; b.level=0; if(rules.parkAfterStopLoss)strategyState.waitingForWin=true; }
            pushStreak(results[strategyIndex],false);
            if(rules.parkAfterLoss)strategyState.parkedAfterLoss=true;
          }
        });
        if(resolved.length) strategyState.activeBets=strategyState.activeBets.filter(b=>!resolved.includes(b.number));
      }
    });

    sessionStates.forEach(strategyState=>{
      if(strategyState.pnl<strategyState.trough)strategyState.trough=strategyState.pnl;
      if(strategyState.pnl>strategyState.peak)strategyState.peak=strategyState.pnl;
    });

    // Raw loss streaks: every spin, whether or not the strategy bet, each
    // target closes or extends its miss run. Not gated by drought entry or parking.
    strategies.forEach((strategy,strategyIndex)=>{
      if(activeMask && activeMask[strategyIndex]===false) return;
      const r=results[strategyIndex];
      rawTargetOutcomes(strategy,winningNumber,wheelNums).forEach(({key,hit})=>{
        if(hit){ if(r.rawOpen[key]>0) r.rawLossStreaks.push(r.rawOpen[key]); r.rawOpen[key]=0; }
        else r.rawOpen[key]=(r.rawOpen[key]||0)+1;
      });
    });

    // Droughts update AFTER every strategy has bet against this spin
    Object.keys(droughts).forEach(k=>droughts[k]++);
    droughts[winningNumber]=0;
  }

  // A streak never spans two sessions: close whatever run is open when the
  // session ends, so the distribution counts streaks within sessions.
  results.forEach(r=>{ flushStreak(r); flushRawLoss(r); });

  return sessionStates.map(strategyState=>({
    pnl:Math.round(strategyState.pnl*100)/100,
    wins:strategyState.wins, losses:strategyState.losses, seqLosses:strategyState.seqLosses, stopLossHits:strategyState.stopLossHits,
    staked:Math.round(strategyState.staked*100)/100,
    trough:Math.round(strategyState.trough*100)/100, peak:Math.round(strategyState.peak*100)/100,
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

// Closes the open streak (if any) into winStreaks/lossStreaks and resets it.
function flushStreak(result) {
  const cur = result.currentStreak;
  if(cur.len>0){
    if(cur.type) result.winStreaks.push(cur.len);
    else result.lossStreaks.push(cur.len);
  }
  cur.type=null; cur.len=0;
}

// The targets a strategy's raw loss streaks follow, and whether this spin hit
// each. Fibonacci: one combined target (the bet loses only when no target
// hits); auto-chase: each dozen and column separately, since any can be chased.
// Solution: every number on the wheel, each its own target.
function rawTargetOutcomes(strategy, winningNumber, wheelNums) {
  const config=strategy.config||{};
  const isZero=winningNumber==="0"||winningNumber==="00";
  if(strategy.type==="solution") return wheelNums.map(n=>({key:"n"+n,hit:n===winningNumber}));
  if(config.autoChase){
    const out=[];
    for(let d=0;d<3;d++) out.push({key:"d"+d,hit:!isZero&&dozenOf(winningNumber)===d});
    for(let c=0;c<3;c++) out.push({key:"c"+c,hit:!isZero&&columnOf(winningNumber)===c});
    return out;
  }
  const ev=config.evenTargets||[], dz=config.dozenTargets||[], co=config.colTargets||[];
  if(!ev.length&&!dz.length&&!co.length) return [];
  let hit=false;
  if(!isZero){
    if(ev.length) hit=ev.some(k=>{const e=EVEN_MONEY.find(x=>x.key===k);return e&&e.pred(+winningNumber);});
    else hit=dz.includes(dozenOf(winningNumber))||co.includes(columnOf(winningNumber));
  }
  return [{key:"t",hit}];
}

// Closes every open raw miss run at session end.
function flushRawLoss(result) {
  Object.keys(result.rawOpen).forEach(k=>{ if(result.rawOpen[k]>0) result.rawLossStreaks.push(result.rawOpen[k]); });
  result.rawOpen={};
}

// Every length from 1 to the longest seen: count, share of all streaks of
// that kind, share at or beyond this length, and share of the spins those
// streaks took (count × length ÷ total spins in streaks).
function streakDist(arr){
  const max=arr.length?Math.max(...arr):0;
  const dist={};
  arr.forEach(l=>{dist[l]=(dist[l]||0)+1;});
  const total=arr.length||1;
  const spins=arr.reduce((a,b)=>a+b,0)||1;
  let remaining=arr.length;
  return Array.from({length:max},(_,i)=>{
    const len=i+1, count=dist[len]||0;
    const row={len,count,pct:count/total*100,atLeastPct:remaining/total*100,spinPct:count*len/spins*100};
    remaining-=count;
    return row;
  });
}

function computeSimStats(result) {
  const sessions = result.sessions;
  if(!sessions.length) return null;
  const pnls = sessions.map(s=>s.pnl).sort((a,b)=>a-b);
  const n = pnls.length;
  const pct = p => pnls[Math.floor(p*n/100)]||0;

  const avgWinStreak = result.winStreaks.length ? result.winStreaks.reduce((a,b)=>a+b,0)/result.winStreaks.length : 0;
  const avgLossStreak = result.lossStreaks.length ? result.lossStreaks.reduce((a,b)=>a+b,0)/result.lossStreaks.length : 0;

  const winSessions = sessions.filter(s=>s.pnl>0);
  const lossSessions = sessions.filter(s=>s.pnl<0);
  const avg = arr => arr.length ? arr.reduce((a,s)=>a+s.pnl,0)/arr.length : 0;

  return {
    totalPnl: result.totalPnl,
    avgPnlPerSession: result.totalPnl / n,
    avgWinSession: avg(winSessions),        // mean P&L across profitable sessions only
    avgLossSession: avg(lossSessions),      // mean P&L across losing sessions only
    winSessionCount: winSessions.length,
    lossSessionCount: lossSessions.length,
    avgPnlPerSequence: result.totalSequences>0 ? result.totalPnl/result.totalSequences : 0,
    avgSequencesPerSession: result.totalSequences/n,
    avgStakedPerSession: (result.totalStaked||0)/n,
    totalStaked: result.totalStaked||0,
    winRate: result.totalSequences > 0 ? result.totalWins/result.totalSequences : 0,
    p25: pct(25), p50: pct(50), p75: pct(75),
    minPnl: pnls[0], maxPnl: pnls[n-1],
    longestWinStreak: result.winStreaks.length ? Math.max(...result.winStreaks) : 0,
    longestLossStreak: result.lossStreaks.length ? Math.max(...result.lossStreaks) : 0,
    avgWinStreak, avgLossStreak,
    winStreakDist: streakDist(result.winStreaks),
    lossStreakDist: streakDist(result.lossStreaks),
    rawLossStreakDist: streakDist(result.rawLossStreaks||[]),
    stopLossHits: result.stopLossHits,
    stopLossRate: n > 0 ? result.stopLossHits/n : 0,
    sessionPnls: pnls,
  };
}
