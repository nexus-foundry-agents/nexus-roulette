// -- Base bet (F16): the one control for a track's base size, in the track setup and in Edit Config --
// A track's base is config.unit: the money one chip is worth. The presets apply on one tap. The Custom field applies on blur
// or Enter. A value that cannot be applied shows its reason and keeps the amount already applied; nothing is clamped or
// truncated. The preview is the track's own table at the applied base (computeTableForTrack and formatChips), so it reads
// the same as the progression table the track shows once it is added.
// Both panels mount BaseBetInput (rule 80). An Edit Config save parks the track and starts a new one (App.jsx updateTrackConfig),
// so a base is never re-priced in place. Everything below BaseBetInput except the component is pure.

const BASE_MAX = 10000;      // the highest base, in the session's currency; the field states it
const BASE_PREVIEW_H = 180;  // the preview box has this height whether or not it has rows (rule 82)
const BASE_PREVIEW_GRID = "34px 1fr 1fr 1fr";

// The lowest base in a currency: 0.01, or 1 where the currency has no minor unit (JPY, KRW, ARS).
function baseFloor(cur) { return cur.dec === 0 ? 1 : 0.01; }

// The base's range for the shared parser (money-parse.js): baseFloor to BASE_MAX in the session's currency.
function baseRange(cur) { return {min: baseFloor(cur), max: BASE_MAX, noun: "base"}; }

// Whether a base sits under the table minimum. With no minimum nothing is under it.
function baseBelowTableMin(unit, tableMinBet) { const min = tableMinimum(tableMinBet); return min !== null && unit < min; }

// The reason a base under the table minimum is refused, in the session's currency. It names both ways out.
function baseBelowMessage(tableMinBet, currency) {
  return "This base bet is below your table minimum of " + formatMoney(tableMinimum(tableMinBet), currency) + ". Change the bet size, or change the table limit in Settings.";
}

