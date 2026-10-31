// -- Game Page --
// Moved from App.jsx. App renders it through a wrapper that passes every App value the page reads.
// Body unchanged except two marked edits: the drought grid is now DroughtPanel, and the strategy chips
// take the tracks as an argument.
function GamePageView({
  addOpen, addTrack, animNumber, betResults, clearTimerRef, closeTrack, colD, colP, cur,
  currency, dozD, dozP, editTrackId, emDroughts, endSession, recordGameSpin, gameResult, gameSpinning,
  isLandscape, lastBets, lastSpinDelta, manualBets, nextColorIdx, nonClosedTracks, parkToggle, pendingTrackCfg,
  pendingTrackType, pnlVal, saveSession, selectedChip, sess, setAddOpen, setAnimNumber, setBetResults,
  setEditTrackId, setGameResult, setGameSpinning, setLastBets, setLastSpinDelta, setManualBets, setPendingTrackCfg, setPendingTrackType,
  setSelectedChip, setUndoStack, settings, tapNumber, updSess, updateTrackConfig, wheelNums
}) {
    const recentSpins = [...sess.spins].reverse().slice(0,30);
    const hasActiveTracks = nonClosedTracks.some(t=>t.state==="active");
    const tMin = settings.tableMinBet||1;

    const CHIPS = CHIP_DENOMS.filter(c=>c.val>=tMin);

    const totalBetAmt = manualBets.reduce((s,b)=>s+b.amount,0);
    const canSpin = manualBets.length>0 || hasActiveTracks;

    function cancelPendingClear() {
      if(clearTimerRef.current) { clearTimeout(clearTimerRef.current); clearTimerRef.current=null; }
      if(betResults) { setBetResults(null); setManualBets([]); }
    }

    function placeBet(type, target) {
      if(gameSpinning) return;
      if(betResults) cancelPendingClear();
      setManualBets(prev=>[...prev,{id:Date.now()+Math.random(),type:type,target:target,amount:selectedChip}]);
      setUndoStack(prev=>[...prev,1]);
      if(settings.vibration!==false && navigator.vibrate) navigator.vibrate(10);
    }
    function undoBet() {
      if(betResults) return;
      setUndoStack(prev=>{
        if(prev.length===0) return prev;
        const count = prev[prev.length-1];
        setManualBets(mb=>mb.slice(0,-count));
        return prev.slice(0,-1);
      });
    }
    function clearBets() { setManualBets([]); setUndoStack([]); }
    function doubleBets() {
      if(betResults) return;
      setManualBets(prev=>{
        const doubled = prev.map(b=>({...b,id:Date.now()+Math.random()}));
        setUndoStack(us=>[...us,prev.length]);
        return [...prev,...doubled];
      });
    }
    function repeatBets() {
      if(lastBets.length===0) return;
      cancelPendingClear();
      const repeated = lastBets.map(b=>({...b,id:Date.now()+Math.random()}));
      setManualBets(repeated);
      setUndoStack([repeated.length]);
    }

    // Aggregate bets by position for display
    const boardBets = {};
    manualBets.forEach(b=>{
      const key = b.type==="straight"?"s:"+b.target:b.type+(b.target!==undefined?":"+b.target:"");
      boardBets[key] = (boardBets[key]||0) + b.amount;
    });

    function resolveManualBets(winVal) {
      var totalWin=0, totalBet=0, posResults={};
      manualBets.forEach(function(b){
        totalBet+=b.amount;
        var posKey = b.type==="straight"?"s:"+b.target:b.type+(b.target!==undefined?":"+b.target:"");
        var covered = betCoveredNumbers(b.type, b.target);
        var won = covered.indexOf(winVal)>=0;
        if(won){
          totalWin += b.amount * betPayoutMult(b.type);
          posResults[posKey]="won";
        } else {
          if(!posResults[posKey]) posResults[posKey]="lost";
        }
      });
      return {totalWin:totalWin,totalBet:totalBet,profit:totalWin-totalBet,posResults:posResults};
    }

    function doGameSpin() {
      if(gameSpinning||betResults) return;
      setGameSpinning(true);
      setAnimNumber(null);
      if(!sess.sessionStartedAt) updSess(s=>{s.sessionStartedAt=Date.now();});
      const nums = wheelNums;
      const spinBets = [...manualBets];
      var ticks=0;
      const iv = setInterval(()=>{
        ticks++;
        // Only update the animation display number, NOT gameResult
        setAnimNumber(nums[Math.floor(Math.random()*nums.length)]);
        if(ticks>=15){
          clearInterval(iv);
          const val = nums[Math.floor(Math.random()*nums.length)];
          const casinoWager=mergeWagerSummaries(summarizeTrackWagers(sess.tracks,val),summarizeManualWagers(spinBets,val));
          setAnimNumber(null);
          setGameResult(val); // final result - board highlights winning number
          if(hasActiveTracks) tapNumber(val, true, true);
          else { updSess(s=>{s.spins.push(val);const nd={...s.droughts};Object.keys(nd).forEach(k=>nd[k]++);nd[val]=0;s.droughts=nd;}); }
          if(spinBets.length>0){
            var totalWin=0, totalBet=0, posResults={};
            spinBets.forEach(function(b){
              totalBet+=b.amount;
              var posKey=b.type==="straight"?"s:"+b.target:b.type+(b.target!==undefined?":"+b.target:"");
              var covered=betCoveredNumbers(b.type,b.target);
              if(covered.indexOf(val)>=0){totalWin+=b.amount*betPayoutMult(b.type);posResults[posKey]="won";}
              else{if(!posResults[posKey])posResults[posKey]="lost";}
            });
            var profit=totalWin-totalBet;
            updSess(s=>{s.bankrollCurrent=Math.round((s.bankrollCurrent+profit)*100)/100;});
            if(hasActiveTracks) setLastSpinDelta(prev=>(prev||0)+profit);
            else setLastSpinDelta(profit);
            setBetResults(posResults);
            setLastBets([...spinBets]);
            setUndoStack([]);
            clearTimerRef.current = setTimeout(()=>{ setBetResults(null); setManualBets([]); clearTimerRef.current=null; },3000);
          }
          recordGameSpin(val,casinoWager);
          if(settings.vibration!==false&&navigator.vibrate) navigator.vibrate(30);
          setGameSpinning(false);
        }
      },70);
    }

    return (
      <div style={{display:"flex",flexDirection:"column",gap:8,width:"100%"}}>

        {/* Compact spin result + button row */}
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {(()=>{
            const displayNum = gameSpinning ? animNumber : gameResult;
            if(!displayNum) return <div style={{display:"flex",alignItems:"center",justifyContent:"center",width:48,height:48,borderRadius:"50%",background:"#1e2d3d",border:"3px solid #2d4057",fontSize:12,fontWeight:700,color:"#64748b",flexShrink:0}}>--</div>;
            const isZ=displayNum==="0"||displayNum==="00";
            const r=!isZ&&RED.has(+displayNum);
            return <div style={{display:"flex",alignItems:"center",justifyContent:"center",width:48,height:48,borderRadius:"50%",background:isZ?"#166534":r?"#991b1b":"#1e293b",border:"3px solid "+(isZ?"#4ade80":r?"#f87171":"#64748b"),fontSize:20,fontWeight:900,color:"white",animation:gameSpinning?"pulse 0.15s infinite":"none",flexShrink:0}}>{displayNum}</div>;
          })()}
          <button onClick={doGameSpin} disabled={gameSpinning||!!betResults} style={{flex:1,padding:isLandscape?"12px 0":"12px 0",borderRadius:10,border:"none",background:gameSpinning||betResults?"#374151":"linear-gradient(135deg,#16a34a,#059669)",color:"white",fontSize:isLandscape?15:16,fontWeight:900,cursor:gameSpinning||betResults?"not-allowed":"pointer",opacity:gameSpinning?0.7:1}}>
            {gameSpinning?"Spinning...":"🎰 SPIN"}
          </button>
          {lastSpinDelta!==null && <div style={{textAlign:"center",flexShrink:0,minWidth:55}}><div style={{fontSize:7,color:"#64748b",textTransform:"uppercase"}}>Last</div><div style={{fontSize:14,fontWeight:900,color:lastSpinDelta>0?"#4ade80":lastSpinDelta<0?"#f87171":"#94a3b8"}}>{lastSpinDelta>0?"+":lastSpinDelta<0?"-":""}{cur.symbol}{formatNumber(lastSpinDelta)}</div></div>}
        </div>

        {/* Roulette Table */}
        {(()=>{
          const stratBets = {};
          nonClosedTracks.filter(t=>t.state==="active").forEach(t=>{
            if(t.type==="fibonacci") { const dts=t.config.dozenTargets||[],cts=t.config.colTargets||[],evts=t.config.evenTargets||[]; dts.forEach(d=>{stratBets["dozen:"+d]=t.color;});cts.forEach(c=>{stratBets["column:"+c]=t.color;});evts.forEach(key=>{stratBets[key]=t.color;}); }
            if(t.type==="solution") { (t.config.activeBets||[]).forEach(b=>{if(!stratBets["s:"+b.number])stratBets["s:"+b.number]=t.color;}); }
            if(t.type==="custom") { (t.config.positions||[]).forEach(function(p){var pk=p.type==="straight"?"s:"+p.target:p.type+(p.target!==undefined?":"+p.target:"");if(!stratBets[pk])stratBets[pk]=t.color;}); }
          });
          return <RouletteBoard roulette={sess.roulette} winningNumber={gameSpinning?null:gameResult} stratBets={stratBets} spinning={false} onBet={placeBet} boardBets={boardBets} chipColor={(CHIPS.find(c=>c.val===selectedChip)||CHIPS[0]).color} betResults={betResults} stratChips={computeStratChips(nonClosedTracks)} landscape={isLandscape} droughts={sess.droughts} spins={sess.spins} showDroughts={settings.showDroughtCounts!==false} headStart={settings.headStartUnseen===true} counterShows={settings.counterShows}/>;
        })()}

        {/* Chips + controls (compact, matching Live mode) */}
        <div style={{display:"flex",gap:isLandscape?6:3,justifyContent:"center",flexWrap:"wrap"}}>
          {CHIPS.map(c=>(<button key={c.val} onClick={()=>setSelectedChip(c.val)} style={{width:isLandscape?38:34,height:isLandscape?38:34,borderRadius:"50%",border:(isLandscape?"3":"2")+"px solid "+(selectedChip===c.val?"#fbbf24":c.border),background:c.color,color:c.val>=100?"#fff":c.val<=0.5?"#1e293b":"#1e293b",fontSize:isLandscape?(c.val<1?9:11):(c.val<1?7:8),fontWeight:900,cursor:"pointer",boxShadow:selectedChip===c.val?"0 0 8px #fbbf24":"none",display:"flex",alignItems:"center",justifyContent:"center"}}>{c.label}</button>))}
        </div>
        <div style={{display:"flex",gap:isLandscape?6:3}}>
          <button onClick={undoBet} disabled={manualBets.length===0||!!betResults} style={{flex:1,padding:isLandscape?"6px 0":"5px 0",borderRadius:6,border:"1px solid #2d4057",background:"#0f1923",color:manualBets.length>0&&!betResults?"#60a5fa":"#374151",fontSize:isLandscape?11:8,fontWeight:700}}>↩Undo</button>
          <button onClick={clearBets} disabled={manualBets.length===0||!!betResults} style={{flex:1,padding:isLandscape?"6px 0":"5px 0",borderRadius:6,border:"1px solid #2d4057",background:"#0f1923",color:manualBets.length>0&&!betResults?"#f87171":"#374151",fontSize:isLandscape?11:8,fontWeight:700}}>✕Clear</button>
          <button onClick={doubleBets} disabled={manualBets.length===0||!!betResults} style={{flex:1,padding:isLandscape?"6px 0":"5px 0",borderRadius:6,border:"1px solid #2d4057",background:"#0f1923",color:manualBets.length>0&&!betResults?"#fbbf24":"#374151",fontSize:isLandscape?11:8,fontWeight:700}}>2×</button>
          <button onClick={repeatBets} disabled={lastBets.length===0} style={{flex:1,padding:isLandscape?"6px 0":"5px 0",borderRadius:6,border:"1px solid #2d4057",background:"#0f1923",color:lastBets.length>0?"#86efac":"#374151",fontSize:isLandscape?11:8,fontWeight:700}}>♻Rpt</button>
        </div>
        {totalBetAmt>0 && <div style={{textAlign:"center",fontSize:10,fontWeight:800,color:"#fbbf24"}}>Bet: {cur.symbol}{formatNumber(totalBetAmt)}</div>}
        {totalBetAmt>0 && !betResults && (
          <button onClick={()=>{
            const posMap={}; manualBets.forEach(function(b){ const key=b.type==="straight"?"s:"+b.target:b.type+(b.target!==undefined?":"+b.target:""); if(!posMap[key])posMap[key]={type:b.type,target:b.target,baseAmount:0}; posMap[key].baseAmount+=b.amount; });
            const positions=Object.values(posMap); const hasInside=positions.some(function(p){return isInsideBet(p.type);});
            if(!hasInside){ var dts=[],cts=[],evts=[]; positions.forEach(function(p){ if(p.type==="dozen")dts.push(p.target);else if(p.type==="column")cts.push(p.target);else evts.push(p.type); }); var cfg=defaultFibCfg(); cfg.betMode="flat";cfg.dozenTargets=dts;cfg.colTargets=cts;cfg.evenTargets=evts; updSess(s=>{s.tracks.push(newTrack("fibonacci",s.tracks.length,cfg,pickTrackColor("fibonacci",cfg,s.tracks)));}); }
            else{ var cfg={type:"custom",unit:1,roi:15,betMode:"flat",stopLoss:200,positions:positions}; updSess(s=>{ s.tracks.push({id:generateId(),type:"custom",color:pickTrackColor("custom",cfg,s.tracks),state:"active",config:cfg,level:0,pnl:0,bets:[],createdAtSpin:s.spins.length,closedAtSpin:null,wins:0,sequences:0}); }); }
            clearBets(); if(settings.vibration!==false&&navigator.vibrate)navigator.vibrate([20,10,20]);
          }} style={{width:"100%",padding:"8px 0",borderRadius:8,border:"2px dashed #7c3aed",background:"#1e1040",color:"#c4b5fd",fontSize:11,fontWeight:700,cursor:"pointer"}}>🃏 Create Strategy from Bets</button>
        )}
        <div style={{textAlign:"center",fontSize:8,color:"#374151"}}>center=straight · edge=split · corner=corner</div>

        {/* Recent spins ticker */}
        {sess.spins.length>0 && (
          <div style={{display:"flex",gap:4,overflowX:"auto",paddingBottom:2,WebkitOverflowScrolling:"touch",width:"100%",maxWidth:"100%",minWidth:0,boxSizing:"border-box"}}>
            {recentSpins.map((val,i)=>{
              const isZ=val==="0"||val==="00", r=!isZ&&RED.has(+val);
              return(
                <div key={i} style={{flexShrink:0,width:28,height:28,borderRadius:6,background:isZ?"#166534":r?"#7f1d1d":"#0d1117",border:"2px solid "+(i===0?"#ffffff":isZ?"#22c55e":r?"#ef4444":"#374151"),color:isZ?"#bbf7d0":r?"#fecaca":"#f1f5f9",fontSize:10,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>
                  {val}
                </div>
              );
            })}
          </div>
        )}

        {/* Session Profit */}
        {sess.spins.length>0 && (
          <div style={{display:"flex",gap:8,width:"100%"}}>
            <div style={{flex:1,background:pnlVal>=0?"#0a1f0a":"#200505",borderRadius:12,padding:"14px 10px",border:"2px solid "+(pnlVal>=0?"#16a34a":"#991b1b"),textAlign:"center"}}>
              <div style={{fontSize:9,color:"#64748b",textTransform:"uppercase",letterSpacing:1,marginBottom:2}}>Session Profit</div>
              <div style={{fontSize:28,fontWeight:900,color:pnlVal>=0?"#4ade80":"#f87171"}}>{pnlVal>=0?"+":"-"}{cur.symbol}{formatNumber(pnlVal)}</div>
            </div>
            {lastSpinDelta!==null && (
              <div style={{width:100,background:lastSpinDelta>0?"#0a1f0a":lastSpinDelta<0?"#200505":"#0f1923",borderRadius:12,padding:"14px 10px",border:"2px solid "+(lastSpinDelta>0?"#16a34a":lastSpinDelta<0?"#991b1b":"#2d4057"),textAlign:"center"}}>
                <div style={{fontSize:9,color:"#64748b",textTransform:"uppercase",letterSpacing:1,marginBottom:2}}>Last Spin</div>
                <div style={{fontSize:22,fontWeight:900,color:lastSpinDelta>0?"#4ade80":lastSpinDelta<0?"#f87171":"#94a3b8"}}>{lastSpinDelta>0?"+":lastSpinDelta<0?"-":""}{cur.symbol}{formatNumber(lastSpinDelta)}</div>
              </div>
            )}
          </div>
        )}

        {/* Drought panel. Always rendered, with zero values before the first spin, so nothing below it moves. */}
        <DroughtPanel emDroughts={emDroughts} dozD={dozD} colD={colD} dozP={dozP} colP={colP} spins={sess.spins} droughts={sess.droughts} roulette={sess.roulette}/>

        {/* Strategy tracks */}
        <FieldLabel>Strategy Tracks</FieldLabel>
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {nonClosedTracks.map((t) => {
            const tbl=computeTableForTrack(t);
            const isEditing=editTrackId===t.id;
            const dolPnl=t.pnl*(t.config.unit||1);
            const row=tbl[Math.min(t.level,tbl.length-1)];
            return (
              <div key={t.id}>
                <div style={{background:"#0f1923",borderRadius:12,padding:"10px 12px",border:"2px solid "+(isEditing?"#60a5fa":t.color+"66")}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                    <div style={{width:10,height:10,borderRadius:"50%",background:t.color,flexShrink:0}}/>
                    <span style={{fontSize:11,fontWeight:700,color:t.color,flex:1}}>{TRACK_ICONS[t.type]} {t.type==="fibonacci"?"Progression":t.type==="custom"?"Custom Bet":"The Solution"}</span>
                    <span style={{fontSize:9,color:t.state==="active"?"#4ade80":"#fbbf24",fontWeight:700}}>[{t.state.toUpperCase()}]</span>
                    <span style={{fontSize:12,fontWeight:800,color:dolPnl>=0?"#4ade80":"#f87171"}}>{dolPnl>=0?"+":"-"}{cur.symbol}{formatNumber(dolPnl)}</span>
                  </div>
                  <BetTargets type={t.type} config={t.config} style={{marginBottom:6}}/>
                  <div style={{display:"flex",gap:8,marginBottom:6}}>
                    <span style={{fontSize:10,color:"#94a3b8"}}>Lvl <strong style={{color:t.level>=10?"#f87171":t.level>=6?"#fbbf24":"#e2e8f0"}}>{t.level}</strong>/{tbl.length}</span>
                    {row && <span style={{fontSize:10,color:"#60a5fa"}}>Bet: {formatChips(row.totalBet,t.config.unit,currency)}/spin</span>}
                    {t.type==="custom" && <span style={{fontSize:9,color:"#8b5cf6"}}>{(t.config.betMode||"flat")==="flat"?"Flat":"Prog"} · {(t.config.positions||[]).length} pos</span>}
                  </div>
                  <div style={{display:"flex",gap:5}}>
                    <button onClick={()=>parkToggle(t.id)} style={{flex:1,padding:"4px 0",borderRadius:6,border:"1px solid #2d4057",background:t.state==="parked"?"#134e2a":"#1e2d3d",color:t.state==="parked"?"#4ade80":"#94a3b8",fontSize:9,fontWeight:700,cursor:"pointer"}}>{t.state==="parked"?"▶ Resume":"⏸ Park"}</button>
                    <button onClick={()=>setEditTrackId(isEditing?null:t.id)} style={{padding:"4px 8px",borderRadius:6,border:"1px solid "+(isEditing?"#60a5fa":"#1e3a5f"),background:isEditing?"#1e3a5f":"transparent",color:"#60a5fa",fontSize:9,cursor:"pointer"}}>✏️ Edit</button>
                    <button onClick={()=>{if(window.confirm("Close track?"))closeTrack(t.id);}} style={{padding:"4px 8px",borderRadius:6,border:"1px solid #7f1d1d",background:"transparent",color:"#f87171",fontSize:9,cursor:"pointer"}}>×</button>
                  </div>
                </div>
                {isEditing && (
                  <EditTrackCfg track={t} currency={currency} tableMinBet={settings.tableMinBet||1} onSave={cfg=>updateTrackConfig(t.id,cfg)} onCancel={()=>setEditTrackId(null)}/>
                )}
              </div>
            );
          })}
          {!addOpen && (
            <button onClick={()=>setAddOpen(true)} style={{padding:"10px 0",borderRadius:12,border:"2px dashed #2d4057",background:"transparent",color:"#64748b",fontSize:13,cursor:"pointer"}}>+ Add Strategy</button>
          )}
          {addOpen && <AddTrackPanel onAdd={addTrack} onClose={()=>setAddOpen(false)} nextColor={nextColorIdx} type={pendingTrackType} cfg={pendingTrackCfg} onTypeChange={(t)=>{setPendingTrackType(t);setPendingTrackCfg(t==="fibonacci"?defaultFibCfg():defaultSolCfg());}} onCfgChange={setPendingTrackCfg} closedTracks={sess.tracks.filter(t=>t.state==="closed")} currency={currency} tableMinBet={settings.tableMinBet||1}/>}
        </div>

        {/* Session controls */}
        {sess.sessionStartedAt && (
          <div style={{display:"flex",gap:8,marginTop:4}}>
            <button onClick={saveSession} style={{flex:1,padding:11,borderRadius:10,border:"none",background:"#16a34a",color:"white",fontSize:13,fontWeight:700,cursor:"pointer"}}>Save</button>
            <button onClick={()=>{if(window.confirm("End session and save?"))endSession();}} style={{flex:1,padding:11,borderRadius:10,border:"1px solid #7f1d1d",background:"#200505",color:"#f87171",fontSize:13,fontWeight:700,cursor:"pointer"}}>End Session</button>
          </div>
        )}
      </div>
    );
}
