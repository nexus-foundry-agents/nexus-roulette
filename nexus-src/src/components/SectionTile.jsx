// One dozen or column tile on the drought panel, and the detail view a tap opens (in the shared Modal, ui.jsx).
// The tile is one button that shows all six readings at once, from a sectionReadout (tlv.js). Every row has a fixed
// height and an optional value keeps its slot with visibility, so a value changing never changes the tile's size
// (rule 82). The tile is TILE_H tall; droughtPanelHeight() in DroughtPanel.jsx sums it into the panel's height.
const TILE_H = 152;

// The colour of a percentile tier's badge. Tiers are an ordering, so the colour only steps up with the tier.
const TIER_COLORS = {25: "#94a3b8", 50: "#e2e8f0", 75: "#fbbf24", 95: "#f97316", 98: "#f87171"};

// The short tier text for a tile row, or the widest tier text as a hidden placeholder so the row keeps its width.
function TierText({tier}) {
  const tag = tierTag(tier);
  return (
    <span aria-hidden={tag === "" ? true : undefined}
      style={{display:"inline-block",minWidth:16,fontSize:8,fontWeight:700,color:TIER_COLORS[tier]||"#64748b",visibility:tag === "" ? "hidden" : "visible",textAlign:"left"}}>
      {tag === "" ? "P98" : tag}
    </span>
  );
}

// The corner badge: the highest tier the streak has reached. Its box is always rendered; only its visibility changes.
function CornerBadge({tier}) {
  const tag = tierTag(tier);
  return (
    <span aria-hidden={tag === "" ? true : undefined}
      style={{position:"absolute",top:4,right:4,width:24,height:11,lineHeight:"11px",borderRadius:5,background:"#0f1923",border:"1px solid #2d4057",fontSize:8,fontWeight:800,color:TIER_COLORS[tier]||"#64748b",textAlign:"center",visibility:tag === "" ? "hidden" : "visible"}}>
      {tag === "" ? "P98" : tag}
    </span>
  );
}

