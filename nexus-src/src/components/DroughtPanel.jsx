// Even-money, dozen and column drought readings. Both play pages render it (App.jsx and GamePage.jsx). Each even-money
// count shows its percentile beside it (PercentTag, from NumberDrought.jsx); emDroughts[i].pct comes from App.
// Each dozen and column is a SectionTile (SectionTile.jsx) built from sectionReadout (tlv.js). Its losing streak and
// streak percentile come from App (dozD, dozP, colD, colP); its TLV, average, maximum and count at P95 come from the
// session's spins and droughts. Tapping a tile opens its detail view in the shared Modal (ui.jsx).
// The panel's height is the sum of its fixed rows (droughtPanelHeight). SpinTools.jsx's DROUGHT_PANEL_HEIGHT must equal
// it, and a test holds the two together.
const EM_CELL_H = 44;
const PANEL_GAP = 6;
const SECTION_RULE_GAP = 2;
const SECTION_RULE = 1;
const SECTION_PAD_TOP = 6;
const TILE_ROW_GAP = 4;

// The panel's height in px, from its fixed rows: the even-money row, the gap under it, the section block's top margin,
// rule and padding, the two tile rows and the gap between them.
function droughtPanelHeight() {
  return EM_CELL_H + PANEL_GAP + SECTION_RULE_GAP + SECTION_RULE + SECTION_PAD_TOP + 2 * TILE_H + TILE_ROW_GAP;
}

function DroughtPanel({emDroughts, dozD, colD, dozP, colP, spins, droughts, roulette}) {
  const [openKey, setOpenKey] = useState(null);
  const wheel = roulette || "american";
  const readouts = useMemo(() => {
    const out = [];
    ["dozen", "column"].forEach((kind) => {
      const streaks = kind === "dozen" ? dozD : colD;
      const pcts = kind === "dozen" ? dozP : colP;
      for (let i = 0; i < 3; i++) {
        out.push(sectionReadout({
          kind, index: i, wheel,
          spins: spins || [], droughts: droughts || {},
          streak: streaks ? streaks[i] || 0 : 0,
          streakPct: pcts ? pcts[i] : undefined,
        }));
      }
    });
    return out;
  }, [spins, droughts, wheel, dozD, colD, dozP, colP]);
  const open = openKey ? readouts.filter((r) => r.key === openKey)[0] : null;
  const close = () => setOpenKey(null);
  return (
    <div style={{display:"flex",flexDirection:"column",gap:PANEL_GAP}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gridAutoRows:EM_CELL_H,gap:3}}>
        {emDroughts.map(em=>(
          <div key={em.key} style={{boxSizing:"border-box",display:"flex",flexDirection:"column",justifyContent:"center",borderRadius:7,border:"1px solid "+(em.drought>=8?"#dc2626":em.drought>=5?"#f59e0b":"#2d4057"),background:em.drought>=8?"#200505":em.drought>=5?"#1c1000":"#0f1923",padding:"2px 2px",textAlign:"center"}}>
            <div style={{fontSize:9,color:em.color,fontWeight:700,textTransform:"uppercase"}}>{em.label}</div>
            <div style={{fontSize:15,fontWeight:800,color:em.drought>=8?"#f87171":em.drought>=5?"#fbbf24":"#94a3b8"}}>{em.drought}<PercentTag pct={em.pct}/></div>
          </div>
        ))}
      </div>
      <div style={{borderTop:"1px solid #2d4057",marginTop:SECTION_RULE_GAP,paddingTop:SECTION_PAD_TOP,display:"flex",flexDirection:"column",gap:TILE_ROW_GAP}}>
        <div style={{display:"flex",gap:4}}>
          {readouts.slice(0,3).map(r=><SectionTile key={r.key} r={r} onOpen={setOpenKey}/>)}
        </div>
        <div style={{display:"flex",gap:4}}>
          {readouts.slice(3,6).map(r=><SectionTile key={r.key} r={r} onOpen={setOpenKey}/>)}
        </div>
      </div>
      {open && (
        <Modal fullScreen onClose={close}>
          <SectionDetail r={open} onClose={close}/>
        </Modal>
      )}
    </div>
  );
}
