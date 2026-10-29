// -- Live-mode spin tools: the Clear numbers row with its inline Undo, and the recent-numbers strip --
// Every slot here holds its height whether or not it has anything in it, so clearing the numbers changes
// what is shown inside a slot and moves nothing below it (shared rule 82). App.jsx owns the state (confirm
// open, undo offered, the snapshot) and passes it in.

// Reserved heights, in px. Each is the populated height of its control, measured in headless Chrome at a
// 420 px viewport: the strip is 30 with five numbers (28 px chips and 2 px bottom padding) and 40 with thirty,
// where the horizontal scrollbar takes 10 px. A platform with a thicker scrollbar would grow the strip past
// this reservation when it first overflows. The drought panel is 251 px with five spins and with thirty.
const SPIN_TOOLS_ROW_HEIGHT = 30;
const RECENT_STRIP_MIN_HEIGHT = 40;
const DROUGHT_PANEL_HEIGHT = 251;
const RECENT_STRIP_LIMIT = 30;

function SpinTools({spinCount, confirmOpen, undoVisible, onAsk, onCancel, onConfirm, onUndo}) {
  const hasSpins = spinCount > 0;
  const noun = spinCount === 1 ? "spin" : "spins";
  const confirmBody = `Removes the ${spinCount} ${noun} from this session. Each track's bets and progression level restart at zero. Bankroll, buy-ins, cash-outs and track profit and loss are not changed. Undo stays available until the next spin, or for 15 seconds.`;
  // Clear numbers and the undo notice share one grid cell, so the cell is as large as the larger of the two.
  // Only the one that applies is visible; the other keeps its place.
  const cell = (shown) => ({gridRow:1, gridColumn:1, justifySelf:"end", alignSelf:"center", visibility:shown?"visible":"hidden"});
  return (
    <>
      <div style={{display:"grid",alignItems:"center",justifyItems:"end",minHeight:SPIN_TOOLS_ROW_HEIGHT,width:"100%",boxSizing:"border-box"}}>
        <button type="button" disabled={!hasSpins} aria-hidden={undoVisible} onClick={onAsk}
          style={{...cell(!undoVisible),padding:"4px 10px",borderRadius:8,border:"1px solid #2d4057",background:"transparent",color:hasSpins?"#94a3b8":"#374151",fontSize:11,fontWeight:700,cursor:hasSpins?"pointer":"not-allowed"}}>
          Clear numbers
        </button>
        <div role="status" aria-hidden={!undoVisible}
          style={{...cell(undoVisible),display:"flex",alignItems:"center",gap:6,color:"#fbbf24",fontSize:11,fontWeight:700,whiteSpace:"nowrap"}}>
          <span>Numbers cleared</span>
          <span aria-hidden="true">·</span>
          <button type="button" onClick={onUndo}
            style={{padding:"4px 10px",borderRadius:8,border:"1px solid #f59e0b",background:"transparent",color:"#fbbf24",fontSize:11,fontWeight:700,cursor:"pointer"}}>Undo</button>
        </div>
      </div>
      {confirmOpen && (
        <Modal onClose={onCancel}>
          <div style={{fontSize:17,fontWeight:800,color:"#e2e8f0",marginBottom:10}}>Clear numbers?</div>
          <div style={{fontSize:12,color:"#94a3b8",lineHeight:1.5,marginBottom:16}}>{confirmBody}</div>
          <div style={{display:"flex",gap:8}}>
            <button type="button" onClick={onCancel} style={{flex:1,padding:"14px 0",borderRadius:12,border:"1px solid #2d4057",background:"#0f1923",color:"#94a3b8",fontSize:15,fontWeight:800,cursor:"pointer"}}>Cancel</button>
            <button type="button" onClick={onConfirm} style={{flex:1,padding:"14px 0",borderRadius:12,border:"none",background:"#b91c1c",color:"white",fontSize:15,fontWeight:800,cursor:"pointer"}}>Clear numbers</button>
          </div>
        </Modal>
      )}
    </>
  );
}

// Recent numbers, newest first, up to RECENT_STRIP_LIMIT. The container is always rendered at its reserved
// height: with no numbers it is an empty slot, so the first spin and a clear both leave the layout where it is.
function RecentNumbersStrip({spins, trackOverlays}) {
  const recent = [...spins].reverse().slice(0, RECENT_STRIP_LIMIT);
  return (
    <div style={{display:"flex",gap:4,overflowX:"auto",paddingBottom:2,WebkitOverflowScrolling:"touch",minHeight:RECENT_STRIP_MIN_HEIGHT,boxSizing:"border-box"}}>
      {recent.map((val,i)=>{
        const isZ=val==="0"||val==="00", r=!isZ&&RED.has(+val);
        const hitTracks=(trackOverlays||[]).filter(o=>{
          if(isZ)return false;
          if(o.type==="fibonacci")return (o.dozenTargets||[]).includes(dozenOf(val))||(o.colTargets||[]).includes(columnOf(val));
          if(o.type==="solution")return (o.activeBets||[]).some(b=>b.number===val);
          return false;
        });
        const borderColor=i===0?"#ffffff":hitTracks.length>0?hitTracks[0].color:isZ?"#22c55e":r?"#ef4444":"#374151";
        return(
          <div key={i} style={{flexShrink:0,width:28,height:28,borderRadius:6,background:isZ?"#166534":r?"#7f1d1d":"#0d1117",border:"2px solid "+borderColor,color:isZ?"#bbf7d0":r?"#fecaca":"#f1f5f9",fontSize:10,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>
            {val}
          </div>
        );
      })}
    </div>
  );
}
