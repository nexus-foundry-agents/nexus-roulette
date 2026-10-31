// -- Sessions browser sheet (F13): saved sessions by day, one-tap filters, resume (the current session is saved first),
// rename, and the Catch up card. Opened from Stats (StatsPage in SecondaryPages.jsx). One shared Modal; its views swap inside it:
// list, confirm (unsaved spins), rename, catch-up. The pure logic is in sessions-browse.js and session.js. --
function SessionsChip({active, onClick, children}) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}
      style={{padding:"6px 10px",borderRadius:16,border:"1px solid "+(active?"#60a5fa":"#2d4057"),background:active?"#0c1a2e":"#1e2d3d",color:active?"#60a5fa":"#94a3b8",fontSize:11,fontWeight:700,cursor:"pointer",maxWidth:"100%",overflowWrap:"anywhere",textAlign:"left"}}>
      {children}
    </button>
  );
}

// One saved session. The Current mark and the Resume button keep their space on every row (rule 82): only visibility changes.
function SessionsRow({session, isCurrent, cur, onResume, onRename}) {
  const row = sessionRow(session);
  const pnlText = (row.pnl>=0?"+":"-")+cur.symbol+Math.abs(row.pnl).toFixed(cur.dec);
  return (
    <div style={{background:"#0f1923",borderRadius:10,padding:"10px 12px",border:"1px solid "+(isCurrent?"#86efac":"#2d4057"),minWidth:0}}>
      <div style={{display:"flex",alignItems:"baseline",gap:8,minWidth:0}}>
        <div style={{flex:"1 1 0",minWidth:0,fontSize:13,fontWeight:700,color:isCurrent?"#86efac":"#e2e8f0",overflowWrap:"anywhere"}}>{row.title}</div>
        <span aria-hidden={!isCurrent} style={{flex:"0 0 auto",fontSize:10,fontWeight:800,color:"#86efac",textTransform:"uppercase",letterSpacing:1,visibility:isCurrent?"visible":"hidden"}}>Current</span>
      </div>
      <div style={{fontSize:11,color:row.hasVenue?"#cbd5e1":"#64748b",minHeight:16,marginTop:3,overflowWrap:"anywhere"}}>{row.venue}</div>
      <div style={{display:"flex",flexWrap:"wrap",alignItems:"baseline",gap:"2px 10px",fontSize:11,color:"#64748b",marginTop:4}}>
        <span>{row.mode==="game"?"Game":"Live"}</span>
        <span>{row.startTime}</span>
        <span>{row.duration}</span>
        <span>{row.spins+(row.spins===1?" spin":" spins")}</span>
        <span style={{fontWeight:800,color:row.pnl>=0?"#4ade80":"#f87171",fontVariantNumeric:"tabular-nums"}}>{pnlText}</span>
      </div>
      <div style={{display:"flex",gap:8,marginTop:8,minWidth:0}}>
        <button type="button" onClick={()=>onRename(session)} style={{flex:"0 0 auto",padding:"7px 12px",borderRadius:8,border:"1px solid #2d4057",background:"#1e2d3d",color:"#60a5fa",fontSize:12,cursor:"pointer"}}>Rename</button>
        <button type="button" aria-hidden={isCurrent} onClick={()=>onResume(session)} style={{flex:"1 1 0",minWidth:0,padding:"7px 0",borderRadius:8,border:"1px solid #2d4057",background:"#1e2d3d",color:"#94a3b8",fontSize:12,cursor:"pointer",visibility:isCurrent?"hidden":"visible"}}>Resume</button>
      </div>
    </div>
  );
}

