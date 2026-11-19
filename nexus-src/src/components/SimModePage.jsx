// -- Simulation Mode UI --
function NotificationEnablePage() {
  const supported='Notification' in window;
  const [permission,setPermission]=useState(supported?Notification.permission:'unsupported');
  async function enable(){
    if(!supported)return;
    try{setPermission(await Notification.requestPermission());}
    catch(e){setPermission('error');}
  }
  function returnToRoulette(){window.location.replace(window.location.origin+window.location.pathname);}
  const message=permission==='granted'?'Completion notifications are enabled.':permission==='denied'?'Notifications are blocked in this browser. Change the site permission to enable them.':permission==='unsupported'?'This browser does not support notifications.':permission==='error'?'The browser could not change the notification permission.':'The browser requires this second, top-level click before it can ask.';
  return (
    <div style={{minHeight:'100vh',background:'#080d13',color:'#e2e8f0',display:'flex',alignItems:'center',justifyContent:'center',padding:20,boxSizing:'border-box'}}>
      <div style={{width:'100%',maxWidth:460,background:'#111c27',border:'1px solid #2d4057',borderRadius:16,padding:22,textAlign:'center'}}>
        <div style={{fontSize:28,marginBottom:8}}>🔔</div>
        <h1 style={{fontSize:20,margin:'0 0 8px'}}>Roulette completion notifications</h1>
        <p role="status" style={{fontSize:13,color:'#94a3b8',lineHeight:1.5,margin:'0 0 16px'}}>{message}</p>
        {supported&&permission!=='granted'&&<button className="nf-btn nf-btn--primary nf-btn--lg nf-btn--block" onClick={enable}>Enable notifications</button>}
        <button className="nf-btn nf-btn--ghost nf-btn--lg nf-btn--block" onClick={returnToRoulette} style={{marginTop:8}}>Return to Roulette</button>
      </div>
    </div>
  );
}

function StatContextBar({simResults, simCfg, sess, cur, pnlVal}) {
  // Match live tracks to sim strategies by type+roi+stopLoss
  const liveTracks = sess.tracks.filter(t=>t.state!=="closed");
  if(!liveTracks.length || !simResults) return null;

  const bars = liveTracks.map(t=>{
    // Find best matching sim strategy
    const match = simCfg.strategies.reduce((best,strat,i)=>{
      if(strat.type!==t.type) return best;
      const score = Math.abs(strat.config.roi-t.config.roi)+Math.abs(strat.config.stopLoss-t.config.stopLoss);
      return(!best||score<best.score)?{idx:i,score}:best;
    },null);
    if(!match) return null;

    const r = simResults[match.idx];
    if(!r||!r.sessions.length) return null;
    const stats = computeSimStats(r);
    if(!stats) return null;

    const livePnl = t.pnl*(t.config.unit||1);
    // Compare live P&L per sequence vs sim expected
    const sequences = t.bets.filter(b=>b.outcome==="win"||b.type==="abandon").length||1;
    const liveRate = livePnl/sequences;
    const simRate = stats.avgPnlPerSession/(simCfg.spinsPerSession/37||10);

    // Percentile: where does current livePnl fall in sim distribution?
    const pnls = r.sessions.map(s=>s.pnl).sort((a,b)=>a-b);
    const pctRank = Math.round(pnls.filter(p=>p<=livePnl).length/pnls.length*100);

    const status = pctRank>=75?"ahead":pctRank>=40?"on track":"behind";
    const statusColor = status==="ahead"?"#4ade80":status==="on track"?"#fbbf24":"#f87171";
    const statusIcon = status==="ahead"?"📈":status==="on track"?"➡️":"📉";

    return {t, status, statusColor, statusIcon, pctRank, stats, livePnl};
  }).filter(Boolean);

  if(!bars.length) return null;

  return(
    <div style={{background:"#0c1520",border:"1px solid #1e2d3d",borderRadius:10,padding:"8px 12px",marginBottom:8,display:"flex",flexDirection:"column",gap:4}}>
      <div style={{fontSize:9,color:"#475569",textTransform:"uppercase",letterSpacing:1,marginBottom:2}}>vs Simulation Benchmark</div>
      {bars.map(({t,status,statusColor,statusIcon,pctRank,stats,livePnl},i)=>(
        <div key={t.id} style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{width:8,height:8,borderRadius:"50%",background:t.color,flexShrink:0}}/>
          <div style={{fontSize:10,color:t.color,flex:1}}>{t.type==="fibonacci"?"Prog":"Sol"}</div>
          <div style={{fontSize:10,color:statusColor,fontWeight:700}}>{statusIcon} {status==="ahead"?"Ahead":"on track"===status?"On Track":"Behind"}</div>
          <div style={{fontSize:10,color:"#64748b"}}>P{pctRank}</div>
          <div style={{fontSize:10,color:statusColor,fontWeight:700}}>{livePnl>=0?"+":""}{cur.symbol}{livePnl.toFixed(2)}</div>
          <div style={{fontSize:9,color:"#374151"}}>
            exp {stats.p50>=0?"+":""}{cur.symbol}{stats.p50.toFixed(0)}
          </div>
        </div>
      ))}
    </div>
  );
}

