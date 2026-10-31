// Applies the first-run setup choices to app state. Moved from App.jsx; the only change is that updApp is a parameter.
function completeOnboarding(updApp, {roulette, bankroll, defaultBuyIn, currency: curr, tableMinBet, tableMaxBet, tableMaxTotal}) {
          updApp(s => {
            const prevBankroll = s.settings._restartBankroll;
            s.settings.onboarded = true;
            s.settings.currency = curr;
            s.settings.defaultBuyIn = defaultBuyIn;
            if(tableMinBet) s.settings.tableMinBet = tableMinBet;
            if(tableMaxBet) s.settings.tableMaxBet = tableMaxBet;
            if(tableMaxTotal) s.settings.tableMaxTotal = tableMaxTotal;
            delete s.settings._restartBankroll;
            if(prevBankroll !== undefined) {
              // Restart -- adjust existing session's bankroll
              const delta = bankroll - prevBankroll;
              s.currentSession.roulette = roulette;
              s.currentSession.droughts = droughtsFromSpins(s.currentSession.spins, roulette);
              if(delta > 0) {
                // Added money → Buy In
                s.currentSession.bankrollCurrent = Math.round((s.currentSession.bankrollCurrent + delta)*100)/100;
                s.currentSession.totalBuyIn = (s.currentSession.totalBuyIn||0) + delta;
                if(!s.currentSession.buyIns) s.currentSession.buyIns = [];
                s.currentSession.buyIns.push({amount:delta,at:Date.now(),spin:s.currentSession.spins.length,note:"onboarding restart"});
              } else if(delta < 0) {
                // Removed money → Cash Out
                const cashAmt = Math.abs(delta);
                s.currentSession.bankrollCurrent = Math.round((s.currentSession.bankrollCurrent - cashAmt)*100)/100;
                s.currentSession.totalCashOut = (s.currentSession.totalCashOut||0) + cashAmt;
                if(!s.currentSession.cashOuts) s.currentSession.cashOuts = [];
                s.currentSession.cashOuts.push({amount:cashAmt,at:Date.now(),spin:s.currentSession.spins.length,note:"onboarding restart"});
              }
            } else {
              // Fresh start
              s.currentSession = newSession(roulette, bankroll);
              s.gameSession = newSession(roulette, bankroll);
            }
          });
}

// Whether a session's start opens the start step: a Live session that has just gone from not started to started,
// with no venue yet. prev is the session as last seen (null on the first render, so a session already running on load does not prompt).
function venueStartOpens(prev, cur, appMode) {
  const started = !!cur.sessionStartedAt;
  return !!prev && appMode==="live" && started && !cur.venue && !(prev.id===cur.id && prev.started);
}

// Ending a live session with no venue offers Confirm venue first.
function venueEndAsksFirst(appMode, cur) {
  return appMode==="live" && !cur.venue;
}

// -- Venue sheets (F11): the Live start step, the Confirm venue step at the end, and the edit sheet. App calls this once.
// The hook owns the sheet state and the save path. App wires the openers and renders the sheets (sheets). The venue rules
// themselves live in session.js and VenuePicker.jsx.
function useVenueSheets({appMode, appState, saved, settings, updApp, endSession}) {
  const [startFor, setStartFor] = React.useState(null); // the session id whose start step is open
  const [endOpen, setEndOpen] = React.useState(false);
  const [edit, setEdit] = React.useState(null); // "current", a saved session id, or null
  const liveStartRef = React.useRef(null);
  const cur = appState.currentSession;

  // A Live session that starts (its first tracked spin) opens the start step once, in its own sheet.
  React.useEffect(() => {
    const prev = liveStartRef.current;
    liveStartRef.current = {id: cur.id, started: !!cur.sessionStartedAt};
    if(venueStartOpens(prev, cur, appMode)) setStartFor(cur.id);
  }, [appMode, cur.id, cur.sessionStartedAt]);

  const editTarget = edit===null ? null : (edit==="current" ? cur : (saved.find(x => x.id===edit) || null));
  const startTarget = startFor!==null && cur.id===startFor && !cur.venue ? cur : null;

  // The value lists: each field's values from saved sessions, the current session and the values typed by hand.
  function choices() {
    const sessions = saved.concat([cur]);
    const entries = settings.venueEntries || [];
    const out = {};
    VENUE_FIELDS.forEach(f => { out[f] = venueOptions(f, sessions, entries); });
    return out;
  }

  // scope is "current" or a saved session id. added holds the values typed by hand, kept in the settings list.
  function save(scope, venue, added) {
    const now = Date.now();
    updApp(s => {
      if(added && added.length) s.settings.venueEntries = addVenueEntries(s.settings.venueEntries, added, now);
      const target = scope==="current" ? s.currentSession : s.savedSessions.find(x => x.id===scope);
      if(!target) return;
      Object.assign(target, withVenue(target, venue, target.spins.length));
      target.modified = now;
    });
  }

  return {
    openEdit: setEdit,
    // Ending a live session with no venue asks for one first. Skip ends it as before.
    requestEnd() {
      if(venueEndAsksFirst(appMode, cur)) setEndOpen(true);
      else endSession();
    },
    sheets: (
      <>
        {startTarget && <VenueModal title="Where are you playing?" value={null} options={choices()} dealerFromSpin={null} saveLabel="Save" secondaryLabel="Skip" onSave={(v,added)=>{setStartFor(null);save("current",v,added);}} onDismiss={()=>setStartFor(null)}/>}
        {endOpen && <VenueModal title="Confirm venue" value={null} options={choices()} dealerFromSpin={null} saveLabel="Save and end" secondaryLabel="Skip" onSave={(v,added)=>{setEndOpen(false);save("current",v,added);endSession();}} onDismiss={()=>{setEndOpen(false);endSession();}}/>}
        {editTarget && <VenueModal title="Venue" value={editTarget.venue} options={choices()} locked={dealerLocked(editTarget)} dealerFromSpin={editTarget.sessionEndedAt?null:editTarget.spins.length} saveLabel="Save" secondaryLabel="Cancel" onSave={(v,added)=>{save(edit,v,added);setEdit(null);}} onDismiss={()=>setEdit(null)}/>}
      </>
    ),
  };
}
