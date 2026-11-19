// -- Streak Distribution --
// One table for win and loss streaks (kind is the only difference). Shows
// every length from 1 to the longest streak seen, never a truncated top-N.
// Columns: count, share of all streaks of this kind, share at or beyond this
// length, and share of the spins spent inside streaks of this kind.
function StreakDistribution({kind, rows}) {
  if(!rows || !rows.length) return null;
  const isRaw = kind==="raw";
  const isLoss = kind==="loss" || isRaw;
  const title = isRaw ? "All Loss Streaks From Spin 1" : (isLoss?"Loss":"Win")+" Streak Distribution";
  const note = isRaw
    ? "Every losing run on this strategy's target numbers, counted from the first spin of each session whether or not a bet was placed (drought entry and park rules ignored)."
    : "Counted only on spins the strategy bet.";
  const bar = isRaw ? "#f97316" : isLoss ? "#ef4444" : "#22c55e";
  const txt = isLoss ? "#f87171" : "#4ade80";
  const total = rows.reduce((a,r)=>a+r.count,0);
  const peak = Math.max(...rows.map(r=>r.pct)) || 1;
  const head = {fontSize:8,color:"#64748b",textAlign:"right"};
  const cell = {fontSize:9,textAlign:"right",fontVariantNumeric:"tabular-nums"};
  const grid = {display:"grid",gridTemplateColumns:"22px minmax(0,1fr) 40px 42px 42px 42px",alignItems:"center",gap:6};
  return (
    <div style={{marginBottom:10}} data-streak-dist={kind}>
      <div style={{fontSize:10,color:"#64748b",textTransform:"uppercase",letterSpacing:1,marginBottom:2}}>
        {title}
      </div>
      <div style={{fontSize:9,color:"#475569",marginBottom:6,lineHeight:1.4}}>
        {total} {isLoss?"loss":"win"} streaks across all sessions, lengths 1 to {rows.length} in a row. {note} Streaks end at the session end.
      </div>
      <div style={{...grid,marginBottom:3}}>
        <div style={head}>Len</div><div/>
        <div style={head}>Count</div>
        <div style={head}>% streaks</div>
        <div style={head}>≥ len</div>
        <div style={head}>% spins</div>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:2}}>
        {rows.map(({len,count,pct,atLeastPct,spinPct})=>(
          <div key={len} style={grid}>
            <div style={{...cell,color:"#64748b"}}>{len}</div>
            <div style={{height:10,background:"#1e2d3d",borderRadius:4,overflow:"hidden"}}>
              <div style={{height:"100%",background:bar,borderRadius:4,width:`${Math.min(100,pct/peak*100)}%`}}/>
            </div>
            <div style={{...cell,color:"#94a3b8"}}>{count}</div>
            <div style={{...cell,color:txt}}>{pct.toFixed(pct>0&&pct<0.1?2:1)}%</div>
            <div style={{...cell,color:"#94a3b8"}}>{atLeastPct.toFixed(atLeastPct>0&&atLeastPct<0.1?2:1)}%</div>
            <div style={{...cell,color:"#94a3b8"}}>{spinPct.toFixed(spinPct>0&&spinPct<0.1?2:1)}%</div>
          </div>
        ))}
      </div>
    </div>
  );
}