// -- Experiment Comparison Panel (Results view, Repeat Experiment) --
// One row per experiment (identical parameters), with aggregate stats across all
// of them: overall P&L per experiment, or sessions survived in bankroll mode.
function ExperimentPanel({experiments, bankrollMode, sessionsPerExperiment, cur}) {
  if(!experiments||experiments.length<2) return null;
  const pnls=experiments.map(e=>e.pnl);
  const sortedPnls=[...pnls].sort((a,b)=>a-b);
  const median=sortedPnls[Math.floor(sortedPnls.length/2)];
  const avgPnl=pnls.reduce((a,b)=>a+b,0)/pnls.length;
  const profitable=experiments.filter(e=>e.pnl>0).length;
  const busts=experiments.filter(e=>e.busted).length;
  const survivals=experiments.map(e=>e.sessions);
  const avgSurvival=survivals.reduce((a,b)=>a+b,0)/survivals.length;
  const sortedSurv=[...survivals].sort((a,b)=>a-b);
  const maxAbsPnl=Math.max(...pnls.map(Math.abs),1);
  const maxSurv=Math.max(...survivals,1);

  const tiles=bankrollMode?[
    ["Experiments",experiments.length,"#c4b5fd"],
    ["Bust Rate",busts+" of "+experiments.length+" ("+(busts/experiments.length*100).toFixed(0)+"%)",busts>0?"#f87171":"#4ade80"],
    ["Avg Sessions Lasted",avgSurvival.toFixed(1),"#fbbf24"],
    ["Median Sessions",sortedSurv[Math.floor(sortedSurv.length/2)],"#fbbf24"],
    ["Shortest / Longest",sortedSurv[0]+" / "+sortedSurv[sortedSurv.length-1],"#94a3b8"],
    ["Avg Final Bankroll",cur.symbol+(experiments.reduce((a,e)=>a+(e.bankrollEnd||0),0)/experiments.length).toFixed(2),"#4ade80"],
  ]:[
    ["Experiments",experiments.length,"#c4b5fd"],
    ["Profitable",profitable+" of "+experiments.length+" ("+(profitable/experiments.length*100).toFixed(0)+"%)",profitable>0?"#4ade80":"#f87171"],
    ["Avg P&L / Experiment",(avgPnl>=0?"+":"-")+cur.symbol+Math.abs(avgPnl).toFixed(2),avgPnl>=0?"#4ade80":"#f87171"],
    ["Median P&L",(median>=0?"+":"-")+cur.symbol+Math.abs(median).toFixed(2),median>=0?"#86efac":"#f97316"],
    ["Best / Worst",(sortedPnls[sortedPnls.length-1]>=0?"+":"-")+cur.symbol+Math.abs(sortedPnls[sortedPnls.length-1]).toFixed(0)+" / "+(sortedPnls[0]>=0?"+":"-")+cur.symbol+Math.abs(sortedPnls[0]).toFixed(0),"#94a3b8"],
    ["Avg Stop-Loss Hits",(experiments.reduce((a,e)=>a+(e.stopLossHits||0),0)/experiments.length).toFixed(1),"#fbbf24"],
  ];

  return (
    <div style={{marginBottom:12,padding:"10px 12px",borderRadius:10,border:"1px solid #7c3aed",background:"#12081f"}}>
      <div style={{fontSize:10,color:"#a78bfa",textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>🔁 Experiment Results — {experiments.length} identical runs</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
        {tiles.map(([l,v,c])=>(
          <div key={l} style={{background:"#0f1923",borderRadius:8,padding:"7px 8px",border:"1px solid #2d4057"}}>
            <div style={{fontSize:8,color:"#64748b",marginBottom:2}}>{l}</div>
            <div style={{fontSize:13,fontWeight:700,color:c}}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{fontSize:9,color:"#64748b",marginBottom:4}}>{bankrollMode?"Sessions survived per experiment":"Overall P&L per experiment"}</div>
      <div style={{display:"flex",flexDirection:"column",gap:2,maxHeight:"36vh",overflowY:"auto"}}>
        {experiments.map((e,i)=>{
          const value=bankrollMode?e.sessions:e.pnl;
          const width=bankrollMode?Math.max(2,value/maxSurv*100):Math.max(2,Math.abs(value)/maxAbsPnl*100);
          const good=bankrollMode?!e.busted:value>=0;
          return (
            <div key={i} style={{display:"flex",alignItems:"center",gap:6}}>
              <span style={{fontSize:9,color:"#475569",width:26,textAlign:"right",flexShrink:0}}>#{i+1}</span>
              <div style={{flex:1,height:11,background:"#1e2d3d",borderRadius:4,overflow:"hidden"}}>
                <div style={{height:"100%",borderRadius:4,background:good?"#22c55e":"#ef4444",width:width+"%"}}/>
              </div>
              <span style={{fontSize:9,fontWeight:700,color:good?"#4ade80":"#f87171",width:86,flexShrink:0,textAlign:"right"}}>
                {bankrollMode
                  ? e.sessions+" sess "+(e.busted?"💀":"✅")+(e.busted?"":" "+cur.symbol+(e.bankrollEnd||0).toFixed(0))
                  : (value>=0?"+":"-")+cur.symbol+Math.abs(value).toFixed(2)}
              </span>
            </div>
          );
        })}
      </div>
      {sessionsPerExperiment&&<div style={{fontSize:9,color:"#475569",marginTop:6}}>Detailed stats below reflect the last experiment; the summary above covers all {experiments.length}.</div>}
    </div>
  );
}

// -- Per-Session Explorer (Results view) --
// Filterable, sortable drill-down into every simulated session.
function SessionExplorer({sessions, cur}) {
  const [filter, setFilter] = useState("all");   // all | won | lost | stoploss
  const [sort, setSort] = useState("order");     // order | best | worst
  const [shown, setShown] = useState(50);

  const indexed = sessions.map((s,i)=>({...s, idx:i+1}));
  const filtered = indexed.filter(s=>{
    if(filter==="won") return s.pnl>0;
    if(filter==="lost") return s.pnl<0;
    if(filter==="stoploss") return (s.stopLossHits||0)>0;
    if(filter==="satout") return (s.wins||0)===0&&(s.losses||0)===0;
    return true;
  });
  const sorted = sort==="order" ? filtered
    : [...filtered].sort((a,b)=>sort==="best" ? b.pnl-a.pnl : a.pnl-b.pnl);
  const visible = sorted.slice(0, shown);

  const filterChips = [
    ["all","All ("+sessions.length+")"],
    ["won","Won ("+indexed.filter(s=>s.pnl>0).length+")"],
    ["lost","Lost ("+indexed.filter(s=>s.pnl<0).length+")"],
    ["stoploss","Hit Stop ("+indexed.filter(s=>(s.stopLossHits||0)>0).length+")"],
    ["satout","Sat Out ("+indexed.filter(s=>(s.wins||0)===0&&(s.losses||0)===0).length+")"],
  ];
  const sortChips = [["order","# Order"],["best","Best P&L"],["worst","Worst P&L"]];

  function chipStyle(selected, color){
    return {padding:"5px 9px",borderRadius:8,border:"1px solid "+(selected?color:"#2d4057"),background:selected?"#0f1923":"transparent",color:selected?color:"#64748b",fontSize:10,fontWeight:700,cursor:"pointer"};
  }

  return (
    <div style={{marginTop:12,borderTop:"1px solid #1e2d3d",paddingTop:10}}>
      <div style={{fontSize:10,color:"#64748b",textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Session Explorer</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:4}}>
        {filterChips.map(([key,label])=>(
          <button key={key} onClick={()=>{setFilter(key);setShown(50);}} style={chipStyle(filter===key,"#a78bfa")}>{label}</button>
        ))}
      </div>
      <div style={{display:"flex",gap:4,marginBottom:6}}>
        {sortChips.map(([key,label])=>(
          <button key={key} onClick={()=>setSort(key)} style={chipStyle(sort===key,"#60a5fa")}>{label}</button>
        ))}
      </div>
      {visible.length===0 && <div style={{fontSize:11,color:"#475569",textAlign:"center",padding:"10px 0"}}>No sessions match this filter.</div>}
      <div style={{display:"flex",flexDirection:"column",gap:2,maxHeight:"46vh",overflowY:"auto"}}>
        {visible.map(s=>{
          const completedSequences=(s.wins||0)+(s.seqLosses||0);
          const rate=completedSequences>0?((s.wins||0)/completedSequences*100).toFixed(0)+"%":"—";
          return (
            <div key={s.idx} style={{display:"flex",alignItems:"center",gap:6,background:"#0f1923",border:"1px solid #1e2d3d",borderRadius:7,padding:"5px 8px"}}>
              <span style={{fontSize:9,color:"#475569",width:34,flexShrink:0}}>#{s.idx}</span>
              <span style={{fontSize:11,fontWeight:800,color:s.pnl>=0?"#4ade80":"#f87171",width:64,flexShrink:0}}>{s.pnl>=0?"+":"-"}{cur.symbol}{Math.abs(s.pnl).toFixed(2)}</span>
              <span style={{fontSize:9,color:"#94a3b8",flex:1}}>{s.wins||0}W/{s.seqLosses||0}L seq · {rate}</span>
              <span style={{fontSize:9,color:(s.stopLossHits||0)>0?"#fbbf24":"#374151",flexShrink:0}}>SL {s.stopLossHits||0}</span>
              <span style={{fontSize:9,color:"#64748b",flexShrink:0}}>
                ⤓{s.trough!==undefined?(s.trough<0?"-":"")+cur.symbol+Math.abs(s.trough||0).toFixed(0):"—"} ⤒{s.peak!==undefined?"+"+cur.symbol+Math.abs(s.peak||0).toFixed(0):"—"}
              </span>
              {s.bankrollAfter!==undefined && (
                <span style={{fontSize:9,fontWeight:700,color:s.bankrollAfter>0?"#4ade80":"#f87171",flexShrink:0}}>💰{cur.symbol}{s.bankrollAfter.toFixed(0)}</span>
              )}
            </div>
          );
        })}
      </div>
      {sorted.length>visible.length && (
        <button onClick={()=>setShown(n=>n+100)} style={{width:"100%",marginTop:6,padding:"8px 0",borderRadius:8,border:"1px solid #2d4057",background:"transparent",color:"#64748b",fontSize:11,cursor:"pointer"}}>
          Show more ({sorted.length-visible.length} remaining)
        </button>
      )}
    </div>
  );
}

// -- Simulation Mode Page --
function SimModePage({simCfg, setSimCfg, simRunning, setSimRunning, simProgress, setSimProgress, simResults, setSimResults, simDone, setSimDone, simStopRef, currency, cur}) {
  const [view, setView] = useState("setup"); // "setup" | "running" | "results"
  const [editStratIdx, setEditStratIdx] = useState(null);
  const [startError, setStartError] = useState(null);

  function addStrategy(type) {
    const cfg = type==="fibonacci" ? defaultFibCfg() : defaultSolCfg();
    setStartError(null);
    setSimCfg(c=>({...c, strategies:[...c.strategies, {type, config:cfg, label:(type==="fibonacci"?"Progression Bet":"The Solution")+" #"+(c.strategies.length+1)}]}));
  }

  function removeStrategy(i) {
    setStartError(null);
    setSimCfg(c=>({...c, strategies:c.strategies.filter((_,idx)=>idx!==i)}));
  }

  function startSim() {
    if(!simCfg.strategies.length){setStartError("Add at least one strategy first.");return;}
    // A Progression Bet with no targets loses every spin by construction — the live
    // Add Track panel blocks this, so the Experimental section must block it too.
    const untargeted=simCfg.strategies.filter(s=>s.type==="fibonacci"&&!s.config.autoChase
      &&!(s.config.evenTargets||[]).length&&!(s.config.dozenTargets||[]).length&&!(s.config.colTargets||[]).length);
    if(untargeted.length){setStartError("Pick at least one target (✏️) for: "+untargeted.map(s=>s.label).join(", "));return;}
    setStartError(null);
    simStopRef.current=false;
    setSimRunning(true);setSimDone(false);setSimResults(null);setSimProgress(0);setView("running");

    // The math lives in simulation.js (simRunSession); this only chunks sessions
    // across setTimeout ticks so the UI stays responsive. With Repeat Experiment,
    // the entire configured run repeats with identical parameters; per-experiment
    // summaries accumulate in `history` and the detailed stats show the last run.
    const wheelNums=getWheelNumbers(simCfg.roulette);
    const tables=simCfg.strategies.map(s=>computeTableForTrack({type:s.type,config:s.config}));
    const totalExperiments=Math.max(1,simCfg.repeatExperiments||1);
    const history=simCfg.strategies.map(()=>[]);

    let results, active, sessionIdx, experimentIdx=0;
    function initExperiment(){
      results=simNewResults(simCfg.strategies.length);
      results.forEach(r=>{r.roulette=simCfg.roulette;}); // pin the wheel the run used (drives house-edge math)
      // Bankroll mode: each strategy plays from its own copy of the buy-in; a
      // busted strategy leaves the game while the rest keep playing.
      active=simCfg.strategies.map(()=>true);
      sessionIdx=0;
      if(simCfg.bankrollMode){
        results.forEach(r=>{r.bankrollStart=simCfg.bankrollStart||500;r.bankrollCurrent=r.bankrollStart;});
      }
    }
    function finishExperiment(bankSummary){
      // Finalize streaks; a "sequence" is a resolved win or a completed losing
      // progression (stop-loss), never a single intermediate losing spin.
      // A run stopped mid-experiment still finalizes for display, but its partial
      // summary is NOT banked into the experiment history.
      results.forEach((r,si)=>{
        flushStreak(r);
        r.totalSequences=r.totalWins+r.totalSeqLosses;
        if(bankSummary) history[si].push({
          pnl:Math.round(r.totalPnl*100)/100,
          sessions:r.sessions.length,
          busted:!!r.busted,
          bustedAtSession:r.bustedAtSession,
          bankrollEnd:r.bankrollCurrent,
          satOut:r.satOutSessions,
          stopLossHits:r.stopLossHits,
        });
      });
    }
    initExperiment();

    function runChunk(){
      const CHUNK=10;
      for(let ci=0;ci<CHUNK&&sessionIdx<simCfg.sessions;ci++){
        if(simStopRef.current) break;
        if(simCfg.bankrollMode&&active.every(a=>!a)) break; // everyone's busted
        const outcomes=simRunSession(simCfg.strategies,tables,wheelNums,simCfg.spinsPerSession,results,()=>simStopRef.current,active);
        if(!outcomes) break; // stopped mid-session — discard the partial session
        sessionIdx++;
        outcomes.forEach((o,si)=>{
          if(!active[si]) return;
          const sessionRecord={pnl:o.pnl,wins:o.wins,losses:o.losses,seqLosses:o.seqLosses,stopLossHits:o.stopLossHits,staked:o.staked,trough:o.trough,peak:o.peak};
          if(simCfg.bankrollMode){
            // The trough is the deepest the running P&L went mid-session: if the
            // buy-in couldn't cover it, the player ran out of money DURING this
            // session — it counts as played, and the strategy is out of the game.
            if(results[si].bankrollCurrent+o.trough<=0){
              results[si].busted=true;
              results[si].bustedAtSession=results[si].sessions.length+1;
              results[si].bankrollCurrent=0;
              active[si]=false;
              sessionRecord.bankrollAfter=0;
            } else {
              results[si].bankrollCurrent=Math.round((results[si].bankrollCurrent+o.pnl)*100)/100;
              sessionRecord.bankrollAfter=results[si].bankrollCurrent;
            }
          }
          if((o.wins+o.losses)===0) results[si].satOutSessions++;
          results[si].sessions.push(sessionRecord);
          results[si].totalPnl+=o.pnl;
          results[si].totalWins+=o.wins;
          results[si].totalLosses+=o.losses;
          results[si].totalSeqLosses+=o.seqLosses;
          results[si].stopLossHits+=o.stopLossHits;
          results[si].totalStaked=Math.round(((results[si].totalStaked||0)+o.staked)*100)/100;
          results[si].pnlHistory.push(results[si].totalPnl);
        });
      }

      const experimentOver = sessionIdx>=simCfg.sessions || (simCfg.bankrollMode&&active.every(a=>!a));
      setSimProgress(experimentIdx*simCfg.sessions+sessionIdx);
      setSimResults(results.map((r,si)=>({...r, experimentNum:experimentIdx+1, experimentsPlanned:totalExperiments, experimentHistory:[...history[si]]})));

      if(!experimentOver&&!simStopRef.current){
        setTimeout(runChunk,0);
      } else if(experimentOver&&!simStopRef.current&&experimentIdx+1<totalExperiments){
        // This experiment is done — bank its summary and start the next with identical parameters
        finishExperiment(true);
        experimentIdx++;
        initExperiment();
        setTimeout(runChunk,0);
      } else {
        const completed=experimentOver&&experimentIdx+1>=totalExperiments;
        finishExperiment(experimentOver);
        setSimResults(results.map((r,si)=>({...r, experimentNum:experimentIdx+1, experimentsPlanned:totalExperiments, experimentHistory:[...history[si]]})));
        setSimRunning(false);setSimDone(true);
        if(completed&&'Notification' in window&&Notification.permission==='granted'){
          const runsLabel=totalExperiments>1?`${totalExperiments} experiments × ${simCfg.sessions} sessions done.`:`${simCfg.sessions} sessions done.`;
          new Notification('Nexus Roulette Simulation Complete!',{body:runsLabel+' Tap to see results.',icon:'./icon.svg'});
        }
      }
    }
    setTimeout(runChunk,50);
  }

  function stopSim(){simStopRef.current=true;setSimRunning(false);}
  function requestNotifPermission(){
    if(window.parent!==window){
      // Browsers refuse permission prompts from cross-origin frames. Open this same committed app
      // at its own origin so the user's gesture reaches a surface that is allowed to ask.
      window.open(window.location.origin+'/?enableNotifications=1','_blank','noopener,noreferrer');
      return;
    }
    if('Notification' in window)Notification.requestPermission();
  }

  // -- Setup View --
  if(view==="setup") return (
    <div style={{display:"flex",flexDirection:"column",gap:12,width:"100%"}}>
      <Card>
        <div style={{fontSize:14,fontWeight:800,color:"#a78bfa",marginBottom:10}}>🔬 Simulation Setup</div>

        {/* Wheel + sessions */}
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <div>
            <FieldLabel>Wheel Type</FieldLabel>
            <div style={{display:"flex",gap:8}}>
              {[["european","🇪🇺 European"],["american","🇺🇸 American"]].map(([v,l])=>{
                const sel=simCfg.roulette===v;
                return <button key={v} onClick={()=>setSimCfg(c=>({...c,roulette:v}))} style={{flex:1,padding:"9px 0",borderRadius:10,border:"2px solid "+(sel?"#a78bfa":"#2d4057"),background:sel?"#2e1065":"#0f1923",color:sel?"#c4b5fd":"#64748b",fontSize:12,fontWeight:700,cursor:"pointer"}}>{l}</button>;
              })}
            </div>
          </div>

          <div>
            <FieldLabel>Sessions</FieldLabel>
            <div style={{display:"flex",alignItems:"center",background:"#0f1923",borderRadius:10,border:"1px solid #2d4057",overflow:"hidden"}}>
              <button onClick={()=>setSimCfg(c=>({...c,sessions:Math.max(10,c.sessions-(c.sessions<=100?10:c.sessions<=1000?100:1000))}))} style={{padding:"8px 14px",background:"transparent",border:"none",color:"#a78bfa",fontSize:18,fontWeight:700,cursor:"pointer"}}>-</button>
              <div style={{flex:1,textAlign:"center",fontSize:16,fontWeight:800,color:"#c4b5fd"}}>{simCfg.sessions.toLocaleString()}</div>
              <button onClick={()=>setSimCfg(c=>({...c,sessions:c.sessions+(c.sessions<100?10:c.sessions<1000?100:1000)}))} style={{padding:"8px 14px",background:"transparent",border:"none",color:"#a78bfa",fontSize:18,fontWeight:700,cursor:"pointer"}}>+</button>
            </div>
            <div style={{display:"flex",gap:5,marginTop:5}}>
              {[100,500,1000,5000,10000].map(v=>(
                <button key={v} onClick={()=>setSimCfg(c=>({...c,sessions:v}))} style={{flex:1,padding:"5px 0",borderRadius:7,border:"1px solid "+(simCfg.sessions===v?"#a78bfa":"#2d4057"),background:simCfg.sessions===v?"#2e1065":"#0f1923",color:simCfg.sessions===v?"#c4b5fd":"#64748b",fontSize:10,fontWeight:700,cursor:"pointer"}}>{v>=1000?v/1000+"K":v}</button>
              ))}
            </div>
          </div>

          <div>
            <FieldLabel>Spins per Session</FieldLabel>
            <div style={{display:"flex",alignItems:"center",background:"#0f1923",borderRadius:10,border:"1px solid #2d4057",overflow:"hidden"}}>
              <button onClick={()=>setSimCfg(c=>({...c,spinsPerSession:Math.max(100,c.spinsPerSession-100)}))} style={{padding:"8px 14px",background:"transparent",border:"none",color:"#a78bfa",fontSize:18,fontWeight:700,cursor:"pointer"}}>-</button>
              <div style={{flex:1,textAlign:"center",fontSize:16,fontWeight:800,color:"#c4b5fd"}}>{simCfg.spinsPerSession.toLocaleString()}</div>
              <button onClick={()=>setSimCfg(c=>({...c,spinsPerSession:c.spinsPerSession+100}))} style={{padding:"8px 14px",background:"transparent",border:"none",color:"#a78bfa",fontSize:18,fontWeight:700,cursor:"pointer"}}>+</button>
            </div>
            <div style={{display:"flex",gap:5,marginTop:5}}>
              {[500,1000,5000,10000,50000].map(v=>(
                <button key={v} onClick={()=>setSimCfg(c=>({...c,spinsPerSession:v}))} style={{flex:1,padding:"5px 0",borderRadius:7,border:"1px solid "+(simCfg.spinsPerSession===v?"#a78bfa":"#2d4057"),background:simCfg.spinsPerSession===v?"#2e1065":"#0f1923",color:simCfg.spinsPerSession===v?"#c4b5fd":"#64748b",fontSize:10,fontWeight:700,cursor:"pointer"}}>{v>=1000?v/1000+"K":v}</button>
              ))}
            </div>
          </div>

          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 10px",borderRadius:8,border:"1px solid "+(simCfg.bankrollMode?"#4ade80":"#2d4057"),background:simCfg.bankrollMode?"#07200d":"#0f1923"}}>
            <div>
              <div style={{fontSize:11,fontWeight:700,color:simCfg.bankrollMode?"#4ade80":"#94a3b8"}}>💰 Bankroll Mode</div>
              <div style={{fontSize:9,color:"#475569"}}>P&L carries over between sessions from one buy-in; if it hits zero, the run records how many sessions you lasted</div>
            </div>
            <button onClick={()=>setSimCfg(c=>({...c,bankrollMode:!c.bankrollMode}))} style={{padding:"4px 12px",borderRadius:7,border:"none",background:simCfg.bankrollMode?"#15803d":"#374151",color:"white",fontSize:10,fontWeight:700,cursor:"pointer"}}>{simCfg.bankrollMode?"ON":"OFF"}</button>
          </div>
          {simCfg.bankrollMode && (
            <MoneyInput value={simCfg.bankrollStart||500} onChange={v=>setSimCfg(c=>({...c,bankrollStart:v}))} currCode={currency} label="Starting Bankroll (buy-in — separate from any stop loss)"/>
          )}

          <div>
            <FieldLabel>🔁 Repeat Experiment</FieldLabel>
            <div style={{fontSize:9,color:"#475569",marginBottom:4}}>Run this exact setup multiple times and compare the outcomes of every experiment side by side</div>
            <div style={{display:"flex",alignItems:"center",background:"#0f1923",borderRadius:10,border:"1px solid #2d4057",overflow:"hidden"}}>
              <button onClick={()=>setSimCfg(c=>({...c,repeatExperiments:Math.max(1,(c.repeatExperiments||1)-1)}))} style={{padding:"8px 14px",background:"transparent",border:"none",color:"#a78bfa",fontSize:18,fontWeight:700,cursor:"pointer"}}>-</button>
              <input
                type="number"
                inputMode="numeric"
                min="1"
                value={simCfg.repeatExperiments||1}
                onChange={e=>{const n=parseInt(e.target.value,10);setSimCfg(c=>({...c,repeatExperiments:isNaN(n)?1:Math.max(1,Math.min(500,n))}));}}
                style={{flex:1,textAlign:"center",fontSize:16,fontWeight:800,color:"#c4b5fd",background:"transparent",border:"none",outline:"none",WebkitAppearance:"none"}}
              />
              <button onClick={()=>setSimCfg(c=>({...c,repeatExperiments:Math.min(500,(c.repeatExperiments||1)+1)}))} style={{padding:"8px 14px",background:"transparent",border:"none",color:"#a78bfa",fontSize:18,fontWeight:700,cursor:"pointer"}}>+</button>
            </div>
            <div style={{display:"flex",gap:5,marginTop:5}}>
              {[1,5,10,25,50].map(v=>(
                <button key={v} onClick={()=>setSimCfg(c=>({...c,repeatExperiments:v}))} style={{flex:1,padding:"5px 0",borderRadius:7,border:"1px solid "+((simCfg.repeatExperiments||1)===v?"#a78bfa":"#2d4057"),background:(simCfg.repeatExperiments||1)===v?"#2e1065":"#0f1923",color:(simCfg.repeatExperiments||1)===v?"#c4b5fd":"#64748b",fontSize:10,fontWeight:700,cursor:"pointer"}}>{v}×</button>
              ))}
            </div>
          </div>

        </div>
      </Card>

      {/* Strategies */}
      <Card>
        <FieldLabel>{"Strategies to Benchmark ("+simCfg.strategies.length+")"}</FieldLabel>
        {simCfg.strategies.map((strat,i)=>(
          <div key={i} style={{background:"#0f1923",borderRadius:10,padding:"10px 12px",border:"1px solid #2d4057",marginBottom:8}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
              <div style={{fontSize:12,fontWeight:700,color:TRACK_COLORS[i%TRACK_COLORS.length]}}>{strat.label}</div>
              <div style={{display:"flex",gap:5}}>
                <button onClick={()=>setEditStratIdx(editStratIdx===i?null:i)} style={{padding:"3px 8px",borderRadius:6,border:"1px solid #1e3a5f",background:"transparent",color:"#60a5fa",fontSize:9,cursor:"pointer"}}>✏️</button>
                <button onClick={()=>removeStrategy(i)} style={{padding:"3px 8px",borderRadius:6,border:"1px solid #7f1d1d",background:"transparent",color:"#f87171",fontSize:9,cursor:"pointer"}}>×</button>
              </div>
            </div>
            <BetTargets type={strat.type} config={strat.config} compact style={{marginBottom:4}}/>
            <div style={{fontSize:10,color:"#64748b"}}>
              {strat.type==="fibonacci"
                ? `${strat.config.betMode||"progression"}`
                : `Solution · entry ${strat.config.entryThreshold}`
              } · ROI {strat.config.roi}% · stop {cur.symbol}{strat.config.stopLoss}
            </div>
            {editStratIdx===i && (
              <SimStratEditor strat={strat} idx={i} simCfg={simCfg} setSimCfg={setSimCfg} cur={cur} onClose={()=>setEditStratIdx(null)}/>
            )}
          </div>
        ))}
        <div style={{display:"flex",gap:8,marginTop:4}}>
          <button onClick={()=>addStrategy("fibonacci")} style={{flex:1,padding:"9px 0",borderRadius:10,border:"2px dashed #2d4057",background:"transparent",color:"#64748b",fontSize:12,cursor:"pointer"}}>+ Progression Bet</button>
          <button onClick={()=>addStrategy("solution")} style={{flex:1,padding:"9px 0",borderRadius:10,border:"2px dashed #2d4057",background:"transparent",color:"#64748b",fontSize:12,cursor:"pointer"}}>+ The Solution</button>
        </div>
      </Card>

      <div style={{fontSize:10,color:"#475569",textAlign:"center"}}>
        Total spins: ~{(simCfg.sessions*simCfg.spinsPerSession).toLocaleString()}
      </div>

      <button onClick={startSim} style={{width:"100%",padding:"16px 0",borderRadius:14,border:"none",background:"#7c3aed",color:"white",fontSize:16,fontWeight:900,cursor:"pointer",letterSpacing:1}}>
        ▶ Start Simulation
      </button>
      {startError && (
        <div style={{padding:"10px 14px",borderRadius:10,border:"1px solid #7f1d1d",background:"#200505",color:"#f87171",fontSize:12,fontWeight:700,textAlign:"center"}}>
          ⚠ {startError}
        </div>
      )}
      <button onClick={requestNotifPermission} style={{width:"100%",padding:"10px 0",borderRadius:10,border:"1px solid #2d4057",background:"transparent",color:"#64748b",fontSize:11,cursor:"pointer"}}>
        🔔 {window.parent!==window?"Open app to enable completion notifications":"Enable completion notification"}
      </button>
      {simDone && <button onClick={()=>setView("results")} style={{width:"100%",padding:"12px 0",borderRadius:12,border:"none",background:"#134e2a",color:"#4ade80",fontSize:14,fontWeight:700,cursor:"pointer"}}>📊 View Last Results</button>}
    </div>
  );

  // -- Running View --
  if(view==="running") return (
    <div style={{display:"flex",flexDirection:"column",gap:12,width:"100%"}}>
      <Card>
        <div style={{fontSize:14,fontWeight:800,color:"#a78bfa",marginBottom:10}}>🔬 Simulation Running...</div>
        {(()=>{
          const totalTarget=simCfg.sessions*(simCfg.repeatExperiments||1);
          const expNum=(simResults&&simResults[0]&&simResults[0].experimentNum)||1;
          return (
            <div style={{marginBottom:12}}>
              {(simCfg.repeatExperiments||1)>1 && (
                <div style={{fontSize:11,color:"#fbbf24",fontWeight:700,marginBottom:4}}>🔁 Experiment {expNum} of {simCfg.repeatExperiments}</div>
              )}
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                <span style={{fontSize:11,color:"#64748b"}}>Sessions (all experiments)</span>
                <span style={{fontSize:11,color:"#c4b5fd",fontWeight:700}}>{simProgress.toLocaleString()} / {totalTarget.toLocaleString()}</span>
              </div>
              <div style={{height:8,borderRadius:4,background:"#1e2d3d",overflow:"hidden"}}>
                <div style={{height:"100%",borderRadius:4,background:"#7c3aed",width:`${simProgress/totalTarget*100}%`,transition:"width 0.3s"}}/>
              </div>
            </div>
          );
        })()}

        {/* Live P&L per strategy */}
        {simResults && simCfg.strategies.map((strat,i)=>{
          const r=simResults[i];
          const pnl=r?r.totalPnl:0;
          return(
            <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid #1e2d3d"}}>
              <span style={{fontSize:11,color:TRACK_COLORS[i%TRACK_COLORS.length]}}>{strat.label} <span style={{color:"#64748b"}}>· {betTargetText(strat.type,strat.config,false,3)}</span></span>
              <span style={{fontSize:13,fontWeight:700,color:pnl>=0?"#4ade80":"#f87171"}}>{pnl>=0?"+":"-"}{cur.symbol}{Math.abs(pnl).toFixed(2)}</span>
            </div>
          );
        })}

        <div style={{display:"flex",gap:8,marginTop:12}}>
          {simRunning
            ? <button onClick={stopSim} style={{flex:1,padding:"12px 0",borderRadius:10,border:"none",background:"#7f1d1d",color:"#f87171",fontSize:13,fontWeight:700,cursor:"pointer"}}>■ Stop</button>
            : <button onClick={()=>{setView("results");}} style={{flex:1,padding:"12px 0",borderRadius:10,border:"none",background:"#134e2a",color:"#4ade80",fontSize:13,fontWeight:700,cursor:"pointer"}}>📊 View Results</button>
          }
          <button onClick={()=>setView("setup")} style={{flex:1,padding:"12px 0",borderRadius:10,border:"1px solid #2d4057",background:"transparent",color:"#94a3b8",fontSize:13,cursor:"pointer"}}>← Setup</button>
        </div>
        {simDone && (simProgress>=simCfg.sessions*(simCfg.repeatExperiments||1)
          ? <div style={{textAlign:"center",color:"#4ade80",fontWeight:700,marginTop:8}}>✅ Simulation Complete!</div>
          : <div style={{textAlign:"center",color:"#fbbf24",fontWeight:700,marginTop:8}}>⏹ Stopped early — {simProgress.toLocaleString()} of {(simCfg.sessions*(simCfg.repeatExperiments||1)).toLocaleString()} sessions ran</div>)}
      </Card>
    </div>
  );

  // -- Results View --
  if(view==="results" && simResults) return (
    <div style={{display:"flex",flexDirection:"column",gap:12,width:"100%"}}>
      <div style={{display:"flex",gap:8}}>
        <button onClick={()=>setView("setup")} style={{flex:1,padding:"10px 0",borderRadius:10,border:"1px solid #2d4057",background:"transparent",color:"#94a3b8",fontSize:12,cursor:"pointer"}}>← Setup</button>
        <button onClick={()=>setView("running")} style={{flex:1,padding:"10px 0",borderRadius:10,border:"1px solid #2d4057",background:"transparent",color:"#94a3b8",fontSize:12,cursor:"pointer"}}>Progress</button>
      </div>
      <div style={{fontSize:11,color:"#64748b",textAlign:"center"}}>
        {((simResults[0]&&simResults[0].sessions.length)||0).toLocaleString()} sessions × {simCfg.spinsPerSession.toLocaleString()} spins
        {simResults[0]&&simResults[0].sessions.length<simCfg.sessions?" (stopped early)":""}
      </div>

      {simCfg.strategies.map((strat,i)=>{
        const r=simResults[i];
        if(!r) return null;
        const stats=computeSimStats(r);
        if(!stats) return null;
        const color=TRACK_COLORS[i%TRACK_COLORS.length];

        return(
          <Card key={i}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
              <div>
                <div style={{fontSize:13,fontWeight:800,color}}>{strat.label}</div>
                <BetTargets type={strat.type} config={strat.config} compact style={{marginTop:3}}/>
                <div style={{fontSize:10,color:"#64748b",marginTop:2}}>
                  {(r.totalSequences||0).toLocaleString()} sequences · {(stats.winRate*100).toFixed(1)}% win rate
                </div>
                <div style={{fontSize:9,color:"#475569",marginTop:2,maxWidth:200}}>
                  Win rate = completed progressions ending in a win; a stop-loss is the losing end of one progression
                </div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:18,fontWeight:900,color:stats.totalPnl>=0?"#4ade80":"#f87171"}}>{stats.totalPnl>=0?"+":"-"}{cur.symbol}{Math.abs(stats.totalPnl).toFixed(2)}</div>
                <div style={{fontSize:10,color:"#64748b"}}>avg {stats.avgPnlPerSession>=0?"+":""}{cur.symbol}{stats.avgPnlPerSession.toFixed(2)}/sess</div>
              </div>
            </div>

            {/* Bankroll survival */}
            {r.bankrollStart!=null && (
              <div style={{marginBottom:12,padding:"10px 12px",borderRadius:10,border:"1px solid "+(r.busted?"#7f1d1d":"#166534"),background:r.busted?"#200505":"#07200d"}}>
                <div style={{fontSize:13,fontWeight:800,color:r.busted?"#f87171":"#4ade80"}}>
                  {r.busted
                    ? `💀 Busted after ${r.bustedAtSession} session${r.bustedAtSession===1?"":"s"}`
                    : `✅ Survived all ${r.sessions.length} sessions`}
                </div>
                <div style={{fontSize:10,color:"#94a3b8",marginTop:3}}>
                  Bankroll: {cur.symbol}{r.bankrollStart.toFixed(2)} buy-in → {r.busted?cur.symbol+"0.00":cur.symbol+(r.bankrollCurrent||0).toFixed(2)}
                  {!r.busted&&r.bankrollCurrent!=null&&(
                    <span style={{color:(r.bankrollCurrent-r.bankrollStart)>=0?"#4ade80":"#f87171",fontWeight:700}}>
                      {" "}({(r.bankrollCurrent-r.bankrollStart)>=0?"+":"-"}{cur.symbol}{Math.abs(r.bankrollCurrent-r.bankrollStart).toFixed(2)})
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* P&L Distribution */}
            <div style={{marginBottom:12}}>
              <div style={{fontSize:10,color:"#64748b",textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>P&L Per Session Distribution</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr 1fr",gap:4}}>
                {[["Min",stats.minPnl,"#f87171"],["P25",stats.p25,"#f97316"],["P50",stats.p50,"#fbbf24"],["P75",stats.p75,"#86efac"],["Max",stats.maxPnl,"#4ade80"]].map(([l,v,c])=>(
                  <div key={l} style={{background:"#0f1923",borderRadius:8,padding:"6px 4px",textAlign:"center",border:"1px solid #2d4057"}}>
                    <div style={{fontSize:8,color:"#64748b"}}>{l}</div>
                    <div style={{fontSize:11,fontWeight:700,color:v>=0?c:"#f87171"}}>{v>=0?"+":"-"}{cur.symbol}{Math.abs(v).toFixed(0)}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Repeat-experiment comparison (all runs, identical parameters) */}
            <ExperimentPanel experiments={r.experimentHistory} bankrollMode={!!simCfg.bankrollMode} sessionsPerExperiment={simCfg.sessions} cur={cur}/>

            {/* Averages */}
            <div style={{marginBottom:12}}>
              <div style={{fontSize:10,color:"#64748b",textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Averages</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                {[
                  ["Avg P&L / Session",(stats.avgPnlPerSession>=0?"+":"-")+cur.symbol+Math.abs(stats.avgPnlPerSession).toFixed(2),stats.avgPnlPerSession>=0?"#4ade80":"#f87171"],
                  ["Avg P&L / Sequence",(stats.avgPnlPerSequence>=0?"+":"-")+cur.symbol+Math.abs(stats.avgPnlPerSequence).toFixed(2),stats.avgPnlPerSequence>=0?"#86efac":"#f97316"],
                  ["Avg Winning Session ("+stats.winSessionCount+")","+"+cur.symbol+Math.abs(stats.avgWinSession).toFixed(2),"#4ade80"],
                  ["Avg Losing Session ("+stats.lossSessionCount+")","-"+cur.symbol+Math.abs(stats.avgLossSession).toFixed(2),"#f87171"],
                  ["Avg Sequences / Session",stats.avgSequencesPerSession.toFixed(1),"#c4b5fd"],
                  ["Avg Staked / Session",cur.symbol+stats.avgStakedPerSession.toFixed(2),"#94a3b8"],
                ].map(([l,v,c])=>(
                  <div key={l} style={{background:"#0f1923",borderRadius:8,padding:"8px 8px",border:"1px solid #2d4057"}}>
                    <div style={{fontSize:8,color:"#64748b",marginBottom:2}}>{l}</div>
                    <div style={{fontSize:14,fontWeight:700,color:c}}>{v}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Expected loss (house edge) — secondary metric */}
            {(()=>{
              const wheelUsed=r.roulette||simCfg.roulette;
              const houseEdge=wheelUsed==="european"?1/37:2/38;
              const expectedLoss=stats.totalStaked*houseEdge;
              const luckDelta=stats.totalPnl+expectedLoss; // how far actual results ran from expectation
              return (
                <div style={{marginBottom:12,padding:"10px 12px",borderRadius:10,border:"1px solid #2d4057",background:"#0c1520"}}>
                  <div style={{fontSize:10,color:"#64748b",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Expected Loss · house edge {(houseEdge*100).toFixed(2)}% ({wheelUsed==="european"?"🇪🇺":"🇺🇸"})</div>
                  <div style={{display:"flex",justifyContent:"space-between",gap:8,flexWrap:"wrap"}}>
                    <div>
                      <div style={{fontSize:8,color:"#64748b"}}>Expected (total staked × edge)</div>
                      <div style={{fontSize:14,fontWeight:700,color:"#f97316"}}>-{cur.symbol}{expectedLoss.toFixed(2)} <span style={{fontSize:9,color:"#64748b"}}>(-{cur.symbol}{(expectedLoss/(stats.sessionPnls.length||1)).toFixed(2)}/sess)</span></div>
                    </div>
                    <div>
                      <div style={{fontSize:8,color:"#64748b"}}>Actual vs expected (luck)</div>
                      <div style={{fontSize:14,fontWeight:700,color:luckDelta>=0?"#4ade80":"#f87171"}}>{luckDelta>=0?"+":"-"}{cur.symbol}{Math.abs(luckDelta).toFixed(2)} {luckDelta>=0?"ahead":"behind"}</div>
                    </div>
                  </div>
                  <div style={{fontSize:9,color:"#475569",marginTop:5,lineHeight:1.4}}>
                    Secondary metric: the house keeps {(houseEdge*100).toFixed(2)}% of every {cur.symbol} staked on average. Actual results scatter around that drain — a run can finish in profit even though the expected loss is always there.
                  </div>
                </div>
              );
            })()}

            {/* Streak Stats */}
            <div style={{marginBottom:12}}>
              <div style={{fontSize:10,color:"#64748b",textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Streak Analysis</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                {[
                  ["Longest Win Streak",stats.longestWinStreak,"#4ade80"],
                  ["Longest Loss Streak",stats.longestLossStreak,"#f87171"],
                  ["Avg Win Streak",stats.avgWinStreak.toFixed(1),"#86efac"],
                  ["Avg Loss Streak",stats.avgLossStreak.toFixed(1),"#f97316"],
                  ["Stop Loss Hits",r.stopLossHits,"#fbbf24"],
                  ["Stop Loss Rate",(stats.stopLossRate).toFixed(2)+"/sess","#fbbf24"],
                  ["Sat Out (never entered)",(r.satOutSessions||0)+" of "+r.sessions.length+" ("+(r.sessions.length?((r.satOutSessions||0)/r.sessions.length*100).toFixed(1):"0")+"%)","#60a5fa"],
                ].map(([l,v,c])=>(
                  <div key={l} style={{background:"#0f1923",borderRadius:8,padding:"8px 8px",border:"1px solid #2d4057"}}>
                    <div style={{fontSize:8,color:"#64748b",marginBottom:2}}>{l}</div>
                    <div style={{fontSize:14,fontWeight:700,color:c}}>{v}</div>
                  </div>
                ))}
              </div>
            </div>

            <StreakDistribution kind="loss" rows={stats.lossStreakDist}/>
            <StreakDistribution kind="raw" rows={stats.rawLossStreakDist}/>
            <StreakDistribution kind="win" rows={stats.winStreakDist}/>

            <SessionExplorer sessions={r.sessions} cur={cur}/>
          </Card>
        );
      })}
    </div>
  );

  return null;
}

// -- Sim Strategy Editor --
function SimStratEditor({strat, idx, simCfg, setSimCfg, cur, onClose}) {
  const [cfg, setCfg] = useState({...strat.config});
  const [rules, setRules] = useState({...defaultParkRules(), ...(strat.config.parkRules||{})});
  function upCfg(k,v){setCfg(c=>({...c,[k]:v}));}
  function upRule(k,v){setRules(r=>({...r,[k]:v}));}
  function toggleArr(key,val,max){
    const arr=cfg[key]||[];
    if(arr.includes(val)){upCfg(key,arr.filter(x=>x!==val));}
    else if(arr.length<max){upCfg(key,[...arr,val].sort());}
  }
  function save(){
    setSimCfg(c=>{
      const strats=[...c.strategies];
      strats[idx]={...strats[idx],config:{...cfg,parkRules:rules}};
      return{...c,strategies:strats};
    });
    onClose();
  }
  return(
    <div style={{marginTop:10,padding:10,background:"#0c1520",borderRadius:10,border:"1px solid #2d4057",display:"flex",flexDirection:"column",gap:10}}>
      <div style={{background:"#0f1923",borderRadius:9,padding:"8px 10px",border:"1px solid #2d4057"}}>
        <FieldLabel>Now Betting</FieldLabel>
        <BetTargets type={strat.type} config={cfg} compact/>
      </div>
      <ROIStepper value={cfg.roi} onChange={v=>upCfg("roi",v)} disabled={(cfg.evenTargets||[]).length>0}/>
      <div style={{display:"flex",alignItems:"center",background:"#0f1923",borderRadius:10,border:"1px solid #2d4057",overflow:"hidden"}}>
        <button onClick={()=>upCfg("stopLoss",Math.max(25,cfg.stopLoss-25))} style={{padding:"7px 12px",background:"transparent",border:"none",color:"#60a5fa",fontSize:16,fontWeight:700,cursor:"pointer"}}>-</button>
        <div style={{flex:1,textAlign:"center",fontSize:14,fontWeight:800,color:"#f87171"}}>Stop {cur.symbol}{cfg.stopLoss}</div>
        <button onClick={()=>upCfg("stopLoss",cfg.stopLoss+25)} style={{padding:"7px 12px",background:"transparent",border:"none",color:"#60a5fa",fontSize:16,fontWeight:700,cursor:"pointer"}}>+</button>
      </div>

      {strat.type==="fibonacci" && (
        <>
          <div>
            <FieldLabel>Bet Mode</FieldLabel>
            <div style={{display:"flex",gap:5}}>
              {[["flat","Flat"],["progression","Progression"]].map(([m,l])=>{
                const sel=(cfg.betMode||"progression")===m;
                return <button key={m} onClick={()=>upCfg("betMode",m)} style={{flex:1,padding:"6px 0",borderRadius:8,border:"2px solid "+(sel?"#86efac":"#2d4057"),background:sel?"#134e2a":"#0f1923",color:sel?"#86efac":"#64748b",fontSize:11,fontWeight:700,cursor:"pointer"}}>{l}</button>;
              })}
            </div>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 10px",borderRadius:8,border:"1px solid "+(cfg.autoChase?"#f59e0b":"#2d4057"),background:cfg.autoChase?"#1c1000":"#0f1923"}}>
            <div>
              <div style={{fontSize:11,fontWeight:700,color:cfg.autoChase?"#fbbf24":"#94a3b8"}}>🔄 Auto-chase most-missed</div>
              <div style={{fontSize:9,color:"#475569"}}>Locks onto the coldest dozen or column until it hits or the stop loss; ties picked at random</div>
            </div>
            <button onClick={()=>upCfg("autoChase",!cfg.autoChase)} style={{padding:"4px 12px",borderRadius:7,border:"none",background:cfg.autoChase?"#b45309":"#374151",color:"white",fontSize:10,fontWeight:700,cursor:"pointer"}}>{cfg.autoChase?"ON":"OFF"}</button>
          </div>
          {!cfg.autoChase && (
          <>
          <div>
            <FieldLabel>Even Money</FieldLabel>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:4}}>
              {[{key:"red",label:"Red",color:"#ef4444",pair:"black"},{key:"black",label:"Black",color:"#94a3b8",pair:"red"},{key:"odd",label:"Odd",color:"#a78bfa",pair:"even"},{key:"even",label:"Even",color:"#60a5fa",pair:"odd"},{key:"high",label:"High",color:"#fbbf24",pair:"low"},{key:"low",label:"Low",color:"#86efac",pair:"high"}].map(em=>{
                const evts=cfg.evenTargets||[];
                const sel=evts.includes(em.key);
                const pairSel=evts.includes(em.pair);
                return <button key={em.key} onClick={()=>{if(sel){upCfg("evenTargets",evts.filter(x=>x!==em.key));}else if(!pairSel&&evts.length<2){upCfg("evenTargets",[...evts,em.key]);upCfg("dozenTargets",[]);upCfg("colTargets",[]);}}} style={{padding:"6px 0",borderRadius:7,border:"2px solid "+(sel?em.color:pairSel?"#1e2d3d":"#2d4057"),background:sel?"#0f1923":"transparent",color:sel?em.color:pairSel?"#1e2d3d":"#64748b",fontSize:11,fontWeight:700,cursor:pairSel&&!sel?"not-allowed":"pointer",opacity:pairSel&&!sel?0.3:1}}>{em.label}</button>;
              })}
            </div>
          </div>
          {(cfg.evenTargets||[]).length===0 && (
            <>
              <div>
                <FieldLabel>Dozens</FieldLabel>
                <div style={{display:"flex",gap:5}}>
                  {[0,1,2].map(i=>{const sel=(cfg.dozenTargets||[]).includes(i);return<button key={i} onClick={()=>{toggleArr("dozenTargets",i,2);upCfg("evenTargets",[]);}} style={{flex:1,padding:"7px 0",borderRadius:8,border:"2px solid "+(sel?DOZEN_BORDERS[i]:"#2d4057"),background:sel?"#0f1923":"transparent",color:sel?DOZEN_TEXTS[i]:"#64748b",fontSize:11,fontWeight:700,cursor:"pointer"}}>{DOZEN_LABELS[i]}</button>;})}
                </div>
              </div>
              <div>
                <FieldLabel>Columns</FieldLabel>
                <div style={{display:"flex",gap:5}}>
                  {[0,1,2].map(i=>{const sel=(cfg.colTargets||[]).includes(i);return<button key={i} onClick={()=>{toggleArr("colTargets",i,2);upCfg("evenTargets",[]);}} style={{flex:1,padding:"7px 0",borderRadius:8,border:"2px solid "+(sel?COLUMN_BORDERS[i]:"#2d4057"),background:sel?"#0f1923":"transparent",color:sel?COLUMN_TEXTS[i]:"#64748b",fontSize:11,fontWeight:700,cursor:"pointer"}}>{COLUMN_LABELS[i]}</button>;})}
                </div>
              </div>
            </>
          )}
          </>
          )}
        </>
      )}

      {strat.type==="solution" && (
        <div style={{display:"flex",alignItems:"center",background:"#0f1923",borderRadius:10,border:"1px solid #2d4057",overflow:"hidden"}}>
          <button onClick={()=>upCfg("entryThreshold",Math.max(20,cfg.entryThreshold-10))} style={{padding:"7px 12px",background:"transparent",border:"none",color:"#60a5fa",fontSize:16,fontWeight:700,cursor:"pointer"}}>-</button>
          <div style={{flex:1,textAlign:"center",fontSize:14,fontWeight:800,color:"#f59e0b"}}>Entry {cfg.entryThreshold} misses</div>
          <button onClick={()=>upCfg("entryThreshold",cfg.entryThreshold+10)} style={{padding:"7px 12px",background:"transparent",border:"none",color:"#60a5fa",fontSize:16,fontWeight:700,cursor:"pointer"}}>+</button>
        </div>
      )}

      {/* Park/Play Rules */}
      <div style={{borderTop:"1px solid #2d4057",paddingTop:10}}>
        <FieldLabel>Park/Play Rules</FieldLabel>
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {[
            ["waitForWin","Wait for win before entering","Don't bet until first in-range hit observed"],
            ["parkAfterStopLoss","Park after stop loss hit","Resume only after next in-range win observed"],
            ["parkAfterLoss","Park after any miss","Resume next spin (aggressive filter)"],
          ].map(([key,label,desc])=>(
            <div key={key} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 10px",borderRadius:8,border:"1px solid "+(rules[key]?"#a78bfa":"#2d4057"),background:rules[key]?"#1a0a2e":"#0f1923"}}>
              <div>
                <div style={{fontSize:11,fontWeight:700,color:rules[key]?"#c4b5fd":"#94a3b8"}}>{label}</div>
                <div style={{fontSize:9,color:"#475569"}}>{desc}</div>
              </div>
              <button onClick={()=>upRule(key,!rules[key])} style={{padding:"4px 12px",borderRadius:7,border:"none",background:rules[key]?"#7c3aed":"#374151",color:"white",fontSize:10,fontWeight:700,cursor:"pointer"}}>{rules[key]?"ON":"OFF"}</button>
            </div>
          ))}
          {(()=>{
            // 12-number targets (dozens/columns/auto-chase) live on much shorter
            // drought scales, so their steppers move by 1; single numbers by 5.
            const twelveNumberTarget = strat.type==="fibonacci"&&(cfg.autoChase||(cfg.dozenTargets||[]).length>0||(cfg.colTargets||[]).length>0);
            const droughtStep = twelveNumberTarget?1:5;
            const defaultThreshold = twelveNumberTarget?3:Math.max(1,(cfg.entryThreshold||5)-10);
            return (
              <div style={{display:"flex",alignItems:"center",padding:"8px 10px",borderRadius:8,border:"1px solid "+(rules.droughtThreshold?"#a78bfa":"#2d4057"),background:rules.droughtThreshold?"#1a0a2e":"#0f1923",gap:8}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:11,fontWeight:700,color:rules.droughtThreshold?"#c4b5fd":"#94a3b8"}}>Min drought to enter</div>
                  <div style={{fontSize:9,color:"#475569"}}>Park if no target meets threshold</div>
                </div>
                <button onClick={()=>upRule("droughtThreshold",rules.droughtThreshold?null:defaultThreshold)} style={{padding:"4px 10px",borderRadius:7,border:"none",background:rules.droughtThreshold?"#7c3aed":"#374151",color:"white",fontSize:10,fontWeight:700,cursor:"pointer"}}>{rules.droughtThreshold?"ON":"OFF"}</button>
                {rules.droughtThreshold&&(
                  <div style={{display:"flex",alignItems:"center",gap:2}}>
                    <button onClick={()=>upRule("droughtThreshold",Math.max(1,rules.droughtThreshold-droughtStep))} style={{padding:"3px 7px",borderRadius:5,border:"none",background:"#0f1923",color:"#60a5fa",fontSize:12,fontWeight:700,cursor:"pointer"}}>-</button>
                    <input
                      type="number"
                      inputMode="numeric"
                      min="1"
                      value={rules.droughtThreshold}
                      onChange={e=>{const n=parseInt(e.target.value,10);upRule("droughtThreshold",isNaN(n)?1:Math.max(1,n));}}
                      style={{width:46,textAlign:"center",fontSize:12,fontWeight:700,color:"#c4b5fd",background:"#0f1923",border:"1px solid #2d4057",borderRadius:5,padding:"3px 2px",outline:"none",WebkitAppearance:"none"}}
                    />
                    <button onClick={()=>upRule("droughtThreshold",rules.droughtThreshold+droughtStep)} style={{padding:"3px 7px",borderRadius:5,border:"none",background:"#0f1923",color:"#60a5fa",fontSize:12,fontWeight:700,cursor:"pointer"}}>+</button>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      <div style={{display:"flex",gap:8}}>
        <button onClick={save} style={{flex:1,padding:"10px 0",borderRadius:10,border:"none",background:"#7c3aed",color:"white",fontSize:13,fontWeight:700,cursor:"pointer"}}>Save</button>
        <button onClick={onClose} style={{flex:1,padding:"10px 0",borderRadius:10,border:"1px solid #2d4057",background:"transparent",color:"#94a3b8",fontSize:13,cursor:"pointer"}}>Cancel</button>
      </div>
    </div>
  );
}
