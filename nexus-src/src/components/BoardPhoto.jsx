// -- Board photo reader (the Roulette side of F3.2) --
// The photo page is a separate service. Roulette sends the user there in this tab and reads back what it returns, which
// arrives in location.hash as #readboard=... That return is untrusted input. It is parsed strictly and removed from the
// URL at once. Nothing reaches the session until the user presses Add. Its atomic action uses the shared live settlement
// path. The URL, the parse and the add order are pure: anything they read from the browser is passed in.

const BOARD_PHOTO_URLS = {
  american: "https://nexusfoundry.app/roulette/read-board?wheel=american",
  european: "https://nexusfoundry.app/roulette/read-board?wheel=european",
};
const BOARD_HASH_PREFIX = "#readboard=";
const BOARD_MAX_NUMBERS = 40;
const BOARD_STATUS_HEIGHT = 16; // the status slot's reserved height (shared rule 82)

// One short plain line per status. "canceled" is a legal return that shows nothing.
const BOARD_STATUS_LINES = {
  changed: "Session or wheel changed, read again",
  offline: "PC offline, photo reading unavailable",
  busy: "Reader busy or warming up, try in 1 min",
  timeout: "Photo reading timed out, try again",
  unreadable: "Could not read numbers from that photo",
  unavailable: "Photo reading unavailable right now",
  limit: "Photo limit reached for this hour",
  exif: "Photo's image data could not be read",
  toolarge: "Photo is too large, try a smaller one",
  refused: "That photo was refused, try another",
};
const BOARD_STATUS_KEYS = Object.keys(BOARD_STATUS_LINES).concat(["canceled"]);

// The page the button opens for a session's wheel. The American wheel only when the session says so (as getWheelNumbers).
function boardPhotoUrl(wheel) {
  return wheel === "american" ? BOARD_PHOTO_URLS.american : BOARD_PHOTO_URLS.european;
}

// Standalone opens this tab; a frame asks the pinned shell directly during the click, without awaiting anything.
function openBoardPhoto(loc, wheel, onResult) {
  if(window.parent !== window) {
    return openCasinoReadBoard(wheel).then(function(result) {
      if(!result.ok && onResult) onResult({kind:"status",status:"unavailable"});
    });
  }
  loc.assign(boardPhotoUrl(wheel));
}

function isBoardReturn(hash) {
  return typeof hash === "string" && hash.indexOf(BOARD_HASH_PREFIX) === 0;
}

// A number is legal when the session's wheel has it: 0-36, and 00 only on the American wheel. The body is what follows
// the prefix: "ok" or "ok:16,4,0,00". One illegal, empty or surplus entry rejects the whole list as unreadable.
function readBoardNumbers(body, wheel) {
  const unreadable = {kind: "status", status: "unreadable"};
  const list = body === "ok" ? "" : body.slice(3); // drop "ok:"
  if (!list) return unreadable;
  const parts = list.split(",");
  if (parts.length > BOARD_MAX_NUMBERS) return unreadable;
  const legal = getWheelNumbers(wheel);
  return parts.every(p => legal.includes(p)) ? {kind: "numbers", numbers: parts} : unreadable;
}

// Parses a return hash. Returns {kind:"numbers", numbers} or {kind:"status", status}, or null when the hash is a return
// this reader does not know (an unknown status is ignored).
function parseBoardReturn(hash, wheel) {
  if (!isBoardReturn(hash)) return null;
  const body = hash.slice(BOARD_HASH_PREFIX.length);
  if (body === "ok" || body.indexOf("ok:") === 0) return readBoardNumbers(body, wheel);
  return BOARD_STATUS_KEYS.includes(body) ? {kind: "status", status: body} : null;
}

// Reads the return once and removes it from the URL at once, so a reload has nothing to read again. Only loc.hash is
// read. The URL is rewritten for every #readboard= return, understood or not. Returns the result to show, or null when
// there is nothing to show (no return, an unknown status, or canceled). If the URL cannot be rewritten the return still
// shows once; nothing is added without Add, so a reload could only show the review again.
function takeBoardReturn(loc, hist, wheel) {
  const hash = loc.hash;
  if (!isBoardReturn(hash)) return null;
  try { hist.replaceState(hist.state, "", loc.pathname + loc.search); } catch (e) { /* see the note above */ }
  const result = parseBoardReturn(hash, wheel);
  if (!result || (result.kind === "status" && result.status === "canceled")) return null;
  return result;
}

