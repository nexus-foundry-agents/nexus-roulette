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

// The optional reader field, after the numbers of a numbers return only: "#readboard=ok:8,31,3;by=cloud", ";by=pc" or ";by=gemini".
const BOARD_READER_FIELD = ";by=";
const BOARD_READER_HEIGHT = 16; // the reader line's reserved height (shared rule 82)
// A reader id is the provider that answered: lowercase letters, digits and hyphens, 1 to 32 characters. Anything else is no reader.
const BOARD_READER_ID = /^[a-z0-9-]{1,32}$/;
// One factual line per id this page names. "cloud" stays for returns that predate the provider ids.
const BOARD_READER_LINES = {gemini: "Read by Google Gemini", openai: "Read by OpenAI", cloud: "Read by the cloud model", pc: "Read by your PC"};

// True only for a reader id: a string that matches BOARD_READER_ID. "__proto__" has underscores and is not an id. "constructor"
// is an id, and the line lookup reads own keys only, so it is a plain id and never Object's constructor.
function isBoardReader(by) {
  return typeof by === "string" && BOARD_READER_ID.test(by);
}

// The reader line for a value, or "" when the value is absent or not an id. A named id gets its line; any other id names itself.
function boardReaderLine(by) {
  if (!isBoardReader(by)) return "";
  return Object.prototype.hasOwnProperty.call(BOARD_READER_LINES, by) ? BOARD_READER_LINES[by] : "Read by " + by;
}

// The page the button opens for a session's wheel. The American wheel only when the session says so (as getWheelNumbers).
function boardPhotoUrl(wheel) {
  return wheel === "american" ? BOARD_PHOTO_URLS.american : BOARD_PHOTO_URLS.european;
}

// Standalone opens this tab; a frame asks the pinned shell directly during the click, without awaiting anything.
function openBoardPhoto(loc, wheel, onResult) {
  if(window.parent !== window) {
    // A call that throws reads as unavailable, as a refused call does, and nothing is left unhandled.
    return openCasinoReadBoard(wheel).then(function(result) {
      if(!result.ok && onResult) onResult({kind:"status",status:"unavailable"});
    }, function() {
      if(onResult) onResult({kind:"status",status:"unavailable"});
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

// Contract with the Nexus Foundry reader (the shape it must send; a change lands here first):
//   #readboard=ok:<numbers>                  numbers in board order, most recent first; each one legal on the wheel
//   #readboard=ok:<numbers>;by=<id>          the same, and the provider that answered: gemini, openai, cloud, pc, or another id
//   #readboard=<status>                      a status key; a status takes no ;by= field
// The <id> is exact: lowercase letters, digits and hyphens, 1 to 32 characters. The ;by= field is optional.
// Absent, or a value that is not an id, means no reader line. An id this page does not name shows "Read by <id>".
// The field never makes a return unreadable, and a numbers result without it has no reader key at all.
// Parses a return hash. Returns {kind:"numbers", numbers[, reader]} or {kind:"status", status}, or null when the hash is a
// return this reader does not know (an unknown status is ignored).
function parseBoardReturn(hash, wheel) {
  if (!isBoardReturn(hash)) return null;
  const raw = hash.slice(BOARD_HASH_PREFIX.length);
  const {body, by} = splitBoardReader(raw);
  if (body === "ok" || body.indexOf("ok:") === 0) return withBoardReader(readBoardNumbers(body, wheel), by);
  return BOARD_STATUS_KEYS.includes(raw) ? {kind: "status", status: raw} : null;
}

// Splits the reader field off a body. The value after ;by= is kept only when it is a reader id; otherwise the field is
// dropped and the numbers parse as if it were never sent.
function splitBoardReader(body) {
  const at = body.indexOf(BOARD_READER_FIELD);
  if (at < 0) return {body, by: null};
  const by = body.slice(at + BOARD_READER_FIELD.length);
  return {body: body.slice(0, at), by: isBoardReader(by) ? by : null};
}

// The reader rides on a numbers result only. With no reader id the result is returned unchanged, with no reader key.
function withBoardReader(result, by) {
  return by && result.kind === "numbers" ? {...result, reader: by} : result;
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
      }, function() {
        // A read that threw is unavailable, as a read the shell refused is; the same guards apply and nothing is left unhandled.
        if(!active || slot.consumed || syncStatus === "checking") return;
        slot.consumed = true;
        setBoardReturn({kind:"status",status:"unavailable"});
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
// order and App enters it oldest first. Cancel, and a press on the backdrop, add nothing. The reader line under the heading
// is always rendered in a reserved slot (shared rule 82): only its visibility depends on whether a reader is known.
function BoardPhotoReview({numbers, roulette, reader, onAdd, onCancel}) {
  const [list, setList] = React.useState(numbers);
  const [picking, setPicking] = React.useState(null);
  const count = list.length;
  const readerLine = boardReaderLine(reader);
  return (
    <>
      <Modal onClose={onCancel}>
        <div style={{fontSize:17,fontWeight:800,color:"#e2e8f0",marginBottom:6}}>Numbers read from your photo</div>
        <div style={{fontSize:12,color:"#94a3b8",lineHeight:1.5,marginBottom:4}}>Most recent first. Check them before adding.</div>
        <div data-slot="reader" aria-hidden={readerLine ? undefined : "true"}
          style={{minHeight:BOARD_READER_HEIGHT,boxSizing:"border-box",visibility:readerLine ? "visible" : "hidden",fontSize:12,fontWeight:700,color:"#94a3b8",lineHeight:"16px",marginBottom:12,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
          {readerLine}
        </div>
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
