// -- The Solution picker: the coldest numbers, to choose the one number a track chases --
// One component for every surface that picks a Solution number: the track setup (AddTrackPanel), the Solution panel and the
// candidate card. A surface differs only in what a tap does (onChoose) and in its parameters (threshold, count, ring colour).
// Read only: it reads droughts and writes nothing. Its rows come from engine.js (solutionColdest, solutionPickRow).

// The colour of a percentile tier's tag in the picker: P75 green, P95 yellow, P98 red. P25 and P50 stay grey. These are the
// brief's colours; the drought tiles (SectionTile TIER_COLORS) use other ones. See the CHANGELOG Open list.
const SOL_PICK_TIER_COLORS = {75: "#4ade80", 95: "#facc15", 98: "#f87171"};

function SolutionPicker({droughts, wheel, threshold, count, chosen, color, onChoose}) {
  const d = droughts || {};
  const ring = color || "#60a5fa";
  const rows = solutionColdest(d, getWheelNumbers(wheel), count || 6).map(n => solutionPickRow(d, wheel, threshold, n));
  return (
    <div style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:5}}>
      {rows.map(r => {
        const isChosen = chosen === r.number;
        const tag = tierTag(r.tier);
        return (
          <button key={r.number} onClick={() => onChoose(r.number)} aria-pressed={isChosen}
            style={{padding:"7px 4px",borderRadius:9,cursor:"pointer",textAlign:"center",minWidth:0,
              background:isChosen?"#0d2a0d":r.inRange?"#1c1000":"#0f1923",
              border:(isChosen?"2":"1")+"px solid "+(isChosen?ring:r.inRange?"#f59e0b":"#2d4057")}}>
            <div style={{fontSize:14,fontWeight:900,color:RED.has(+r.number)?"#f87171":"#f1f5f9"}}>{r.number}</div>
            <div style={{fontSize:9,color:"#94a3b8",fontWeight:700}}>{r.misses} misses</div>
            <div aria-hidden={tag === "" ? true : undefined}
              style={{fontSize:8,fontWeight:800,height:10,lineHeight:"10px",color:SOL_PICK_TIER_COLORS[r.tier]||"#94a3b8",visibility:tag === "" ? "hidden" : "visible"}}>
              {tag === "" ? "P99" : tag}
            </div>
            <div aria-hidden={r.inRange ? undefined : true}
              style={{fontSize:8,fontWeight:700,height:10,lineHeight:"10px",color:"#fbbf24",visibility:r.inRange ? "visible" : "hidden"}}>
              in range
            </div>
          </button>
        );
      })}
    </div>
  );
}