// Pull once after hello, including when hello preceded this effect. Keep the request across effect restarts so a
// consumed shell result cannot be lost to Strict Mode cleanup. Once account hydration finishes, an in-flight reply
// belongs to that session/wheel; changing either discards it even before it resolves.
function useCasinoBoardReturn(wheel, setAppMode, setBoardReturn, syncStatus, sessionId) {
  const pull = React.useRef({request:null,consumed:false,scope:null});
  const slot = pull.current;
  if(slot.scope && (slot.scope.id !== sessionId || slot.scope.wheel !== wheel)) slot.consumed = true;
  React.useEffect(function() {
    if(window.parent === window) return;
    installCasinoBridge();
    let active = true;
    const ready = function() {
      const slot = pull.current;
      if(!casinoBridge.ready || slot.consumed) return;
      if(!slot.scope && syncStatus !== "checking") slot.scope = {id:sessionId,wheel};
      if(!slot.request) slot.request = takeCasinoReadBoard();
      slot.request.then(function(reply) {
        // The account may restore a European wheel after the shell result arrives.
        if(!active || slot.consumed || syncStatus === "checking") return;
        slot.consumed = true;
        const fragment = reply.ok && reply.body && reply.body.fragment;
        if(typeof fragment !== "string" || fragment === "none" || fragment === "canceled") return;
        setAppMode("live");
        const result = parseBoardReturn(BOARD_HASH_PREFIX + fragment, wheel);
        if(result) setBoardReturn(result);
      });
    };
    casinoBridge.listeners.add(ready);
    ready();
    return function() { active = false; casinoBridge.listeners.delete(ready); };
  }, [wheel, sessionId, setAppMode, setBoardReturn, syncStatus]);
}

// The board lists the most recent number first. Add enters the numbers oldest first, so the last one entered is the most recent.
function boardAddOrder(numbersBoardOrder) {
  return numbersBoardOrder.slice().reverse();
}

// The status line under the spin tools. Its slot is always reserved (shared rule 82): with nothing to say it is empty.
function BoardPhotoStatus({result}) {
  const line = result && result.kind === "status" ? (BOARD_STATUS_LINES[result.status] || "") : "";
  return (
    <div role="status" aria-live="polite"
      style={{minHeight:BOARD_STATUS_HEIGHT,boxSizing:"border-box",textAlign:"center",color:"#fbbf24",fontSize:11,fontWeight:700,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
      {line}
    </div>
  );
}

// The review of the numbers a photo read returned, in board order, most recent first. Each number can be corrected with
// the same number picker the recent-numbers strip uses (NumberPicker, SpinTools.jsx). Add passes the list up in board
// order and App enters it oldest first. Cancel, and a press on the backdrop, add nothing.
function BoardPhotoReview({numbers, roulette, onAdd, onCancel}) {
  const [list, setList] = React.useState(numbers);
  const [picking, setPicking] = React.useState(null);
  const count = list.length;
  return (
    <>
      <Modal onClose={onCancel}>
        <div style={{fontSize:17,fontWeight:800,color:"#e2e8f0",marginBottom:6}}>Numbers read from your photo</div>
        <div style={{fontSize:12,color:"#94a3b8",lineHeight:1.5,marginBottom:12}}>Most recent first. Check them before adding.</div>
        <div role="group" aria-label="Numbers read from the photo" style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:14}}>
          {list.map((n,i) => {
            const isZ = n==="0"||n==="00";
            const isRed = !isZ && RED.has(+n);
            return (
              <button key={i} type="button" aria-label={`Correct number ${i+1}, read as ${n}`} onClick={()=>setPicking(i)}
                style={{minWidth:36,height:36,padding:"0 8px",borderRadius:8,border:"1px solid #2d4057",background:isZ?"#166534":isRed?"#7f1d1d":"#0d1117",color:isZ?"#bbf7d0":isRed?"#fecaca":"#f1f5f9",fontSize:14,fontWeight:800,cursor:"pointer"}}>
                {n}
              </button>
            );
          })}
        </div>
        <div style={{display:"flex",gap:8}}>
          <button type="button" onClick={onCancel} style={{flex:1,padding:"14px 0",borderRadius:12,border:"1px solid #2d4057",background:"#0f1923",color:"#94a3b8",fontSize:15,fontWeight:800,cursor:"pointer"}}>Cancel</button>
          <button type="button" onClick={()=>onAdd(list)} style={{flex:1,padding:"14px 0",borderRadius:12,border:"none",background:"#134e2a",color:"#86efac",fontSize:15,fontWeight:800,cursor:"pointer"}}>{count===1?"Add 1 number":`Add ${count} numbers`}</button>
        </div>
      </Modal>
      {picking!==null && (
        <NumberPicker title={`Correct number ${picking+1} of ${count}`}
          note={`This number is read as ${list[picking]}. Choosing a number changes it in this list. Nothing is added until you press Add.`}
          blocked={false} label={`number ${picking+1}`} currentValue={list[picking]} roulette={roulette}
          onChoose={v=>{ setList(list.map((x,j)=>j===picking?v:x)); setPicking(null); }}
          onClose={()=>setPicking(null)}/>
      )}
    </>
  );
}
