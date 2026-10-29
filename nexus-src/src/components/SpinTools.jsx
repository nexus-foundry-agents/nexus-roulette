// -- Live-mode spin tools: the Clear numbers row with its inline Undo, and the recent-numbers strip --
// Every slot here holds its height whether or not it has anything in it, so clearing the numbers changes
// what is shown inside a slot and moves nothing below it (shared rule 82). App.jsx owns the state (confirm
// open, undo offered, the snapshot) and passes it in. A long-press on a recent number asks App to open the
// number picker for that spin (SpinCorrectionContext); App owns the correction and the picker's state.

// Reserved heights, in px. Each is the populated height of its control, measured in headless Chrome at a
// 420 px viewport: the strip is 30 with five numbers (28 px chips and 2 px bottom padding) and 40 with thirty,
// where the horizontal scrollbar takes 10 px. A platform with a thicker scrollbar would grow the strip past
// this reservation when it first overflows. The drought panel is 251 px with five spins and with thirty.
const SPIN_TOOLS_ROW_HEIGHT = 30;
const RECENT_STRIP_MIN_HEIGHT = 40;
const DROUGHT_PANEL_HEIGHT = 251;
const RECENT_STRIP_LIMIT = 30;

// A press on a recent number opens the picker after this long, unless the pointer moves more than the slop first.
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 8;

// App provides the function that opens the picker for a spin index. Outside App it is null and a press does nothing.
const SpinCorrectionContext = React.createContext(null);

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

// Long-press detection for one strip. Pure: the timers are injected and nothing here knows about spins or the
// session. A press fires onLongPress(spinIndex) once, after delayMs, if the pointer stays within slopPx of where it
// went down. A move past the slop, a release, or a cancel (the browser takes over for a scroll or swipe) ends the
// press without firing. Releasing after the press fired does nothing more, so a long-press never also taps.
// The timer functions are looked up when a press starts, not when the strip renders, so rendering never needs them.
function createLongPress({onLongPress, delayMs=LONG_PRESS_MS, slopPx=LONG_PRESS_SLOP_PX, setTimer, clearTimer}) {
  let timer = null, origin = null;
  function cancel() {
    if(timer!==null) { (clearTimer||clearTimeout)(timer); timer = null; }
    origin = null;
  }
  return {
    down(spinIndex, x, y) {
      cancel();
      origin = {x, y};
      timer = (setTimer||setTimeout)(() => { timer = null; origin = null; onLongPress(spinIndex); }, delayMs);
    },
    move(x, y) {
      if(origin && Math.hypot(x - origin.x, y - origin.y) > slopPx) cancel();
    },
    up() { cancel(); },
    cancel,
  };
}

// Recent numbers, newest first, up to RECENT_STRIP_LIMIT. The container is always rendered at its reserved
// height: with no numbers it is an empty slot, so the first spin and a clear both leave the layout where it is.
// Chip i is the spin at index spins.length - 1 - i. Pressing and holding one asks App for the picker; nothing else.
function RecentNumbersStrip({spins, trackOverlays}) {
  const openCorrection = React.useContext(SpinCorrectionContext);
  const latestOpen = React.useRef(openCorrection);
  latestOpen.current = openCorrection;
  const press = React.useMemo(() => createLongPress({
    onLongPress: (spinIndex) => { if(latestOpen.current) latestOpen.current(spinIndex); },
  }), []);
  React.useEffect(() => () => press.cancel(), [press]);
  const recent = [...spins].reverse().slice(0, RECENT_STRIP_LIMIT);
  return (
    <div style={{display:"flex",gap:4,overflowX:"auto",paddingBottom:2,WebkitOverflowScrolling:"touch",minHeight:RECENT_STRIP_MIN_HEIGHT,boxSizing:"border-box"}}>
      {recent.map((val,i)=>{
        const spinIndex = spins.length - 1 - i;
        const isZ=val==="0"||val==="00", r=!isZ&&RED.has(+val);
        const hitTracks=(trackOverlays||[]).filter(o=>{
          if(isZ)return false;
          if(o.type==="fibonacci")return (o.dozenTargets||[]).includes(dozenOf(val))||(o.colTargets||[]).includes(columnOf(val));
          if(o.type==="solution")return (o.activeBets||[]).some(b=>b.number===val);
          return false;
        });
        const borderColor=i===0?"#ffffff":hitTracks.length>0?hitTracks[0].color:isZ?"#22c55e":r?"#ef4444":"#374151";
        return(
          <div key={i}
            onPointerDown={e=>{ if(e.button===0) press.down(spinIndex, e.clientX, e.clientY); }}
            onPointerMove={e=>press.move(e.clientX, e.clientY)}
            onPointerUp={()=>press.up()}
            onPointerCancel={()=>press.up()}
            onPointerLeave={()=>press.up()}
            onContextMenu={e=>e.preventDefault()}
            style={{flexShrink:0,width:28,height:28,borderRadius:6,background:isZ?"#166534":r?"#7f1d1d":"#0d1117",border:"2px solid "+borderColor,color:isZ?"#bbf7d0":r?"#fecaca":"#f1f5f9",fontSize:10,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>
            {val}
          </div>
        );
      })}
    </div>
  );
}

// The number picker for one recent spin. Choosing a number corrects that spin at once: a single selection acts on
// selection, with no confirm step. The numbers are the wheel's own (0, 00 on an American wheel, then 1-36). When
// blockedReason is set the session cannot be corrected, so every number is disabled and the reason is shown.
// The shared Modal draws it over the page and dismisses it, so opening it moves nothing.
function SpinNumberPicker({spinIndex, spinCount, currentValue, roulette, blockedReason, onChoose, onClose}) {
  const spinNo = spinIndex + 1;
  const numbers = getWheelNumbers(roulette);
  return (
    <Modal onClose={onClose}>
      <div style={{fontSize:17,fontWeight:800,color:"#e2e8f0",marginBottom:6}}>Correct spin {spinNo} of {spinCount}</div>
      <div style={{fontSize:12,color:blockedReason?"#fbbf24":"#94a3b8",lineHeight:1.5,marginBottom:12}}>
        {blockedReason || `This spin is recorded as ${currentValue}. Choosing a number replaces it and recalculates the session from the corrected spins.`}
      </div>
      <div role="group" aria-label="Wheel numbers" style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(42px,1fr))",gap:6,marginBottom:14}}>
        {numbers.map(n => {
          const isCurrent = n===currentValue;
          const isZ = n==="0"||n==="00";
          const isRed = !isZ && RED.has(+n);
          return (
            <button key={n} type="button" disabled={!!blockedReason} aria-pressed={isCurrent}
              aria-label={`Set spin ${spinNo} to ${n}`} onClick={()=>onChoose(n)}
              style={{height:42,borderRadius:8,border:isCurrent?"2px solid #fbbf24":"1px solid #2d4057",background:isZ?"#166534":isRed?"#7f1d1d":"#0d1117",color:isZ?"#bbf7d0":isRed?"#fecaca":"#f1f5f9",fontSize:14,fontWeight:800,cursor:blockedReason?"not-allowed":"pointer",opacity:blockedReason?0.4:1}}>
              {n}
            </button>
          );
        })}
      </div>
      <button type="button" onClick={onClose} style={{width:"100%",padding:"14px 0",borderRadius:12,border:"1px solid #2d4057",background:"#0f1923",color:"#94a3b8",fontSize:15,fontWeight:800,cursor:"pointer"}}>Cancel</button>
    </Modal>
  );
}
