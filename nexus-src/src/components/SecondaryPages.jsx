  // -- Spin Log Page --
function SpinPage({ sess, updSess, trackOverlays }) {
    const [showAll, setShowAll] = useState(false);
    const displaySpins = showAll ? [...sess.spins].reverse() : [...sess.spins].reverse().slice(0,60);
    return (
      <div style={{display:"flex",flexDirection:"column",gap:10,width:"100%"}}>
        <Card>
          <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10}}>
            <span style={{fontSize:12,color:"#64748b",flex:1}}>Total Spins: <strong style={{color:"#e2e8f0"}}>{sess.spins.length}</strong></span>
            {sess.spins.length>0 && <button onClick={()=>{if(window.confirm("Clear all spins from session history?"))updSess(s=>{s.spins=[];s.droughts=initDroughts(s.roulette);resetDealerChanges(s);});}} style={{padding:"6px 12px",borderRadius:8,border:"1px solid #7f1d1d",background:"#1e2d3d",color:"#f87171",fontSize:12,cursor:"pointer"}}>Clear History</button>}
          </div>
          {sess.spins.length===0
            ? <div style={{textAlign:"center",padding:"20px 0",color:"#475569",fontSize:12}}>No spins logged yet. Enter numbers on the Tracker tab.</div>
            : (
              <>
                <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                  {displaySpins.map((val,i)=>{
                    const isZ=val==="0"||val==="00", r=!isZ&&RED.has(+val);
                    const hitTracks=(trackOverlays||[]).filter(o=>{
                      if(isZ)return false;
                      if(o.type==="fibonacci")return (o.dozenTargets||[]).includes(dozenOf(val))||(o.colTargets||[]).includes(columnOf(val));
                      if(o.type==="solution")return (o.activeBets||[]).some(b=>b.number===val);
                      return false;
                    });
                    const borderColor=i===0?"#ffffff":hitTracks.length>0?hitTracks[0].color:isZ?"#22c55e":r?"#ef4444":"#1f2937";
                    return(
                      <div key={i} style={{width:30,height:30,borderRadius:6,background:isZ?"#166534":r?"#7f1d1d":"#0d1117",border:"2px solid "+borderColor,color:isZ?"#bbf7d0":r?"#fecaca":"#f1f5f9",fontSize:10,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>
                        {val}
                      </div>
                    );
                  })}
                </div>
                {sess.spins.length>60 && (
                  <button onClick={()=>setShowAll(v=>!v)} style={{marginTop:8,width:"100%",padding:"7px 0",borderRadius:8,border:"1px solid #2d4057",background:"transparent",color:"#60a5fa",fontSize:12,cursor:"pointer"}}>
                    {showAll?"Show less":"Show all "+sess.spins.length+" spins"}
                  </button>
                )}
              </>
            )
          }
        </Card>
      </div>
    );
  }
  // -- Spins logged by venue (F11): counts only, across the saved sessions. Every row reconciles with the total. --
function VenueSpinCounts({sessions}) {
    const counts = venueSpinCounts(sessions);
    const groups = [
      ["Casino", venueCountRows(counts.casino)],
      ["Machine", venueCountRows(counts.machine)],
      ["Table and dealer", venueCountRows(counts.table)],
    ];
    return (
      <Card>
        <FieldLabel>Spins logged by venue</FieldLabel>
        <div style={{fontSize:11,color:"#64748b",marginBottom:10}}>{counts.total+" spins in "+sessions.length+" saved sessions · "+counts.noVenue+" with no venue"}</div>
        {groups.map(([title,rows]) => (
          <div key={title} style={{marginBottom:10,minWidth:0}}>
            <div style={{fontSize:10,color:"#64748b",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>{title}</div>
            {rows.length===0
              ? <div style={{fontSize:12,color:"#475569"}}>None recorded</div>
              : rows.map(r => (
                <div key={r.label} style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:8,fontSize:12,color:"#e2e8f0",minWidth:0,padding:"2px 0"}}>
                  <span style={{minWidth:0,overflowWrap:"anywhere"}}>{r.label}</span>
                  <strong style={{flex:"0 0 auto",fontVariantNumeric:"tabular-nums"}}>{r.count}</strong>
                </div>
              ))
            }
          </div>
        ))}
      </Card>
    );
  }
  // -- Session Stats Page --
