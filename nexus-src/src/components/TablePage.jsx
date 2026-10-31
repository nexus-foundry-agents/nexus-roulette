// -- Full table page --
// Moved from App.jsx unchanged. App renders it through a wrapper that passes the App values it reads.

// Per-spot card for a Custom Bet track. Its spot list is sized for the track's number of positions, and every
// spot row has a fixed height, so the card's box depends only on how many positions there are, never on the
// level selected or on how long a value is (rule 82).
const SPOT_ROW_H = 30; // one spot: a label line and a values line
const SPOT_GAP = 4;
function spotListHeight(n) { return n*SPOT_ROW_H + (n-1)*SPOT_GAP; }

// The per-spot numbers for one level: a title, column captions, then one row per position.
// positions and row are only read; computeSpotBreakdown never writes to them.
function SpotCard({positions, row, unit, cur}) {
  const n = Math.max(positions.length, 1);
  const spots = row ? computeSpotBreakdown(positions, row, unit) : [];
  const money = v => cur.symbol+v.toFixed(cur.dec);
  const signed = v => (v>=0?"+":"-")+cur.symbol+Math.abs(v).toFixed(cur.dec);
  const clip = {whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"};
  return (
    <div data-spot-card="" style={{background:"#0f1923",borderRadius:8,padding:"6px 8px",marginBottom:8,border:"1px solid #2d4057",boxSizing:"border-box",display:"flex",flexDirection:"column",gap:SPOT_GAP,overflow:"hidden"}}>
      <div style={{...clip,fontSize:9,fontWeight:800,color:"#94a3b8",height:12,lineHeight:"12px"}}>{row?`Level ${row.level} - per spot`:"Per spot"}</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:SPOT_GAP,...clip,fontSize:8,color:"#64748b",height:10,lineHeight:"10px"}}>
        <span>Bet per spot</span><span>Payout if it hits</span><span>Net if it hits</span>
      </div>
      <div data-spot-rows="" style={{height:spotListHeight(n),display:"flex",flexDirection:"column",gap:SPOT_GAP,overflow:"hidden"}}>
        {spots.map((s,i) => {
          const d = betPositionLabel(positions[i]);
          return (
            <div key={i} data-spot-row="" style={{height:SPOT_ROW_H,display:"flex",flexDirection:"column",justifyContent:"center",overflow:"hidden",flexShrink:0}}>
              <div style={{...clip,fontSize:10,fontWeight:800,color:d.color,height:14,lineHeight:"14px"}}>{d.label}{d.detail?" "+d.detail:""}</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:SPOT_GAP,fontSize:10,fontWeight:700,height:14,lineHeight:"14px"}}>
                <span style={{...clip,color:"#60a5fa"}}>{money(s.betPerSpot)}</span>
                <span style={{...clip,color:"#a78bfa"}}>{money(s.payout)}</span>
                <span style={{...clip,color:s.net>=0?"#4ade80":"#f97316"}}>{signed(s.net)}</span>
              </div>
            </div>
          );
        })}
        {spots.length===0 && <div style={{...clip,fontSize:9,color:"#64748b"}}>{positions.length===0?"Add a spot to see its numbers":"No level to show yet"}</div>}
      </div>
    </div>
  );
}

