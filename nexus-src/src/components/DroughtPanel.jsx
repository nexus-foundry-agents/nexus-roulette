// Even-money, dozen and column drought counts. Both play pages render it; moved from App.jsx unchanged.
// Each even-money count shows its percentile beside it (PercentTag, from NumberDrought.jsx); emDroughts[i].pct comes
// from App. dozP and colP are the dozen and column percentiles, in the order of dozD and colD, passed to DCard as
// `pct` (DCard, in ui.jsx, renders it in a reserved row).
function DroughtPanel({emDroughts, dozD, colD, dozP, colP}) {
  return (
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:3}}>
              {emDroughts.map(em=>(
                <div key={em.key} style={{borderRadius:7,border:"1px solid "+(em.drought>=8?"#dc2626":em.drought>=5?"#f59e0b":"#2d4057"),background:em.drought>=8?"#200505":em.drought>=5?"#1c1000":"#0f1923",padding:"6px 2px",textAlign:"center"}}>
                  <div style={{fontSize:9,color:em.color,fontWeight:700,textTransform:"uppercase"}}>{em.label}</div>
                  <div style={{fontSize:15,fontWeight:800,color:em.drought>=8?"#f87171":em.drought>=5?"#fbbf24":"#94a3b8"}}>{em.drought}<PercentTag pct={em.pct}/></div>
                </div>
              ))}
            </div>
            <div style={{borderTop:"1px solid #2d4057",marginTop:2,paddingTop:6,display:"flex",flexDirection:"column",gap:4}}>
              <div style={{display:"flex",gap:4}}>
                {[0,1,2].map(i=><DCard key={"d"+i} label={DOZEN_LABELS[i]} range={DOZEN_RANGES[i]} drought={dozD[i]} pct={dozP&&dozP[i]} colorBd={DOZEN_BORDERS[i]} colorTx={DOZEN_TEXTS[i]}/>)}
              </div>
              <div style={{display:"flex",gap:4}}>
                {[0,1,2].map(i=><DCard key={"c"+i} label={COLUMN_LABELS[i]} range={COLUMN_RANGES[i]} drought={colD[i]} pct={colP&&colP[i]} colorBd={COLUMN_BORDERS[i]} colorTx={COLUMN_TEXTS[i]}/>)}
              </div>
            </div>
          </div>
  );
}