// venueSession: the Live session is the one whose venue can be recorded here. onEditVenue(scope) opens the venue sheet
// for "current" or for a saved session id.
function StatsPage({ sess, livePauseOffset, pnlVal, cur, currency, pnlColor, saveSession, newEmptySession, tearSession, reactivateTrack, saved, loadSession, exportJSON, venueSession, onEditVenue }) {
    // Group tracks by type + roi + stopLoss for consolidated view
    const trackGroups = useMemo(() => {
      const groups = {};
      sess.tracks.forEach(t => {
        // Targets are part of the identity: two Progression tracks on different
        // dozens are different strategies and must not collapse into one row.
        // The Solution is exempt — its numbers churn as bets resolve.
        const targetKey = t.type==="solution" ? "" : betTargetText(t.type, t.config);
        const key = `${t.type}|${targetKey}|${t.config.roi}|${t.config.stopLoss}|${t.config.unit}`;
        if(!groups[key]) groups[key] = {key, type:t.type, roi:t.config.roi, stopLoss:t.config.stopLoss, unit:t.config.unit||1, tracks:[], totalPnl:0, wins:0, losses:0, lastConfig:null, color:t.color};
        const g = groups[key];
        g.tracks.push(t);
        g.totalPnl += t.pnl*(t.config.unit||1);
        g.wins += t.bets.filter(b=>b.outcome==="win").length;
        g.losses += t.bets.filter(b=>b.outcome==="loss").length;
        g.lastConfig = t.config;
        g.color = t.color;
      });
      return Object.values(groups);
    }, [sess.tracks]);

    return (
      <div style={{display:"flex",flexDirection:"column",gap:10,width:"100%"}}>
        <Card>
          <FieldLabel>Current Session</FieldLabel>
          <div style={{fontSize:13,color:"#e2e8f0",fontWeight:700,marginBottom:4}}>{sess.name}</div>
          <div style={{fontSize:11,color:"#64748b",marginBottom:12}}>{new Date(sess.created).toLocaleString()} · {sess.spins.length} spins · {sess.tracks.length} tracks</div>
          {venueSession && (
            <div style={{display:"flex",alignItems:"center",gap:8,minHeight:34,marginBottom:12,minWidth:0}}>
              <span style={{flex:"1 1 0",minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize:12,color:sess.venue?"#e2e8f0":"#64748b"}}>{venueLine(sess.venue)||"No venue recorded"}</span>
              <button onClick={()=>onEditVenue("current")} style={{flex:"0 0 auto",padding:"6px 10px",borderRadius:8,border:"1px solid #2d4057",background:"#1e2d3d",color:"#60a5fa",fontSize:12,cursor:"pointer"}}>{sess.venue?"Edit venue":"Add venue"}</button>
            </div>
          )}
          {sess.sessionStartedAt && (
            <div style={{background:"#0c1520",borderRadius:9,padding:"8px 12px",border:"1px solid #2d4057",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:11,color:"#64748b"}}>Session Time</span>
              <SessionClock startedAt={sess.sessionStartedAt} endedAt={sess.sessionEndedAt} pauseOffset={livePauseOffset} style={{fontSize:14,fontWeight:800,color:"#4ade80",fontVariantNumeric:"tabular-nums"}}/>
              {(()=>{
                const hrs=((sess.sessionEndedAt||Date.now())-sess.sessionStartedAt)/3600000;
                const rate=hrs>0.01?pnlVal/hrs:null;
                return rate!==null?(
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:10,color:"#64748b"}}>$/hr</div>
                    <div style={{fontSize:14,fontWeight:800,color:rate>=0?"#4ade80":"#f87171"}}>{rate>=0?"+":"-"}{cur.symbol}{Math.abs(rate).toFixed(cur.dec)}</div>
                  </div>
                ):null;
              })()}
            </div>
          )}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
            {[
              {l:"Initial Bankroll",v:formatMoney(sess.bankroll,currency),c:"#60a5fa"},
              {l:"Current",v:formatMoney(sess.bankrollCurrent,currency),c:"#60a5fa"},
              {l:"Total Buy Ins",v:"+"+formatMoney(sess.totalBuyIn||0,currency),c:"#a78bfa"},
              {l:"Total Cash Outs",v:sess.totalCashOut>0?formatMoney(sess.totalCashOut||0,currency):formatMoney(0,currency),c:"#f97316"},
              {l:"Net Money In",v:formatMoney((sess.totalBuyIn||0)-(sess.totalCashOut||0),currency),c:(sess.totalBuyIn||0)>=(sess.totalCashOut||0)?"#f87171":"#4ade80"},
              {l:"Net P&L",v:(pnlVal>=0?"+":"-")+cur.symbol+formatNumber(pnlVal),c:pnlColor},
            ].map(({l,v,c}) => (
              <div key={l} style={{background:"#0f1923",borderRadius:10,padding:"10px 8px",border:"1px solid #2d4057",textAlign:"center"}}>
                <div style={{fontSize:8,color:"#64748b",textTransform:"uppercase",marginBottom:3}}>{l}</div>
                <div style={{fontSize:15,fontWeight:800,color:c}}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={saveSession} style={{flex:1,padding:11,borderRadius:10,border:"none",background:"#16a34a",color:"white",fontSize:13,fontWeight:700,cursor:"pointer"}}>Save</button>
            <button onClick={newEmptySession} style={{flex:1,padding:11,borderRadius:10,border:"1px solid #2d4057",background:"#1e2d3d",color:"#94a3b8",fontSize:13,cursor:"pointer"}}>New</button>
            <button onClick={tearSession} style={{flex:1,padding:11,borderRadius:10,border:"1px solid #7f1d1d",background:"#1e2d3d",color:"#f87171",fontSize:13,cursor:"pointer"}}>Tear</button>
          </div>
        </Card>

        {trackGroups.length>0 && (
          <Card>
            <FieldLabel>Strategy Performance</FieldLabel>
            {trackGroups.map(g => {
              const winRate=g.wins+g.losses>0?(g.wins/(g.wins+g.losses)*100).toFixed(0)+"%":"--";
              const hasInactive=g.tracks.some(t=>t.state==="closed"||t.state==="parked");
              const closedInGroup=g.tracks.filter(t=>t.state==="closed");
              const parkedInGroup=g.tracks.filter(t=>t.state==="parked");
              const activeInGroup=g.tracks.filter(t=>t.state==="active");
              const typeLabel=g.type==="fibonacci"?"🎲 Progression Bet":g.type==="custom"?"🃏 Custom Bet":"🎯 Solution";
              return(
                <div key={g.key} style={{background:"#0f1923",borderRadius:10,padding:"12px",border:"1px solid "+(g.color?g.color+"66":"#2d4057"),marginBottom:8}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                    <div>
                      <div style={{fontSize:12,fontWeight:800,color:"#e2e8f0"}}>{typeLabel} · {g.roi}% ROI · {cur.symbol}{g.stopLoss} stop</div>
                      <BetTargets type={g.type} config={g.lastConfig} compact style={{marginTop:3}}/>
                      <div style={{fontSize:10,color:"#64748b",marginTop:2}}>{cur.symbol}{g.unit.toFixed(2)}/chip</div>
                      <div style={{fontSize:10,color:"#64748b",marginTop:2}}>
                        {activeInGroup.length>0&&<span style={{color:"#4ade80"}}>{activeInGroup.length} active </span>}
                        {parkedInGroup.length>0&&<span style={{color:"#fbbf24"}}>{parkedInGroup.length} parked </span>}
                        {closedInGroup.length>0&&<span style={{color:"#64748b"}}>{closedInGroup.length} closed</span>}
                      </div>
                    </div>
                    <div style={{fontSize:16,fontWeight:800,color:g.totalPnl>=0?"#4ade80":"#f87171"}}>{g.totalPnl>=0?"+":"-"}{cur.symbol}{Math.abs(g.totalPnl).toFixed(cur.dec)}</div>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginBottom:8}}>
                    {[["Wins",g.wins,"#4ade80"],["Losses",g.losses,"#f87171"],["Win Rate",winRate,"#86efac"]].map(([l,v,c])=>(
                      <div key={l} style={{textAlign:"center"}}>
                        <div style={{fontSize:8,color:"#64748b",textTransform:"uppercase"}}>{l}</div>
                        <div style={{fontSize:14,fontWeight:700,color:c}}>{v}</div>
                      </div>
                    ))}
                  </div>
                  {(closedInGroup.length>0||parkedInGroup.length>0) && (
                    <div style={{display:"flex",gap:6}}>
                      {closedInGroup.slice(-1).map(t=>(
                        <button key={t.id} onClick={()=>reactivateTrack(t.id)} style={{flex:1,padding:"7px 0",borderRadius:8,border:"1px solid #16a34a",background:"#0d2a0d",color:"#4ade80",fontSize:11,fontWeight:700,cursor:"pointer"}}>▶ Restart Closed</button>
                      ))}
                      {parkedInGroup.map(t=>(
                        <button key={t.id} onClick={()=>reactivateTrack(t.id)} style={{flex:1,padding:"7px 0",borderRadius:8,border:"1px solid #fbbf24",background:"#1c1000",color:"#fbbf24",fontSize:11,fontWeight:700,cursor:"pointer"}}>▶ Resume Parked</button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </Card>
        )}

        <Card>
          <FieldLabel>{"Saved Sessions ("+saved.length+")"}</FieldLabel>
          {saved.length===0
            ? <div style={{textAlign:"center",padding:"16px 0",color:"#475569",fontSize:12}}>No saved sessions yet.</div>
            : (
              <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:"40vh",overflowY:"auto"}}>
                {[...saved].reverse().map(s => {
                  const pnl=computeMetrics(s).netPnL, isCurrent=s.id===sess.id;
                  return (
                    <div key={s.id} style={{background:"#0f1923",borderRadius:10,padding:"10px 12px",border:"1px solid "+(isCurrent?"#86efac":"#2d4057")}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
                        <div>
                          <div style={{fontSize:12,fontWeight:700,color:isCurrent?"#86efac":"#e2e8f0"}}>{s.name}{isCurrent?" (current)":""}</div>
                          <div style={{fontSize:10,color:"#64748b"}}>
                            {new Date(s.modified).toLocaleString()} · {s.spins.length} spins
                            {s.sessionStartedAt&&s.sessionEndedAt&&(
                              <span> · {formatElapsed(s.sessionEndedAt-s.sessionStartedAt)}</span>
                            )}
                          </div>
                        </div>
                        <div style={{fontSize:13,fontWeight:800,color:pnl>=0?"#4ade80":"#f87171"}}>{pnl>=0?"+":"-"}{cur.symbol}{Math.abs(pnl).toFixed(cur.dec)}</div>
                      </div>
                      {(s.mode===undefined||s.mode==="live") && (
                        <div style={{display:"flex",alignItems:"center",gap:8,minHeight:30,marginBottom:6,minWidth:0}}>
                          <span style={{flex:"1 1 0",minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize:11,color:s.venue?"#cbd5e1":"#64748b"}}>{venueLine(s.venue)||"No venue recorded"}</span>
                          <button onClick={()=>onEditVenue(s.id)} style={{flex:"0 0 auto",padding:"5px 9px",borderRadius:8,border:"1px solid #2d4057",background:"#1e2d3d",color:"#60a5fa",fontSize:11,cursor:"pointer"}}>{s.venue?"Edit venue":"Add venue"}</button>
                        </div>
                      )}
                      {!isCurrent && <button onClick={()=>loadSession(s.id)} style={{width:"100%",padding:"7px 0",borderRadius:8,border:"1px solid #2d4057",background:"#1e2d3d",color:"#94a3b8",fontSize:12,cursor:"pointer"}}>Resume</button>}
                    </div>
                  );
                })}
              </div>
            )
          }
        </Card>

        {saved.length>0 && <VenueSpinCounts sessions={saved}/>}

        <StreakPercentileTable wheel={sess.roulette}/>

        {saved.length>0 && (
          <Card>
            <button onClick={exportJSON} style={{width:"100%",padding:"12px 0",borderRadius:10,border:"none",background:"#1e3a5f",color:"#60a5fa",fontSize:13,fontWeight:700,cursor:"pointer"}}>Export All Sessions (.json)</button>
          </Card>
        )}
      </div>
    );
  }

  // -- Streak percentiles table (Stats) --
// The streak length at each percentile for every bet on the current wheel, from the generated table
// (streak-percentiles.js, read through percentile.js). Read-only. Lengths are consecutive losses before a win.
function StreakPercentileTable({wheel}) {
  const rows = streakRows(wheel);
  const meta = STREAK_PERCENTILE_DATA.meta;
  const th = {padding:"4px 3px",fontSize:10,fontWeight:700,color:"#64748b",textAlign:"right",borderBottom:"1px solid #2d4057"};
  const td = {padding:"3px 3px",fontSize:11,color:"#e2e8f0",textAlign:"right",fontVariantNumeric:"tabular-nums",borderTop:"1px solid #1f2937"};
  return (
    <Card>
      <FieldLabel>Streak percentiles</FieldLabel>
      <div style={{fontSize:11,color:"#64748b",marginBottom:8}}>
        {"Consecutive losses before a win, on the " + (wheel==="european"?"European":"American") + " wheel: the streak length at each percentile."}
      </div>
      <table style={{width:"100%",borderCollapse:"collapse"}}>
        <thead>
          <tr><th style={{...th,textAlign:"left"}}>Bet</th>{meta.percentiles.map(p=><th key={p} style={th}>{"P"+p}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map(r=>(
            <tr key={r.key}>
              <td style={{...td,textAlign:"left",whiteSpace:"normal"}}>{r.label}</td>
              {r.p.map((len,i)=><td key={i} style={td}>{len}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{fontSize:9,color:"#475569",marginTop:8,lineHeight:"13px"}}>
        {meta.sessions.toLocaleString("en-US")+" sessions x "+meta.spinsPerSession.toLocaleString("en-US")+" spins per wheel · seed \""+meta.seedLabel+"\" ("+meta.seed+") · generated "+meta.generatedAt}
      </div>
    </Card>
  );
}

  // -- Settings Page --
function SettingsPage({ settings, updSettings, setCurrencyOpen, currency, cur, updSess, sess, setChangelogOpen, updApp, importJSON, setHardResetOpen }) {
    const [localBuyIn, setLocalBuyIn] = useState(settings.defaultBuyIn || 100);

    function saveBuyIn() {
      updSettings(s => { s.defaultBuyIn = localBuyIn; });
    }

    return (
      <div style={{display:"flex",flexDirection:"column",gap:10,width:"100%"}}>
        <Card>
          <FieldLabel>Currency</FieldLabel>
          <button onClick={()=>setCurrencyOpen(true)} style={{display:"flex",alignItems:"center",gap:12,width:"100%",padding:"14px",borderRadius:12,border:"1px solid #2d4057",background:"#0f1923",cursor:"pointer",textAlign:"left"}}>
            <span style={{fontSize:22}}>{getCurrency(currency).flag}</span>
            <div style={{flex:1}}>
              <div style={{fontSize:14,fontWeight:700,color:"#e2e8f0"}}>{getCurrency(currency).name}</div>
              <div style={{fontSize:11,color:"#475569"}}>{currency} · {cur.symbol}</div>
            </div>
            <span style={{color:"#64748b",fontSize:18}}>›</span>
          </button>
        </Card>

        <Card>
          <FieldLabel>Default Buy In</FieldLabel>
          <MoneyInput value={localBuyIn} onChange={setLocalBuyIn} currCode={currency}/>
          <button onClick={saveBuyIn} style={{width:"100%",marginTop:10,padding:"12px 0",borderRadius:10,border:"none",background:"#16a34a",color:"white",fontSize:14,fontWeight:700,cursor:"pointer"}}>Save Default</button>
        </Card>

        <Card>
          <FieldLabel>Roulette Type</FieldLabel>
          <div style={{display:"flex",gap:8}}>
            {[["american","🇺🇸 American (00)"],["european","🇪🇺 European"]].map(([v,label]) => (
              <button key={v} onClick={()=>updSess(s=>{s.roulette=v;s.droughts=droughtsFromSpins(s.spins,v);})} style={{flex:1,padding:"10px 4px",borderRadius:9,border:"1px solid "+(sess.roulette===v?"#60a5fa":"#2d4057"),cursor:"pointer",fontSize:11,fontWeight:700,background:sess.roulette===v?"#0c1a2e":"#0f1923",color:sess.roulette===v?"#60a5fa":"#64748b"}}>{label}</button>
            ))}
          </div>
        </Card>

        <Card>
          <FieldLabel>Info</FieldLabel>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <button onClick={()=>setChangelogOpen(true)} style={{width:"100%",padding:"12px 0",borderRadius:10,border:"1px solid #2d4057",background:"#0f1923",color:"#94a3b8",fontSize:13,cursor:"pointer"}}>📋 Changelog</button>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 16px",borderRadius:10,border:"1px solid #2d4057",background:"#0f1923"}}>
              <span style={{fontSize:13,color:"#94a3b8"}}>📳 Vibration Feedback</span>
              <button onClick={()=>updApp(s=>{s.settings.vibration=!s.settings.vibration;})} style={{padding:"6px 16px",borderRadius:8,border:"none",background:settings.vibration!==false?"#16a34a":"#374151",color:"white",fontSize:12,fontWeight:700,cursor:"pointer"}}>{settings.vibration!==false?"ON":"OFF"}</button>
            </div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 16px",borderRadius:10,border:"1px solid #2d4057",background:"#0f1923"}}>
              <span style={{fontSize:13,color:"#94a3b8"}}>Spins Since Last Hit</span>
              <button onClick={()=>updApp(s=>{s.settings.showDroughtCounts=s.settings.showDroughtCounts===false;})} style={{padding:"6px 16px",borderRadius:8,border:"none",background:settings.showDroughtCounts!==false?"#16a34a":"#374151",color:"white",fontSize:12,fontWeight:700,cursor:"pointer"}}>{settings.showDroughtCounts!==false?"ON":"OFF"}</button>
            </div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 16px",borderRadius:10,border:"1px solid #2d4057",background:"#0f1923"}}>
              <span style={{fontSize:13,color:"#94a3b8"}}>Head start for unseen numbers</span>
              <button onClick={()=>updApp(s=>{s.settings.headStartUnseen=s.settings.headStartUnseen!==true;})} style={{padding:"6px 16px",borderRadius:8,border:"none",background:settings.headStartUnseen===true?"#16a34a":"#374151",color:"white",fontSize:12,fontWeight:700,cursor:"pointer"}}>{settings.headStartUnseen===true?"ON":"OFF"}</button>
            </div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 16px",borderRadius:10,border:"1px solid #2d4057",background:"#0f1923"}}>
              <span style={{fontSize:13,color:"#94a3b8"}}>Counter shows</span>
              <button onClick={()=>updApp(s=>{s.settings.counterShows=nextCounterShows(s.settings.counterShows);})} style={{padding:"6px 16px",borderRadius:8,border:"none",background:settings.counterShows==="percentile"?"#16a34a":"#374151",color:"white",fontSize:12,fontWeight:700,cursor:"pointer"}}>{settings.counterShows==="percentile"?"Percentile":"Spins"}</button>
            </div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 16px",borderRadius:10,border:"1px solid #2d4057",background:"#0f1923"}}>
              <span style={{fontSize:13,color:"#94a3b8"}}>Percentile outlines</span>
              <button onClick={()=>updApp(s=>{s.settings.percentileOutlines=s.settings.percentileOutlines===false;})} style={{padding:"6px 16px",borderRadius:8,border:"none",background:settings.percentileOutlines!==false?"#16a34a":"#374151",color:"white",fontSize:12,fontWeight:700,cursor:"pointer"}}>{settings.percentileOutlines!==false?"ON":"OFF"}</button>
            </div>
          </div>
        </Card>
        <Card>
          <FieldLabel>Table Limits</FieldLabel>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {[
              {label:"Min Bet", key:"tableMinBet", color:"#4ade80"},
              {label:"Max Bet (per position)", key:"tableMaxBet", color:"#fbbf24"},
              {label:"Max Total (per spin)", key:"tableMaxTotal", color:"#f87171"},
            ].map(({label,key,color})=>{
              const val=settings[key]||1;
              function dec(){
                if(key==="tableMinBet"){
                  if(val>10)return updApp(s=>{s.settings[key]=val<=100?val-5:val<=1000?val-25:val-1000;});
                  if(val>1)return updApp(s=>{s.settings[key]=val-1;});
                  if(val>0.5)return updApp(s=>{s.settings[key]=0.5;});
                  if(val>0.25)return updApp(s=>{s.settings[key]=0.25;});
                } else {
                  updApp(s=>{s.settings[key]=Math.max(1,val<=10?val-1:val<=100?val-5:val<=1000?val-25:val-1000);});
                }
              }
              function inc(){
                if(key==="tableMinBet"&&val<1)return updApp(s=>{s.settings[key]=val===0.25?0.5:1;});
                updApp(s=>{s.settings[key]=val<10?val+1:val<100?val+5:val<1000?val+25:val+1000;});
              }
              const displayVal=val<1?`${cur.symbol}${val.toFixed(2)}`:val<10?`${cur.symbol}${val}`:val>=1000?`${cur.symbol}${(val/1000).toFixed(val%1000===0?0:1)}K`:`${cur.symbol}${val}`;
              return(
                <div key={key}>
                  <div style={{fontSize:10,color:"#64748b",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>{label}</div>
                  <div style={{display:"flex",alignItems:"center",background:"#0f1923",borderRadius:10,border:"1px solid #2d4057",overflow:"hidden"}}>
                    <button onClick={dec} style={{padding:"8px 14px",background:"transparent",border:"none",color:"#60a5fa",fontSize:18,fontWeight:700,cursor:"pointer"}}>-</button>
                    <div style={{flex:1,textAlign:"center",fontSize:16,fontWeight:800,color}}>{displayVal}</div>
                    <button onClick={inc} style={{padding:"8px 14px",background:"transparent",border:"none",color:"#60a5fa",fontSize:18,fontWeight:700,cursor:"pointer"}}>+</button>
                  </div>
                </div>
              );
            })}
            <div>
              <div style={{fontSize:10,color:"#64748b",textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>Quick Presets</div>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                {TABLE_LIMIT_PRESETS.map((p,i)=>(
                  <button key={i} onClick={()=>updApp(s=>{s.settings.tableMinBet=p.minBet;s.settings.tableMaxBet=p.maxBet;s.settings.tableMaxTotal=p.maxTotal;})} style={{padding:"8px 12px",borderRadius:9,border:"1px solid #2d4057",background:"#0f1923",color:"#94a3b8",fontSize:11,cursor:"pointer",textAlign:"left"}}>{p.label} · max/spin ${p.maxTotal.toLocaleString()}</button>
                ))}
              </div>
            </div>
            <div style={{fontSize:10,color:"#374151",marginTop:2}}>
              Unit bets of $0.25 or $0.50 are only available when your table minimum allows it.
            </div>
          </div>
        </Card>
        <Card>
          <FieldLabel>Info</FieldLabel>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <button onClick={()=>{if(window.confirm("Restart onboarding? Your current bankroll will be your new starting point."))updApp(s=>{const curBankroll=s.currentSession.bankrollCurrent;s.settings.onboarded=false;s.settings._restartBankroll=curBankroll;});}} style={{width:"100%",padding:"12px 0",borderRadius:10,border:"1px solid #7f1d1d",background:"transparent",color:"#f87171",fontSize:13,cursor:"pointer"}}>Restart Onboarding</button>
            <button onClick={importJSON} style={{width:"100%",padding:"12px 0",borderRadius:10,border:"1px solid #2d4057",background:"#0f1923",color:"#60a5fa",fontSize:13,fontWeight:700,cursor:"pointer"}}>📥 Import Session Data</button>
            <button onClick={()=>setHardResetOpen(true)} style={{width:"100%",padding:"14px 0",borderRadius:10,border:"2px solid #991b1b",background:"#200505",color:"#f87171",fontSize:14,fontWeight:900,cursor:"pointer",letterSpacing:0.5}}>⚠️ Hard Reset -- Wipe All Data</button>
          </div>
        </Card>
      </div>
    );
  }