// One tile. `r` is a sectionReadout; `onOpen(key)` opens the section's detail view. A tap on the tile is the only action.
function SectionTile({r, onOpen}) {
  const pctText = typeof r.streakPct === "number" ? r.streakPct.toFixed(1) + "%" : "";
  // The coldest row (F18): the coldest number or numbers and their loss level, in gold. Its slot is always rendered. With no
  // coldest number (every loss level 0) only its visibility changes, and the placeholder reserves the same width (rule 82).
  const hasColdest = r.coldest.level > 0;
  const coldestText = hasColdest ? r.coldest.numbers.join(", ") + " · " + r.coldest.level : "00 · 00";
  const coldestAria = hasColdest ? ", coldest " + r.coldest.numbers.join(", ") + " at loss level " + r.coldest.level : "";
  return (
    <button type="button" aria-haspopup="dialog" onClick={() => onOpen(r.key)}
      aria-label={r.label + " " + r.range + ": losing streak " + r.streak + ", TLV " + r.tlv + coldestAria + ". Tap for details."}
      style={{position:"relative",flex:1,minWidth:0,height:TILE_H,boxSizing:"border-box",overflow:"hidden",background:"#1e2d3d",borderRadius:12,padding:"5px 4px",border:"1px solid " + r.colorBd,color:"#e2e8f0",fontFamily:"inherit",textAlign:"center",cursor:"pointer",display:"flex",flexDirection:"column"}}>
      <CornerBadge tier={r.streakTier}/>
      <div style={{height:11,lineHeight:"11px",fontSize:8,color:r.colorTx,fontWeight:700,textTransform:"uppercase",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",paddingRight:24}}>{r.label}</div>
      <div style={{height:9,lineHeight:"9px",fontSize:7,color:"#475569",whiteSpace:"nowrap"}}>{r.range}</div>
      <div style={{height:28,lineHeight:"28px",fontSize:24,fontWeight:900,color:"#e2e8f0"}}>{r.streak}</div>
      <div aria-hidden={pctText === "" ? true : undefined} style={{height:9,lineHeight:"9px",fontSize:8,color:"#64748b",visibility:pctText === "" ? "hidden" : "visible"}}>{pctText || "0.0%"}</div>
      <div style={{height:20,marginTop:2}}>
        <TlvSparkline values={r.windowValues} label={"TLV since the losing streak began: " + r.tlv} color={r.colorTx}/>
      </div>
      <div style={{height:13,lineHeight:"13px",display:"flex",alignItems:"center",justifyContent:"center",gap:3,whiteSpace:"nowrap"}}>
        <span style={{fontSize:7,color:"#64748b",fontWeight:700}}>TLV</span>
        <span style={{fontSize:10,fontWeight:800,color:"#e2e8f0"}}>{r.tlv}</span>
        <TierText tier={r.tlvTier}/>
      </div>
      <div style={{height:13,lineHeight:"13px",display:"flex",alignItems:"center",justifyContent:"center",gap:3,whiteSpace:"nowrap"}}>
        <span style={{fontSize:7,color:"#64748b",fontWeight:700}}>AVG</span>
        <span style={{fontSize:10,fontWeight:800,color:"#e2e8f0"}}>{r.avg.toFixed(1)}</span>
        <TierText tier={r.avgTier}/>
      </div>
      <div style={{height:13,lineHeight:"13px",display:"flex",alignItems:"center",justifyContent:"center",gap:3,whiteSpace:"nowrap"}}>
        <span style={{fontSize:7,color:"#64748b",fontWeight:700}}>MAX</span>
        <span style={{fontSize:10,fontWeight:800,color:"#e2e8f0"}}>{r.max}</span>
        <TierText tier={r.maxTier}/>
      </div>
      <div style={{height:12,lineHeight:"12px",display:"flex",alignItems:"center",justifyContent:"center",gap:3,whiteSpace:"nowrap"}}>
        <span style={{fontSize:7,color:"#64748b",fontWeight:700}}>P95+</span>
        <span style={{fontSize:8,fontWeight:700,color:"#e2e8f0"}}>{r.cold + " of 12"}</span>
      </div>
      <div aria-hidden={hasColdest ? undefined : true} style={{height:10,lineHeight:"10px",display:"flex",alignItems:"center",justifyContent:"center",gap:3,minWidth:0,whiteSpace:"nowrap",visibility:hasColdest ? "visible" : "hidden"}}>
        <span style={{fontSize:7,color:"#64748b",fontWeight:700}}>COLDEST</span>
        <span style={{fontSize:8,fontWeight:800,color:COLDEST_GOLD,minWidth:0,overflow:"hidden",textOverflow:"ellipsis"}}>{coldestText}</span>
      </div>
    </button>
  );
}

// The chart's reference lines: the section type's TLV at P50, P75, P95 and P98, read by percentile from the table.
function tlvReferenceLines(r) {
  const pcts = STREAK_PERCENTILE_DATA.meta.percentiles;
  if (!r.tlvLevels) return [];
  return [50, 75, 95, 98].map((pct) => ({label: "P" + pct, value: r.tlvLevels[pcts.indexOf(pct)]}));
}

// The detail view of one section, inside the shared Modal. Everything in it comes from the same sectionReadout as the tile.
function SectionDetail({r, onClose}) {
  const stats = [
    {name: "Losing streak", value: String(r.streak), pct: r.streakPct, tier: r.streakTier},
    {name: "TLV", value: String(r.tlv), pct: r.tlvPct, tier: r.tlvTier},
    {name: "Average loss level", value: r.avg.toFixed(1), pct: r.avgPct, tier: r.avgTier},
    {name: "Maximum loss level" + (r.maxNumber === null ? "" : " (" + r.maxNumber + ")"), value: String(r.max), pct: r.maxPct, tier: r.maxTier},
  ];
  const shadeText = r.streak > 0 ? "shaded: the current losing streak, " + r.streak + (r.streak === 1 ? " spin" : " spins") : "no losing streak in progress";
  return (
    <div style={{display:"flex",flexDirection:"column",gap:12,color:"#e2e8f0"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
        <div style={{minWidth:0}}>
          <div style={{fontSize:17,fontWeight:800,color:r.colorTx}}>{r.label}</div>
          <div style={{fontSize:12,color:"#64748b"}}>{r.range}</div>
        </div>
        <button type="button" onClick={onClose}
          style={{minHeight:36,padding:"8px 14px",borderRadius:10,border:"1px solid #2d4057",background:"#1e2d3d",color:"#e2e8f0",fontSize:13,fontWeight:700,cursor:"pointer",flexShrink:0}}>Close</button>
      </div>
      <div>
        <div style={{fontSize:11,color:"#64748b",marginBottom:4}}>{"TLV after each spin of this session, " + shadeText + "."}</div>
        <TlvSparkline axes values={r.series} startSpin={1} shadeFrom={r.shadeFrom} refs={tlvReferenceLines(r)}
          label={r.label + " TLV for the session"} width={320} height={170} color={r.colorTx}/>
        <div style={{fontSize:10,color:"#64748b",marginTop:4}}>Dashed lines: this section type's TLV at P50, P75, P95 and P98 on this wheel.</div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
        {stats.map((s) => (
          <div key={s.name} style={{background:"#1e2d3d",borderRadius:10,padding:"8px 8px",minHeight:64,boxSizing:"border-box"}}>
            <div style={{fontSize:10,color:"#64748b",fontWeight:700,textTransform:"uppercase",lineHeight:"14px",height:28,overflow:"hidden"}}>{s.name}</div>
            <div style={{fontSize:20,fontWeight:900,lineHeight:"24px",height:24}}>{s.value}</div>
            <div style={{fontSize:10,color:"#94a3b8",lineHeight:"14px",height:14}}>
              {typeof s.pct === "number" ? s.pct.toFixed(1) + " percentile" : ""}{typeof s.pct === "number" && tierTag(s.tier) ? " (" + tierTag(s.tier) + ")" : ""}
            </div>
          </div>
        ))}
        <div style={{background:"#1e2d3d",borderRadius:10,padding:"8px 8px",minHeight:64,boxSizing:"border-box",gridColumn:"1 / span 2"}}>
          <div style={{fontSize:10,color:"#64748b",fontWeight:700,textTransform:"uppercase",lineHeight:"14px",height:14}}>At or above the single-number P95</div>
          <div style={{fontSize:20,fontWeight:900,lineHeight:"24px",height:24}}>{r.cold + " of 12"}</div>
        </div>
      </div>
      <div>
        <div style={{display:"grid",gridTemplateColumns:"0.8fr 1fr 1.2fr 0.8fr",gap:4,fontSize:10,color:"#64748b",fontWeight:700,textTransform:"uppercase",height:20,lineHeight:"20px",borderBottom:"1px solid #2d4057"}}>
          <div>Number</div><div>Loss level</div><div>Percentile</div><div>Tier</div>
        </div>
        {r.perNumber.map((row) => (
          <div key={row.number} style={{display:"grid",gridTemplateColumns:"0.8fr 1fr 1.2fr 0.8fr",gap:4,fontSize:12,height:24,lineHeight:"24px",borderBottom:"1px solid #1f2937",fontVariantNumeric:"tabular-nums"}}>
            <div style={{fontWeight:700,color:row.gold ? COLDEST_GOLD : undefined}}>{row.number}</div>
            <div style={{color:row.gold ? COLDEST_GOLD : undefined}}>{row.loss}</div>
            <div>{typeof row.pct === "number" ? row.pct.toFixed(1) : ""}</div>
            <div style={{color:TIER_COLORS[row.tier]||"#64748b",fontWeight:700}}>{tierTag(row.tier)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