function SessionsPage({saved, sess, cur, initialResumeId, onResume, onRename, onAddNumbers, readPhoto, onClose}) {
  const [view, setView] = useState("list"); // "list" | "confirm" | "rename" | "catchup"
  const [target, setTarget] = useState(null); // the saved session the confirm, rename or catch-up is about
  const [filters, setFilters] = useState(ALL_FILTERS);
  const [draft, setDraft] = useState("");
  const [bulk, setBulk] = useState("");
  const [note, setNote] = useState("");
  const started = React.useRef(false);
  const now = Date.now();
  // The live session replaces its saved copy, so its row shows its numbers as they are now.
  const list = (saved||[]).map(s => (sess && s.id === sess.id ? sess : s));
  const options = filterOptions(list);
  const groups = dayGroups(filterSessions(list, filters, now), now);
  const shown = groups.reduce((n, g) => n + g.sessions.length, 0);
  const unsaved = sess ? unsavedSpinCount(sess, saved) : 0;
  const currentName = sess ? sessionRow(sess).title : "";
  const targetName = target ? sessionRow(target).title : "";
  const parsed = parseBulkNumbers(bulk, sess ? sess.roulette : "american", BOARD_MAX_NUMBERS);
  // The Catch up card is about the session just resumed: it is the current session once the resume has landed.
  const resumed = target && sess && sess.id === target.id ? sess : null;
  const resumedLive = !!resumed && savedSessionMode(resumed) === "live";

  function doResume(s) {
    onResume(s.id);
    setTarget(s);
    setBulk("");
    setNote("");
    setView("catchup");
  }
  // Switching away from a session with unsaved spins asks first. Otherwise the resume runs at once.
  function askResume(s) {
    setTarget(s);
    const step = resumeStep(sess, saved, s.id);
    if(step === "confirm") setView("confirm");
    else if(step === "resume") doResume(s);
  }
  // A resume from Stats opens the sheet already on the resume of that session.
  React.useEffect(() => {
    if(started.current || !initialResumeId) return;
    started.current = true;
    const s = list.find(x => x.id === initialResumeId);
    if(s && (!sess || s.id !== sess.id)) askResume(s);
  }, []);

  function openRename(s) {
    setTarget(s);
    setDraft(normalizeLabel(s.label) || "");
    setView("rename");
  }
  function saveRename(e) {
    e.preventDefault();
    onRename(target.id, draft);
    setView("list");
  }
  function addCatchUp() {
    if(!parsed.ok) return;
    const count = parsed.numbers.length;
    onAddNumbers(parsed.numbers.slice());
    setNote(count + (count === 1 ? " spin" : " spins") + " entered, oldest first.");
    setBulk("");
  }
  function pick(key, value) { setFilters(f => ({...f, [key]: value})); }

  const filterGroups = [
    {key:"casino", title:"Casino", chips:[{label:"All", value:null}].concat(options.casino.map(v => ({label:v, value:v}))), none:"No casino recorded"},
    {key:"place", title:"Machine or table", chips:[{label:"All", value:null}].concat(options.place.map(v => ({label:v, value:v}))), none:"No machine or table recorded"},
    {key:"dealer", title:"Dealer", chips:[{label:"All", value:null}].concat(options.dealer.map(v => ({label:v, value:v}))), none:"No dealer recorded"},
    {key:"period", title:"Period", chips:[{label:"This week", value:"week"}, {label:"All", value:"all"}], none:""},
  ];

  const titles = {list:"Sessions", confirm:"Switch sessions?", rename:"Rename session", catchup:"Catch up"};

  function listBody() {
    return (
      <div style={{display:"flex",flexDirection:"column",gap:12,minWidth:0}}>
        {filterGroups.map(g => (
          <div key={g.key} style={{minWidth:0}}>
            <div style={{fontSize:10,color:"#64748b",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>{g.title}</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:6,minHeight:30,alignItems:"center",minWidth:0}}>
              {g.chips.map(c => <SessionsChip key={String(c.value)} active={filters[g.key]===c.value} onClick={()=>pick(g.key,c.value)}>{c.label}</SessionsChip>)}
            </div>
            <div style={{fontSize:11,color:"#475569",minHeight:14,visibility:g.key!=="period"&&g.chips.length===1?"visible":"hidden"}}>{g.none}</div>
          </div>
        ))}
        <div style={{fontSize:11,color:"#64748b",minHeight:14}}>{shown+" of "+list.length+(list.length===1?" session":" sessions")}</div>
        {groups.length===0 && (
          <div style={{textAlign:"center",padding:"16px 0",color:"#475569",fontSize:12}}>
            {list.length===0 ? "No saved sessions yet. Use Save on the Stats page." : "No sessions match these filters."}
          </div>
        )}
        {groups.map(g => (
          <div key={g.key} style={{minWidth:0}}>
            <div style={{fontSize:10,color:"#64748b",textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>{g.label}</div>
            <div style={{display:"flex",flexDirection:"column",gap:6,minWidth:0}}>
              {g.sessions.map(s => (
                <SessionsRow key={s.id} session={s} isCurrent={!!sess && s.id===sess.id} cur={cur} onResume={askResume} onRename={openRename}/>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  function confirmBody() {
    return (
      <div style={{display:"flex",flexDirection:"column",gap:12,minWidth:0}}>
        <div style={{fontSize:13,color:"#e2e8f0",lineHeight:"18px",overflowWrap:"anywhere"}}>
          {currentName+" has "+unsaved+(unsaved===1?" spin":" spins")+" that are not saved. It will be saved, then "+targetName+" becomes the current session."}
        </div>
        <div style={{display:"flex",gap:8}}>
          <button type="button" onClick={()=>setView("list")} style={{flex:1,padding:11,borderRadius:10,border:"1px solid #2d4057",background:"#1e2d3d",color:"#94a3b8",fontSize:13,cursor:"pointer"}}>Cancel</button>
          <button type="button" onClick={()=>doResume(target)} style={{flex:1,padding:11,borderRadius:10,border:"none",background:"#16a34a",color:"white",fontSize:13,fontWeight:700,cursor:"pointer"}}>Save and switch</button>
        </div>
      </div>
    );
  }

  function renameBody() {
    return (
      <form onSubmit={saveRename} style={{display:"flex",flexDirection:"column",gap:10,minWidth:0}}>
        <FieldLabel>Label</FieldLabel>
        <input type="text" value={draft} maxLength={60} placeholder={targetName} onChange={e=>setDraft(e.target.value)}
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          style={{width:"100%",minWidth:0,boxSizing:"border-box",padding:"10px 12px",borderRadius:9,border:"1px solid #2d4057",background:"#0f1923",color:"#e2e8f0",fontSize:14}}/>
        <div style={{fontSize:11,color:"#64748b",minHeight:14}}>{draft.length+"/60 characters. Leave it empty to show the session's own name."}</div>
        <div style={{display:"flex",gap:8}}>
          <button type="button" onClick={()=>setView("list")} style={{flex:1,padding:11,borderRadius:10,border:"1px solid #2d4057",background:"#1e2d3d",color:"#94a3b8",fontSize:13,cursor:"pointer"}}>Cancel</button>
          <button type="submit" style={{flex:1,padding:11,borderRadius:10,border:"none",background:"#16a34a",color:"white",fontSize:13,fontWeight:700,cursor:"pointer"}}>Save label</button>
        </div>
      </form>
    );
  }

  function catchUpBody() {
    const statusText = parsed.ok ? parsed.numbers.length+(parsed.numbers.length===1?" number":" numbers")+" to enter, oldest first"
      : parsed.empty ? (note || "Type the numbers in order, oldest first.")
      : parsed.message;
    return (
      <div style={{display:"flex",flexDirection:"column",gap:10,minWidth:0}}>
        <div style={{fontSize:13,fontWeight:700,color:"#e2e8f0",overflowWrap:"anywhere"}}>{targetName}</div>
        <div style={{fontSize:11,color:"#94a3b8",lineHeight:"16px"}}>Numbers you add here are entered as new spins, oldest first.</div>
        {resumedLive ? (
          <>
            <FieldLabel>Numbers that came while you were away</FieldLabel>
            <input type="text" value={bulk} placeholder="2 2 2 24 4, or 2,2,2,24,4" onChange={e=>setBulk(e.target.value)}
              autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
              style={{width:"100%",minWidth:0,boxSizing:"border-box",padding:"10px 12px",borderRadius:9,border:"1px solid #2d4057",background:"#0f1923",color:"#e2e8f0",fontSize:14}}/>
            <div style={{display:"flex",flexWrap:"wrap",gap:4,minHeight:28,maxHeight:96,overflowY:"auto",minWidth:0}}>
              {parsed.ok && parsed.numbers.map((n,i) => {
                const isZero = n==="0"||n==="00";
                const red = !isZero && RED.has(+n);
                return (
                  <span key={i} style={{minWidth:28,height:26,padding:"0 6px",borderRadius:6,display:"inline-flex",alignItems:"center",justifyContent:"center",background:isZero?"#166534":red?"#7f1d1d":"#0d1117",border:"1px solid #2d4057",color:isZero?"#bbf7d0":red?"#fecaca":"#f1f5f9",fontSize:11,fontWeight:800,fontVariantNumeric:"tabular-nums"}}>{n}</span>
                );
              })}
            </div>
            <div role="status" style={{fontSize:11,minHeight:16,color:parsed.ok||parsed.empty?"#64748b":"#f87171",overflowWrap:"anywhere"}}>{statusText}</div>
            <div style={{display:"flex",gap:8,minWidth:0}}>
              <button type="button" onClick={readPhoto} style={{flex:1,padding:11,borderRadius:10,border:"1px solid #2d4057",background:"#1e2d3d",color:"#60a5fa",fontSize:13,fontWeight:700,cursor:"pointer"}}>Read board photo</button>
              <button type="button" disabled={!parsed.ok} onClick={addCatchUp} style={{flex:1,padding:11,borderRadius:10,border:"none",background:parsed.ok?"#16a34a":"#1f2937",color:parsed.ok?"white":"#475569",fontSize:13,fontWeight:700,cursor:parsed.ok?"pointer":"default"}}>
                {parsed.ok ? "Add "+parsed.numbers.length+(parsed.numbers.length===1?" spin":" spins") : "Add"}
              </button>
            </div>
          </>
        ) : (
          <div style={{fontSize:12,color:"#94a3b8",lineHeight:"17px"}}>
            {resumed ? "This is a Game session. Catch up adds numbers to Live sessions; enter Game numbers on the Game page." : "Resuming the session."}
          </div>
        )}
        <button type="button" onClick={()=>setView("list")} style={{padding:"9px 0",borderRadius:9,border:"1px solid #2d4057",background:"transparent",color:"#94a3b8",fontSize:12,cursor:"pointer"}}>Back to sessions</button>
      </div>
    );
  }

  const body = view==="list" ? listBody() : view==="confirm" ? confirmBody() : view==="rename" ? renameBody() : catchUpBody();
  return (
    <Modal onClose={onClose}>
      <div style={{display:"flex",flexDirection:"column",gap:12,width:"100%",minWidth:0}}>
        <div style={{display:"flex",alignItems:"center",gap:8,minWidth:0}}>
          <div style={{flex:"1 1 0",minWidth:0,fontSize:15,fontWeight:800,color:"#e2e8f0"}}>{titles[view]}</div>
          <button type="button" onClick={onClose} style={{flex:"0 0 auto",padding:"6px 12px",borderRadius:8,border:"1px solid #2d4057",background:"#1e2d3d",color:"#94a3b8",fontSize:12,cursor:"pointer"}}>Close</button>
        </div>
        {body}
      </div>
    </Modal>
  );
}