// The base-bet control. config is the track's config as the panel holds it; config.unit is the applied base.
function BaseBetInput({type, config, currency, tableMinBet, onChange}) {
  const cur = getCurrency(currency || "USD");
  const unit = config.unit || 1;
  const CLIP = {whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis"};
  const [text, setText] = useState(String(unit));
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState("");
  // The field shows the applied base whenever it is not being typed in. A refused value keeps its text, because the base did not change.
  useEffect(() => { if(!focused) setText(String(unit)); }, [unit]);
  // A refusal is about the minimum it was made against, so a changed minimum clears it.
  useEffect(() => { setError(""); }, [tableMinBet]);

  // A base under the table minimum is refused: it is not applied, the previous base stays, and the reason shows under the field.
  function apply(v) {
    if(baseBelowTableMin(v, tableMinBet)) { setError(baseBelowMessage(tableMinBet, currency)); return; }
    setError("");
    onChange(v);
  }
  function commit(str) {
    const r = parseMoneyAmount(str, currency, baseRange(cur));
    if(r.ok) apply(r.value);
    else setError(r.reason);
  }

  // The preview is the track's own table at the applied base. A Progression Bet with no target, or a Custom Bet with no
  // spot, has no table yet; the box says what it is waiting for.
  const noTarget = type === "fibonacci" && ((config.dozenTargets || []).length + (config.colTargets || []).length + (config.evenTargets || []).length) === 0;
  const noSpot = type === "custom" && (config.positions || []).length === 0;
  const emptyWhy = noTarget ? "Pick a target to see the levels." : noSpot ? "Add a spot to see the levels." : "";
  const rows = emptyWhy ? [] : computeTableForTrack({type, config: {...config, unit}});
  // The one reserved line under the field: the reason a value was refused, or, when the applied base is under a minimum raised
  // since it was set, the same reason for the applied base.
  const below = baseBelowTableMin(unit, tableMinBet);
  const note = error || (below ? baseBelowMessage(tableMinBet, currency) : "");
  const floorText = cur.symbol + baseFloor(cur).toFixed(cur.dec);
  const topText = cur.symbol + "10,000";
  const money = v => formatChips(v, unit, currency);

  return (
    <div style={{display:"flex", flexDirection:"column", gap:8}}>
      <div>
        <FieldLabel>Base bet per chip</FieldLabel>
        <div style={{display:"flex", flexWrap:"wrap", gap:6}}>
          {UNITS.map(u => {
            const sel = unit === u;
            return (
              <button key={u} onClick={() => apply(u)} style={{flex:"1 1 56px", padding:"8px 0", borderRadius:9, border:"2px solid "+(sel?"#86efac":"#2d4057"), background:sel?"#134e2a":"#0f1923", color:sel?"#86efac":"#64748b", fontSize:12, fontWeight:700, cursor:"pointer"}}>{cur.symbol}{u.toFixed(2)}</button>
            );
          })}
        </div>
      </div>
      <div>
        <FieldLabel>Custom amount</FieldLabel>
        <div style={{display:"flex", alignItems:"center", background:"#0f1923", borderRadius:12, border:"1px solid "+(error?"#f87171":"#2d4057"), overflow:"hidden"}}>
          <div style={{padding:"0 14px", fontSize:18, color:"#64748b", fontWeight:700}}>{cur.symbol}</div>
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label="Custom base amount"
            aria-invalid={error ? "true" : "false"}
            value={text}
            onChange={e => setText(e.target.value)}
            onFocus={e => { setFocused(true); e.target.select(); }}
            onBlur={() => { setFocused(false); commit(text); }}
            onKeyDown={e => { if(e.key === "Enter") commit(text); }}
            style={{flex:1, minWidth:0, padding:"10px 0", fontSize:18, fontWeight:800, color:"#86efac", background:"transparent", border:"none", outline:"none"}}
          />
        </div>
        <div aria-hidden={!note} style={{minHeight:14, marginTop:4, fontSize:10, color:error?"#f87171":"#fbbf24", visibility:note?"visible":"hidden"}}>{note || " "}</div>
        <div style={{fontSize:10, color:"#64748b"}}>{floorText + " to " + topText + (cur.dec > 0 ? ", up to 2 decimals" : ", whole amounts")}</div>
      </div>
      <div>
        <FieldLabel>Table at this base</FieldLabel>
        <div style={{background:"#0f1923", borderRadius:9, border:"1px solid #2d4057", padding:"6px 8px"}}>
          <div style={{display:"grid", gridTemplateColumns:BASE_PREVIEW_GRID, gap:4, fontSize:8, color:"#64748b", fontWeight:700, textTransform:"uppercase", marginBottom:4}}>
            <span style={{textAlign:"center"}}>Level</span>
            <span style={{textAlign:"right"}}>Bet per spin</span>
            <span style={{textAlign:"right"}}>Total invested</span>
            <span style={{textAlign:"right"}}>Bankroll needed</span>
          </div>
          <div style={{height:BASE_PREVIEW_H, overflowY:"auto", overflowX:"hidden"}}>
            {rows.length === 0 ? (
              <div style={{fontSize:10, color:"#64748b", padding:"6px 0"}}>{emptyWhy || "No level fits under this stop loss."}</div>
            ) : rows.map(r => (
              <div key={r.level} style={{display:"grid", gridTemplateColumns:BASE_PREVIEW_GRID, gap:4, fontSize:10, fontWeight:600, padding:"2px 0"}}>
                <span style={{textAlign:"center", fontWeight:800, color:"#94a3b8"}}>{r.level}</span>
                <span style={{...CLIP, textAlign:"right", color:"#60a5fa"}}>{money(r.totalBet)}</span>
                <span style={{...CLIP, textAlign:"right", color:"#f87171"}}>{money(r.totalInvest)}</span>
                <span style={{...CLIP, textAlign:"right", color:"#a78bfa"}}>{money(r.totalInvest)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