// TablePageView has no hooks: the selected Custom Bet level lives in App (selectedLevel), so this view can be
// called as a plain function and its tree inspected in tests.
function TablePageView({sess, selectedTrackId, setSelectedTrackId, nonClosedTracks, cur, selectedLevel, setSelectedLevel}) {
    const selTrack = sess.tracks.find(t=>t.id===selectedTrackId) || nonClosedTracks[0] || null;
    if(!selTrack) return <div style={{background:"#1e2d3d",borderRadius:14,padding:"30px 20px",textAlign:"center",border:"1px dashed #2d4057",color:"#64748b",fontSize:13}}>Add a track to see the progression table</div>;
    const tbl = computeTableForTrack(selTrack);
    const hasMix = selTrack.type==="fibonacci"&&(selTrack.config.dozenTargets||[]).length>0&&(selTrack.config.colTargets||[]).length>0;
    const isCustom = selTrack.type==="custom";
    const unit = selTrack.config.unit||1;
    // The level the card shows: the one selected for this track, otherwise the track's current level. A selection
    // made on another track is ignored, so it never carries over.
    const curIdx = Math.min(Math.max(selTrack.level||0,0), tbl.length-1);
    const picked = selectedLevel && selectedLevel.trackId===selTrack.id ? selectedLevel.index : null;
    const selIdx = picked!==null ? Math.min(picked, tbl.length-1) : curIdx;
    const selRow = isCustom && selIdx>=0 ? tbl[selIdx] : null;
    const pickLevel = i => setSelectedLevel({trackId:selTrack.id, index:i});
    const headers = hasMix ? ["#","Bet","Invested","PW Ret","PW Profit","JP Ret","JP Profit"] : ["#","Bet",isCustom?"Bankroll needed":"Invested","Return","Profit","ROI"];
    const hColors = ["#94a3b8","#60a5fa","#f87171","#a78bfa","#4ade80","#fbbf24","#fbbf24"];
    const gridCols = hasMix ? "22px 1fr 1fr 1fr 1fr 1fr 1fr" : "22px 1fr 1fr 1fr 1fr 1fr";
    const legendRows = hasMix
      ? [["#","Level #"],["Bet","Total wagered this spin"],["Invested","Cumulative total spent"],["PW Ret","Return if 1 bet hits"],["PW Profit","Profit on partial win"],["JP Ret","Return if dozen AND column hit"],["JP Profit","Profit on jackpot"]]
      : isCustom
        ? [["#","Level #"],["Bet","Total bet on all spots this spin"],["Bankroll needed","Cumulative stake: the bankroll needed to play up to this level"],["Return","Gross payout if you win"],["Profit","Net profit after all invested"],["ROI","Profit divided by invested"],["Tap a level","Shows its per-spot numbers above"]]
        : [["#","Level #"],["Bet","Total wagered this spin"],["Invested","Cumulative total spent"],["Return","Gross payout if you win"],["Profit","Net profit after all invested"],["ROI","Profit divided by invested"]];

    return (
      <div style={{display:"flex",flexDirection:"column",gap:10,width:"100%"}}>
        {nonClosedTracks.length>1 && (
          <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:4}}>
            {nonClosedTracks.map(t => (
              <button key={t.id} onClick={()=>setSelectedTrackId(t.id)} style={{padding:"7px 12px",borderRadius:9,border:"2px solid "+(selectedTrackId===t.id?t.color:"#2d4057"),background:selectedTrackId===t.id?"#0f1923":"transparent",color:selectedTrackId===t.id?t.color:"#64748b",fontSize:11,fontWeight:700,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0}}>
                {TRACK_ICONS[t.type]} {betTargetText(t.type,t.config,false,2)}
              </button>
            ))}
          </div>
        )}
        <Card>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
            <div style={{width:10,height:10,borderRadius:"50%",background:selTrack.color,flexShrink:0}}/>
            <span style={{fontSize:11,fontWeight:700,color:selTrack.color}}>{TRACK_ICONS[selTrack.type]} {selTrack.type==="fibonacci"?"Progression Bet":selTrack.type==="custom"?"Custom Bet":"The Solution"}</span>
          </div>
          <BetTargets type={selTrack.type} config={selTrack.config} style={{marginBottom:4}}/>
          <div style={{fontSize:10,color:"#64748b",marginBottom:8}}>
            {selTrack.config.roi}% ROI · {tbl.length} levels · {cur.symbol}{selTrack.config.stopLoss} stop
          </div>
          <div style={{background:"#0f1923",borderRadius:8,padding:"8px 10px",marginBottom:8,border:"1px solid #2d4057",display:"flex",flexDirection:"column",gap:3}}>
            {legendRows.map(([abbr,desc]) => (
              <div key={abbr} style={{display:"flex",gap:6}}>
                <span style={{fontSize:9,fontWeight:800,color:"#86efac",minWidth:55}}>{abbr}</span>
                <span style={{fontSize:9,color:"#475569"}}>{desc}</span>
              </div>
            ))}
          </div>
          {isCustom && <SpotCard positions={selTrack.config.positions||[]} row={selRow} unit={unit} cur={cur}/>}
          <div style={{display:"grid",gridTemplateColumns:gridCols,gap:2,marginBottom:4}}>
            {headers.map((c,i) => <div key={c} style={{fontSize:8,color:hColors[i],textTransform:"uppercase",textAlign:i===0?"center":"right",fontWeight:700}}>{c}</div>)}
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:2,maxHeight:"55vh",overflowY:"auto"}}>
            {tbl.map((r,i) => {
              const isA=i===selTrack.level, isP=i<selTrack.level, isSel=isCustom&&i===selIdx;
              const pw=3*r.c-r.totalInvest, jp=hasMix?6*r.c-r.totalInvest:null;
              const cols = hasMix
                ? [cur.symbol+(r.totalBet*unit).toFixed(cur.dec),cur.symbol+(r.totalInvest*unit).toFixed(cur.dec),cur.symbol+(3*r.c*unit).toFixed(cur.dec),(pw*unit>=0?"+":"-")+cur.symbol+Math.abs(pw*unit).toFixed(cur.dec),cur.symbol+(6*r.c*unit).toFixed(cur.dec),jp!==null?(jp*unit>=0?"+":"-")+cur.symbol+Math.abs(jp*unit).toFixed(cur.dec):"--"]
                : [cur.symbol+(r.totalBet*unit).toFixed(cur.dec),cur.symbol+(r.totalInvest*unit).toFixed(cur.dec),cur.symbol+(r.ret*unit).toFixed(cur.dec),(r.profit*unit>=0?"+":"-")+cur.symbol+Math.abs(r.profit*unit).toFixed(cur.dec),r.roi.toFixed(1)+"%"];
              const rowColors = hasMix ? ["#60a5fa","#f87171","#a78bfa",pw>=0?"#4ade80":"#f97316","#fbbf24",jp!==null&&jp>=0?"#fbbf24":"#f87171"] : ["#60a5fa","#f87171","#a78bfa",r.profit>=0?"#4ade80":"#f97316","#86efac"];
              // The selected Custom Bet row takes the active row's highlight, plus an inset outline so the two can be told apart.
              return (
                <div key={r.level} data-level={isCustom?r.level:undefined} onClick={isCustom?()=>pickLevel(i):undefined} role={isCustom?"button":undefined} tabIndex={isCustom?0:undefined} aria-pressed={isCustom?isSel:undefined} onKeyDown={isCustom?(e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();pickLevel(i);}}):undefined} style={{display:"grid",gridTemplateColumns:gridCols,gap:2,padding:"5px 4px",borderRadius:6,background:isA?"#134e2a":isP?"#0f1923":"transparent",border:"1px solid "+(isA?"#4ade80":isP?"#1e2d3d":"#2d4057"),opacity:isP?0.4:1,...(isCustom?{cursor:"pointer"}:{}),...(isSel?{background:"#134e2a",border:"1px solid #4ade80",opacity:1,outline:"2px solid #e2e8f0",outlineOffset:"-2px"}:{})}}>
                  <div style={{textAlign:"center",fontWeight:800,fontSize:10,color:isA?"#4ade80":r.level>=10?"#f87171":r.level>=6?"#fbbf24":"#94a3b8"}}>{r.level}</div>
                  {cols.map((v,ci) => <div key={ci} style={{textAlign:"right",fontSize:9,color:rowColors[ci],fontWeight:600}}>{v}</div>)}
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    );
}
