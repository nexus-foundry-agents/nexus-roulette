// -- Main App Component --
export default function App() {
  const [appState, setAppState, boardDecision, commitBoardAdd] = useBoardPhotoState(loadApp);
  const casinoSync = useCasinoAccountSync(appState,setAppState);
  const [initialUiState] = useState(loadRouletteUiState);
  const [isLandscape, setIsLandscape] = useState(window.innerWidth > window.innerHeight);
  React.useEffect(()=>{
    function checkOrientation(){setIsLandscape(window.innerWidth > window.innerHeight);}
    window.addEventListener("resize",checkOrientation);
    window.addEventListener("orientationchange",()=>setTimeout(checkOrientation,100));
    return ()=>{window.removeEventListener("resize",checkOrientation);};
  },[]);
  const [tab, setTab] = useState(0);
  const [appMode, setAppMode] = useState("game"); // "game" | "live" | "sim"
  const gameRecording = useCasinoRecording("game",appMode==="game");
  const liveRecording = useCasinoRecording("live",appMode==="live");
  const [livePausedAt, setLivePausedAt] = useState(Date.now()); // paused since app starts in game mode
  const [livePausedTotal, setLivePausedTotal] = useState(0);

  // Track paused time when leaving/entering live mode
  useEffect(() => {
    if(appMode === "live") {
      // Returning to live - accumulate paused time
      if(livePausedAt) {
        setLivePausedTotal(prev => prev + (Date.now() - livePausedAt));
        setLivePausedAt(null);
      }
    } else {
      // Leaving live - start pause timer
      if(!livePausedAt) setLivePausedAt(Date.now());
    }
  }, [appMode]);
  const [simCfg, setSimCfg] = useState(defaultSimConfig);
  const [simRunning, setSimRunning] = useState(false);
  const [simProgress, setSimProgress] = useState(0); // sessions completed
  const [simResults, setSimResults] = useState(null);
  const [simDone, setSimDone] = useState(false);
  const simStopRef = React.useRef(false);
  const [addOpen, setAddOpen] = useState(false);
  const [selectedTrackId, setSelectedTrackId] = useState(null);
  const [selectedLevel, setSelectedLevel] = useState(null); // {trackId, index}: the Custom Bet level picked on the Full Table; null = the track's current level
  useEffect(()=>{ setSelectedLevel(null); }, [selectedTrackId]); // a change of selected track clears the level pick (the Game tab sets it too)
  const [result, setResult] = useState(null);
  const [flashNum, setFlashNum] = useState(null);
  const [prevSessState, setPrevSessState] = useState(null);
  const [draggingId, setDraggingId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [highlightTrackId, setHighlightTrackId] = useState(null);
  const [editTrackId, setEditTrackId] = useState(null);
  const [gameSpinning, setGameSpinning] = useState(false);
  const [gameResult, setGameResult] = useState(()=>initialUiState.gameResult||null);
  const [lastSpinDelta, setLastSpinDelta] = useState(null);
  const [selectedChip, setSelectedChip] = useState(()=>initialUiState.selectedChip||1);
  const [manualBets, setManualBets] = useState(()=>initialUiState.manualBets||[]);
  const [lastBets, setLastBets] = useState(()=>initialUiState.lastBets||[]);
  const [betResults, setBetResults] = useState(null);
  const [undoStack, setUndoStack] = useState([]);
  const [animNumber, setAnimNumber] = useState(null);
  const clearTimerRef = React.useRef(null);
  const [liveSelectingWinner, setLiveSelectingWinner] = useState(true);
  const [liveWinNumber, setLiveWinNumber] = useState(null);
  const [liveManualBets, setLiveManualBets] = useState(()=>initialUiState.liveManualBets||[]);
  const [liveLastBets, setLiveLastBets] = useState(()=>initialUiState.liveLastBets||[]);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearUndo, setClearUndo] = useState(null); // {sessionId, snapshot} while Undo for Clear numbers is offered
  const [spinCorrection, setSpinCorrection] = useState(null); // {index} while the number picker for a recent spin is open
  const {boardReturn, setBoardReturn, setBoardAdd, addBoardNumbers} = useBoardPhotoReturn(
    appState.currentSession, appMode, setAppMode, casinoSync.status, boardDecision, commitBoardAdd,
    {setPrevSessState, setResult, setLastSpinDelta, setFlashNum, liveRecording, vibration:(appState.settings||{}).vibration});

  // Save UI state when page is hidden (tab switch, app background)
  React.useEffect(()=>{
    function saveUIState(){
      saveRouletteUiState({manualBets,lastBets,liveManualBets,liveLastBets,selectedChip,gameResult});
    }
    function onVisibilityChange(){ if(document.hidden) saveUIState(); }
    document.addEventListener("visibilitychange",onVisibilityChange);
    window.addEventListener("beforeunload",saveUIState);
    return ()=>{
      document.removeEventListener("visibilitychange",onVisibilityChange);
      window.removeEventListener("beforeunload",saveUIState);
    };
  },[manualBets,lastBets,liveManualBets,liveLastBets,selectedChip,gameResult]);
  React.useEffect(()=>{
    function loadScopedUi(){
      const value=loadRouletteUiState();
      setGameResult(value.gameResult||null);
      setSelectedChip(value.selectedChip||1);
      setManualBets(value.manualBets||[]);
      setLastBets(value.lastBets||[]);
      setLiveManualBets(value.liveManualBets||[]);
      setLiveLastBets(value.liveLastBets||[]);
    }
    window.addEventListener('nexus-account-scope-ready',loadScopedUi);
    return ()=>window.removeEventListener('nexus-account-scope-ready',loadScopedUi);
  },[]);
  const [liveBetResults, setLiveBetResults] = useState(null);
  const [liveUndoStack, setLiveUndoStack] = useState([]);
  const liveClearTimerRef = React.useRef(null);
  const [updateAvailable, setUpdateAvailable] = useState(null); // {version, notes}

  // Check for app updates
  useEffect(() => {
    function checkUpdate() {
      fetch("version.json?t="+Date.now()).then(r=>r.json()).then(data=>{
        if(data.version && data.version !== APP_VERSION) setUpdateAvailable({version:data.version, notes:data.notes||""});
      }).catch(()=>{});
    }
    checkUpdate();
    const iv = setInterval(checkUpdate, 10000);
    return () => clearInterval(iv);
  }, []);

  const [buyInOpen, setBuyInOpen] = useState(false);
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [editBankroll, setEditBankroll] = useState(false);
  const [cashOutOpen, setCashOutOpen] = useState(false);
  const [hardResetOpen, setHardResetOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [pendingTrackType, setPendingTrackType] = useState("fibonacci");
  const [pendingTrackCfg, setPendingTrackCfg] = useState(defaultFibCfg());

  const sessKey = appMode==="game"?"gameSession":"currentSession";
  const sess = appState[sessKey] || appState.currentSession;
  const livePauseOffset = livePausedTotal + (livePausedAt ? (Date.now() - livePausedAt) : 0);
  const settings = appState.settings || defaultSettings();
  const saved = appState.savedSessions || [];
  const currency = settings.currency || "USD";
  const cur = getCurrency(currency);
  const venueSheets = useVenueSheets({appMode, appState, saved, settings, updApp, endSession});

  useEffect(() => { saveApp(appState); }, [appState]);

  // Storage failures surface as a banner, never a blocking browser dialog
  const [saveError, setSaveError] = useState(null);
  useEffect(() => {
    function onSaveError(e){ setSaveError((e && e.detail) || "Unknown storage error"); }
    window.addEventListener("nexus-save-error", onSaveError);
    return () => window.removeEventListener("nexus-save-error", onSaveError);
  }, []);

  // Undo after Clear numbers ends at the next spin, when the session changes or the mode leaves Live,
  // or after 15 seconds, whichever comes first.
  useEffect(() => {
    if(!clearUndo) return;
    const timer = setTimeout(() => setClearUndo(null), 15000);
    return () => clearTimeout(timer);
  }, [clearUndo]);
  useEffect(() => {
    if(!clearUndo) return;
    const live = appState.currentSession;
    if(appMode!=="live" || live.id!==clearUndo.sessionId || live.spins.length>0) setClearUndo(null);
  }, [clearUndo, appMode, appState.currentSession.id, appState.currentSession.spins.length]);

  // Keep the selected chip legal when the table minimum changes: snap up to the
  // smallest chip at or above the minimum so bets can never slip under it.
  useEffect(() => {
    const tMin = settings.tableMinBet || 1;
    if(selectedChip < tMin){
      const next = CHIP_DENOMS.find(c => c.val >= tMin);
      if(next) setSelectedChip(next.val);
    }
  }, [settings.tableMinBet]);

  function updApp(fn) { setAppState(p => { const n=JSON.parse(JSON.stringify(p)); fn(n); return n; }); }
  function updSess(fn) { updApp(s => { if(!s[sessKey])s[sessKey]=newSession(); fn(s[sessKey]); s[sessKey].modified=Date.now(); }); }
  function updSettings(fn) { updApp(s => { fn(s.settings); }); }

  const wheelNums = useMemo(() => getWheelNumbers(sess.roulette), [sess.roulette]);
  const nonClosedTracks = sess.tracks.filter(t=>t.state!=="closed");
  const primaryTrack = sess.tracks.find(t=>t.id===selectedTrackId&&t.state!=="closed") || sess.tracks.find(t=>t.state==="active") || null;
  const nextColorIdx = sess.tracks.length % TRACK_COLORS.length;
  const trackOverlays = sess.tracks.filter(t=>t.state==="active").map(t => ({
    ...t.config, type:t.type, color:t.color, id:t.id,
    activeBets:t.type==="solution"?(t.config.activeBets||[]):undefined,
  }));
  const primFibTbl = primaryTrack&&primaryTrack.type==="fibonacci" ? computeTableForTrack(primaryTrack) : [];
  const primFibRow = primFibTbl[Math.min(primaryTrack?primaryTrack.level:0, primFibTbl.length-1)] || null;
  const solTable = primaryTrack&&primaryTrack.type==="solution" ? computeTableForTrack(primaryTrack) : [];
  // The default entry threshold is the founder's setting (engine.js solEntryDefault). A Solution track keeps its own.
  const solDefaultEntry = solEntryDefault(settings);
  const solEntryThreshold = primaryTrack&&primaryTrack.type==="solution" ? primaryTrack.config.entryThreshold : solDefaultEntry;

  // The Solution's in-range numbers, coldest first: the one predicate (engine.js solutionInRange).
  const inRange = useMemo(() => solutionInRange(sess.droughts, wheelNums, solEntryThreshold),
    [sess.droughts, solEntryThreshold, wheelNums]);

  // Solution candidates visible even without active Solution track
  const solCandidates = useMemo(() => {
    if(primaryTrack&&primaryTrack.type==="solution") return [];
    return solutionInRange(sess.droughts, wheelNums, solDefaultEntry);
  }, [sess.droughts, primaryTrack, wheelNums, solDefaultEntry]);

  // Even money droughts, each with its percentile on this wheel (streakPercentile, percentile.js)
  const emDroughts = useMemo(() =>
    EVEN_MONEY.map(em=>{const drought=countDrought(sess.spins, em.pred); return {...em, drought, pct:streakPercentile(em.key, sess.roulette, drought)};}),
    [sess.spins, sess.roulette]);

  const {doz:dozD, col:colD, dozP, colP} = useMemo(() => {
    const doz=[0,0,0], col=[0,0,0];
    for(let d=0;d<3;d++){let s=0;for(let i=sess.spins.length-1;i>=0;i--){if(dozenOf(sess.spins[i])===d)break;s++;}doz[d]=s;}
    for(let c=0;c<3;c++){let s=0;for(let i=sess.spins.length-1;i>=0;i--){if(columnOf(sess.spins[i])===c)break;s++;}col[c]=s;}
    return{
      doz, col,
      dozP: doz.map((d,i)=>streakPercentile("dozen:"+i, sess.roulette, d)),
      colP: col.map((c,i)=>streakPercentile("column:"+i, sess.roulette, c)),
    };
  }, [sess.spins, sess.roulette]);

  // Onboarding -- AFTER all hooks so rules of hooks are satisfied
  if(window.parent===window&&new URLSearchParams(window.location.search).get("enableNotifications")==="1") return <NotificationEnablePage/>;
  if(window.parent!==window&&casinoSync.status==="checking") return <div role="status" style={{minHeight:"100vh",display:"grid",placeItems:"center",background:"#0f1923",color:"#94a3b8",fontSize:13}}>Loading your Roulette account…</div>;
  if(!settings.onboarded) {
    return (
      <OnboardingScreen
        initialBankroll={settings._restartBankroll}
        onComplete={choices => completeOnboarding(updApp, choices)}
      />
    );
  }

  const totalInvested = sess.bankroll + (sess.totalBuyIn||0);
  const totalCashedOut = sess.totalCashOut||0;
  const pnlVal = sess.bankrollCurrent + totalCashedOut - totalInvested;
  const pnlColor = pnlVal>0?"#4ade80":pnlVal<0?"#f87171":"#e2e8f0";

  function tapNumber(val, fromTracker, deferCasinoRecord) {
    if(boardReturn&&boardReturn.kind==="status") setBoardReturn(null); // a spin entered by hand ends a photo status
    if(fromTracker) {
      setPrevSessState(JSON.parse(JSON.stringify(sess)));
      // Auto-start session clock on first tracked spin
      if(!sess.sessionStartedAt) {
        updSess(s=>{ s.sessionStartedAt=Date.now(); });
      }
    }
    let spinOutcome={totalDelta:0,trackResults:[]};
    updSess(s => { spinOutcome=applySpin(s,val,fromTracker); Object.assign(s,spinOutcome.sess); });
    const {trackResults,totalDelta}=spinOutcome;
    if(trackResults.length>0) { setResult({val,trackResults,totalDelta}); setLastSpinDelta(totalDelta); }
    if(!deferCasinoRecord&&(appMode==="live"||appMode==="game")) {
      const wager=fromTracker?summarizeTrackWagers(sess.tracks,val):mergeWagerSummaries();
      const recording=recordingForMode(appMode,gameRecording,liveRecording);
      recording.record({segment:String(val),...wager,watched:wager.staked===0});
    }
    // Visual flash
    setFlashNum(val);
    setTimeout(()=>setFlashNum(null), 400);
    // Haptic vibration
    if(settings.vibration!==false && navigator.vibrate) {
      navigator.vibrate(totalDelta>0 ? [30,20,80] : totalDelta<0 ? 40 : 20);
    }
  }

  function doBuyIn(amount) {
    updSess(s => { Object.assign(s, applyBuyIn(s, amount, Date.now())); });
  }

  function doCashOut(amount) {
    updSess(s => { Object.assign(s, applyCashOut(s, amount, Date.now())); });
  }

  function changeCurrency(newCode, mode) {
    updApp(s => {
      const oldCode = s.settings.currency;
      s.settings.currency = newCode;
      if(mode==="convert" && oldCode!==newCode) {
        const ratio = getCurrency(newCode).rate / getCurrency(oldCode).rate;
        ["currentSession","gameSession"].forEach(function(sk){
          if(!s[sk]) return;
          s[sk].bankroll = Math.round(s[sk].bankroll*ratio*100)/100;
          s[sk].bankrollCurrent = Math.round(s[sk].bankrollCurrent*ratio*100)/100;
          s[sk].totalBuyIn = Math.round((s[sk].totalBuyIn||0)*ratio*100)/100;
          s[sk].tracks.forEach(t => {
            t.config.stopLoss = Math.round(t.config.stopLoss*ratio*100)/100;
          });
        });
      }
    });
  }

  function addTrack(type, config) { updSess(s=>{const t=newTrack(type,nextColorIdx,config,pickTrackColor(type,config,s.tracks)); t.createdAtSpin=s.spins.length; s.tracks.push(t);}); setAddOpen(false); setPendingTrackType("fibonacci"); setPendingTrackCfg(defaultFibCfg()); }
  function undoLastSpin() {
    if(!prevSessState) return;
    if(!window.confirm("Undo last tracked spin? This reverses the bankroll and progression but session time continues.")) return;
    const preservedStart = sess.sessionStartedAt;
    updApp(s => {
      s[sessKey] = prevSessState;
      s[sessKey].sessionStartedAt = preservedStart;
    });
    setPrevSessState(null);
  }
  // Clear numbers empties the live session's spins and what is derived from them. Money and the session
  // record are not touched, and the session is stamped modified. The snapshot holds only what the clear
  // changes, so Undo can put exactly that back and leave anything done since (buy-ins, cash-outs) alone.
  function clearNumbers() {
    const now = Date.now();
    const snapshot = {
      spinState: snapshotSpinState(appState.currentSession),
      prevSessState: prevSessState ? JSON.parse(JSON.stringify(prevSessState)) : null,
      lastSpinDelta,
    };
    updApp(s => { s.currentSession = clearSpins(s.currentSession, now); });
    setPrevSessState(null);
    setLastSpinDelta(null);
    setClearOpen(false);
    setClearUndo({sessionId:appState.currentSession.id, snapshot});
  }
  function undoClearNumbers() {
    if(!clearUndo) return;
    const live = appState.currentSession;
    if(appMode!=="live" || live.id!==clearUndo.sessionId || live.spins.length>0) { setClearUndo(null); return; }
    const {snapshot} = clearUndo;
    updApp(s => { s.currentSession = restoreSpinState(s.currentSession, snapshot.spinState, Date.now()); });
    setPrevSessState(snapshot.prevSessState);
    setLastSpinDelta(snapshot.lastSpinDelta);
    setClearUndo(null);
  }
  // Long-press a recent number to correct it. spin-apply.js replays the session with the corrected spin; a session
  // whose record cannot be replayed is refused and nothing changes. The picker reads the same refusal to show it.
  function openSpinCorrection(index) { setSpinCorrection({index}); }
  function applySpinCorrection(index, value) {
    const result = correctSpin(appState.currentSession, index, value, Date.now());
    if(!result.ok) return result;
    if(result.changed) {
      updApp(s => { s.currentSession = result.session; });
      setPrevSessState(null); // Undo last spin would restore a session from before this correction
    }
    setSpinCorrection(null);
    return result;
  }
  function reactivateTrack(id) {
    updSess(s=>{
      const t=s.tracks.find(x=>x.id===id);
      if(t){ t.state="active"; }
    });
    setTab(0);
    setHighlightTrackId(id);
    setTimeout(()=>setHighlightTrackId(null), 2000);
  }
  function moveTrack(fromId, toId) {
    updSess(s=>{
      const fi=s.tracks.findIndex(t=>t.id===fromId);
      const ti=s.tracks.findIndex(t=>t.id===toId);
      if(fi>=0&&ti>=0&&fi!==ti){const [item]=s.tracks.splice(fi,1);s.tracks.splice(ti,0,item);}
    });
  }
  function updateTrackConfig(id, newCfg) {
    updSess(s=>{
      const t=s.tracks.find(x=>x.id===id);
      if(!t) return;
      // Check if anything actually changed
      const changed = Object.keys(newCfg).some(k => JSON.stringify(newCfg[k]) !== JSON.stringify(t.config[k]));
      if(!changed) return;
      // A Solution track is edited in place: its held bets, their levels and the chased number are kept (editedTrackConfig).
      // A Progression or Custom Bet track is too when its only change is the base (canEditInPlace, BaseBetInput.jsx).
      const inPlace = canEditInPlace(t,newCfg);
      if(inPlace) rebaseTrackPnl(t,newCfg.unit);
      if(t.type==="solution") { t.config=editedTrackConfig(t.config,newCfg); return; }
      if(inPlace) { t.config=editedTrackConfig(t.config,newCfg); return; }
      // Park the original track, create new variation as active
      t.state = "parked";
      const mergedCfg = {...t.config, ...newCfg, activeBets: []};
      const colorIdx = s.tracks.length % TRACK_COLORS.length;
      const nt = newTrack(t.type, colorIdx, mergedCfg, pickTrackColor(t.type, mergedCfg, s.tracks));
      nt.state = "active";
      nt.createdAtSpin = s.spins.length;
      s.tracks.push(nt);
    });
    setEditTrackId(null);
  }
  function parkToggle(id) { updSess(s=>{const t=s.tracks.find(x=>x.id===id);if(t)t.state=t.state==="active"?"parked":"active";}); }
  function closeTrack(id) { updSess(s=>{const t=s.tracks.find(x=>x.id===id);if(t){t.state="closed";t.closedAtSpin=s.spins.length;}}); }
  // The in-range list's tap and the Active Bets ×: adds or removes one held bet (toggleSolBetConfig).
  function addSolBet(trackId, number) {
    updSess(s=>{
      const t=s.tracks.find(x=>x.id===trackId); if(!t||t.type!=="solution")return;
      t.config=toggleSolBetConfig(t.config,number);
    });
  }
  // The Solution picker's tap: this number becomes the chased one and its bet is added if not held. Every other held bet
  // stays with its level (chaseSolConfig).
  function chaseSolNumber(trackId, number) {
    updSess(s=>{
      const t=s.tracks.find(x=>x.id===trackId); if(!t||t.type!=="solution")return;
      t.config=chaseSolConfig(t.config,number);
    });
  }
  // The track setup's Entry Threshold stepper saves its value as the default for the next Solution track (settings.solEntryDefault).
  function setSolEntryDefault(v) { updApp(s=>{s.settings.solEntryDefault=v;}); }

  function saveSession() {
    let allSessions;
    updApp(s => {
      var sk = sessKey;
      s[sk].modified=Date.now();
      s[sk].mode=appMode;
      s[sk].metrics=computeMetrics(s[sk]);
      const idx=s.savedSessions.findIndex(x=>x.id===s[sk].id);
      if(idx>=0) s.savedSessions[idx]=JSON.parse(JSON.stringify(s[sk]));
      else s.savedSessions.push(JSON.parse(JSON.stringify(s[sk])));
      allSessions=s.savedSessions;
    });
    setTimeout(()=>autoExport(allSessions),300);
  }

  function endSession() {
    let allSessions;
    updApp(s => {
      var sk = sessKey;
      s[sk].sessionEndedAt = Date.now();
      s[sk].modified = Date.now();
      s[sk].mode=appMode;
      s[sk].metrics = computeMetrics(s[sk]);
      const idx = s.savedSessions.findIndex(x=>x.id===s[sk].id);
      if(idx>=0) s.savedSessions[idx]=JSON.parse(JSON.stringify(s[sk]));
      else s.savedSessions.push(JSON.parse(JSON.stringify(s[sk])));
      allSessions = s.savedSessions;
      s[sk] = newSession(s[sk].roulette, s[sk].bankrollCurrent);
    });
    setTimeout(()=>autoExport(allSessions),300);
    if(appMode==="live") liveRecording.stop(); else if(appMode==="game") gameRecording.stop();
    setTab(0);
  }

  function ghostSpin(val) {
    // Logs spin for drought tracking only -- no progression, no bankroll effect
    updSess(s => { Object.assign(s, applySpin(s, val, false).sess); });
    const recording=recordingForMode(appMode,gameRecording,liveRecording);
    recording.record({segment:String(val),...mergeWagerSummaries(),watched:true});
    setFlashNum(val);
    setTimeout(()=>setFlashNum(null), 300);
    if(settings.vibration!==false && navigator.vibrate) navigator.vibrate(15);
  }

  // F13: resume a saved session. The current session of the active mode is saved first; the saved copy becomes current in its own mode.
  function resumeSaved(id) {
    const target = saved.find(x=>x.id===id); if(!target) return;
    updApp(s=>{Object.assign(s, resumeSavedSession(s, id, appMode, Date.now()));});
    setAppMode(savedSessionMode(target));
  }
  function renameSaved(id, label) { updApp(s=>{Object.assign(s, renameSavedSession(s, id, label, Date.now()));}); }

  function tearSession() {
    if(!window.confirm("Tear this session?")) return;
    updApp(s=>{s.currentSession=newSession(s.currentSession.roulette,s.currentSession.bankroll);});
    liveRecording.stop();
    setTab(0);
  }

  function newEmptySession() {
    updApp(s=>{s.currentSession=newSession("american",500);});
    liveRecording.stop();
    setTab(0);
  }

  async function submitFeedback() {
    if(!feedbackText.trim()) return;
    const subject = encodeURIComponent("[Nexus Roulette Feedback] " + feedbackText.trim().slice(0, 60));
    const body = encodeURIComponent(feedbackText.trim() + "\n\n---\nv" + APP_VERSION + " · " + new Date().toLocaleString() + " · " + sess.spins.length + " spins");
    window.open("mailto:info@nexus-foundry.ai?subject=" + subject + "&body=" + body, "_self");
    setFeedbackText("");
    setFeedbackOpen(false);
  }

  function exportJSON() { exportSessionsJSON(saved); }

  function importJSON() { pickSessionsFile(updApp, setTab); }

  // Game-mode spin recording. GamePageView calls it once per spin.
  function recordGameSpin(val, casinoWager) {
    gameRecording.record({segment:String(val),...casinoWager,watched:casinoWager.staked===0});
  }

  // -- Game Page --
  // Declared inside App on purpose: a new component type on each render keeps the page remounting on every
  // App render, as the inner function did before the split.
  function GamePage() {
    return (
      <GamePageView
        addOpen={addOpen} addTrack={addTrack} animNumber={animNumber} betResults={betResults}
        clearTimerRef={clearTimerRef} closeTrack={closeTrack} colD={colD} colP={colP} cur={cur}
        currency={currency} dozD={dozD} dozP={dozP} editTrackId={editTrackId} emDroughts={emDroughts}
        endSession={endSession} recordGameSpin={recordGameSpin} gameResult={gameResult} gameSpinning={gameSpinning}
        isLandscape={isLandscape} lastBets={lastBets} lastSpinDelta={lastSpinDelta} manualBets={manualBets}
        nextColorIdx={nextColorIdx} nonClosedTracks={nonClosedTracks} parkToggle={parkToggle} pendingTrackCfg={pendingTrackCfg}
        pendingTrackType={pendingTrackType} pnlVal={pnlVal} saveSession={saveSession} selectedChip={selectedChip}
        sess={sess} setAddOpen={setAddOpen} setAnimNumber={setAnimNumber} setBetResults={setBetResults}
        setEditTrackId={setEditTrackId} setGameResult={setGameResult} setGameSpinning={setGameSpinning} setLastBets={setLastBets}
        setLastSpinDelta={setLastSpinDelta} setManualBets={setManualBets} setPendingTrackCfg={setPendingTrackCfg} setPendingTrackType={setPendingTrackType}
        setSelectedChip={setSelectedChip} setUndoStack={setUndoStack} settings={settings} tapNumber={tapNumber}
        updSess={updSess} updateTrackConfig={updateTrackConfig} wheelNums={wheelNums}
      />
    );
  }

  // -- Tracker Page --
  function TrackerPage() {
    const dts = primaryTrack&&primaryTrack.type==="fibonacci" ? primaryTrack.config.dozenTargets||[] : [];
    const cts = primaryTrack&&primaryTrack.type==="fibonacci" ? primaryTrack.config.colTargets||[] : [];
    const hasMix = dts.length>0&&cts.length>0;
    const row = primFibRow;
    const outcomes = row ? {
      partial:{ret:3*row.c,profit:3*row.c-row.totalInvest},
      jackpot:hasMix?{ret:6*row.c,profit:6*row.c-row.totalInvest}:null
    } : null;
    const solBets = primaryTrack&&primaryTrack.type==="solution" ? primaryTrack.config.activeBets||[] : [];
    // The chased number of the Solution track on the panel (null when none, or after a hit); the Active Bets, the picker and the grid read it.
    const solChase = primaryTrack&&primaryTrack.type==="solution" ? solutionChase(primaryTrack,sess.spins) : null;

    return (
      <div style={{display:"flex",flexDirection:"column",gap:10,width:"100%"}}>

        {/* Session clock */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:"#0c1520",borderRadius:10,padding:"8px 14px",border:"1px solid #2d4057"}}>
          <div>
            {sess.sessionStartedAt
              ? <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:"#4ade80",animation:"pulse 1.5s infinite"}}/>
                  <span style={{fontSize:12,color:"#94a3b8"}}>Session Active</span>
                  <SessionClock startedAt={sess.sessionStartedAt} pauseOffset={livePauseOffset} style={{fontSize:16,fontWeight:800,color:"#4ade80",fontVariantNumeric:"tabular-nums"}}/>
                </div>
              : <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:"#fbbf24"}}/>
                  <span style={{fontSize:12,color:"#fbbf24"}}>Catch-up Mode</span>
                  <span style={{fontSize:10,color:"#64748b"}}>-- spin any number to start session</span>
                </div>
            }
          </div>
          {sess.sessionStartedAt && (
            <button onClick={()=>{if(window.confirm("End session and save?"))venueSheets.requestEnd();}} style={{padding:"6px 12px",borderRadius:8,border:"1px solid #7f1d1d",background:"#200505",color:"#f87171",fontSize:11,fontWeight:700,cursor:"pointer"}}>■ End Session</button>
          )}
        </div>
        {/* Venue line (F11): one row whether or not a venue is recorded, so the header does not move when one is added. */}
        <div style={{display:"flex",alignItems:"center",gap:8,minHeight:30,minWidth:0}}>
          <span style={{flex:"1 1 0",minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize:12,color:sess.venue?"#cbd5e1":"#64748b"}}>{venueLine(sess.venue)||"No venue recorded"}</span>
          <button onClick={()=>venueSheets.openEdit("current")} style={{flex:"0 0 auto",padding:"5px 10px",borderRadius:8,border:"1px solid #2d4057",background:"#1e2d3d",color:"#60a5fa",fontSize:11,cursor:"pointer"}}>{sess.venue?"Edit venue":"Add venue"}</button>
        </div>
        <SpinTools spinCount={sess.spins.length} confirmOpen={clearOpen} undoVisible={!!clearUndo&&clearUndo.sessionId===appState.currentSession.id&&appState.currentSession.spins.length===0} onAsk={()=>setClearOpen(true)} onCancel={()=>setClearOpen(false)} onConfirm={clearNumbers} onUndo={undoClearNumbers} onReadPhoto={()=>openBoardPhoto(window.location,sess.roulette,setBoardReturn)}/>
        <BoardPhotoStatus result={boardReturn}/>
        <SpinCorrectionContext.Provider value={openSpinCorrection}>
          <RecentNumbersStrip spins={sess.spins} trackOverlays={trackOverlays}/>
        </SpinCorrectionContext.Provider>
        {spinCorrection && spinCorrection.index<sess.spins.length && (
          <SpinNumberPicker spinIndex={spinCorrection.index} spinCount={sess.spins.length} currentValue={sess.spins[spinCorrection.index]} roulette={sess.roulette} blockedReason={spinCorrectionBlock(sess)} onChoose={v=>applySpinCorrection(spinCorrection.index,v)} onClose={()=>setSpinCorrection(null)}/>
        )}

        {/* Roulette Table for Live Mode */}
        {(()=>{
          const tMin = settings.tableMinBet||1;
          const CHIPS = CHIP_DENOMS.filter(c=>c.val>=tMin);
          const liveTotalBet=liveManualBets.reduce((s,b)=>s+b.amount,0);
          const liveBoardBets={}; liveManualBets.forEach(b=>{const key=b.type==="straight"?"s:"+b.target:b.type+(b.target!==undefined?":"+b.target:"");liveBoardBets[key]=(liveBoardBets[key]||0)+b.amount;});
          const stratBets={}; nonClosedTracks.filter(t=>t.state==="active").forEach(t=>{
            if(t.type==="fibonacci"){(t.config.dozenTargets||[]).forEach(d=>{stratBets["dozen:"+d]=t.color;});(t.config.colTargets||[]).forEach(c=>{stratBets["column:"+c]=t.color;});(t.config.evenTargets||[]).forEach(key=>{stratBets[key]=t.color;});}
            if(t.type==="solution"){(t.config.activeBets||[]).forEach(b=>{if(!stratBets["s:"+b.number])stratBets["s:"+b.number]=t.color;});}
            if(t.type==="custom"){(t.config.positions||[]).forEach(function(p){var pk=p.type==="straight"?"s:"+p.target:p.type+(p.target!==undefined?":"+p.target:"");if(!stratBets[pk])stratBets[pk]=t.color;});}
          });
          function livePlaceBet(type,target){
            if(liveSelectingWinner){var val=type==="straight"?target:null;if(!val)return;var casinoWager=mergeWagerSummaries(summarizeTrackWagers(sess.tracks,val),summarizeManualWagers(liveManualBets,val));setLiveWinNumber(val);tapNumber(val,nonClosedTracks.some(t=>t.state==="active"),true);
              if(liveManualBets.length>0){var totalWin=0,totalBet=0,posResults={};liveManualBets.forEach(function(b){totalBet+=b.amount;var posKey=b.type==="straight"?"s:"+b.target:b.type+(b.target!==undefined?":"+b.target:"");var covered=betCoveredNumbers(b.type,b.target);if(covered.indexOf(val)>=0){totalWin+=b.amount*betPayoutMult(b.type);posResults[posKey]="won";}else{if(!posResults[posKey])posResults[posKey]="lost";}});
              updSess(s=>{s.bankrollCurrent=Math.round((s.bankrollCurrent+(totalWin-totalBet))*100)/100;});setLiveBetResults(posResults);setLiveLastBets([...liveManualBets]);setLiveUndoStack([]);liveClearTimerRef.current=setTimeout(()=>{setLiveBetResults(null);setLiveManualBets([]);liveClearTimerRef.current=null;},3000);}
              liveRecording.record({segment:String(val),...casinoWager,watched:casinoWager.staked===0});setLiveSelectingWinner(true);return;}
            if(liveBetResults){if(liveClearTimerRef.current){clearTimeout(liveClearTimerRef.current);liveClearTimerRef.current=null;}setLiveBetResults(null);setLiveManualBets([]);}
            setLiveWinNumber(null);setLiveManualBets(prev=>[...prev,{id:Date.now()+Math.random(),type:type,target:target,amount:selectedChip}]);setLiveUndoStack(prev=>[...prev,1]);if(settings.vibration!==false&&navigator.vibrate)navigator.vibrate(10);
          }
          function liveUndoBet(){if(liveBetResults)return;setLiveUndoStack(prev=>{if(prev.length===0)return prev;const count=prev[prev.length-1];setLiveManualBets(mb=>mb.slice(0,-count));return prev.slice(0,-1);});}
          function liveClearBets(){setLiveManualBets([]);setLiveUndoStack([]);}
          function liveDoubleBets(){if(liveBetResults)return;setLiveManualBets(prev=>{setLiveUndoStack(us=>[...us,prev.length]);return[...prev,...prev.map(b=>({...b,id:Date.now()+Math.random()}))];});}
          function liveRepeatBets(){if(liveLastBets.length===0)return;if(liveClearTimerRef.current){clearTimeout(liveClearTimerRef.current);liveClearTimerRef.current=null;}if(liveBetResults){setLiveBetResults(null);setLiveManualBets([]);}const repeated=liveLastBets.map(b=>({...b,id:Date.now()+Math.random()}));setLiveManualBets(repeated);setLiveUndoStack([repeated.length]);}
          return (
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              <button onClick={()=>setLiveSelectingWinner(!liveSelectingWinner)} style={{width:"100%",padding:"12px 0",borderRadius:10,border:liveSelectingWinner?"2px solid #fbbf24":"2px solid #2d4057",background:liveSelectingWinner?"linear-gradient(135deg,#92400e,#78350f)":"#0f1923",color:liveSelectingWinner?"#fbbf24":"#94a3b8",fontSize:13,fontWeight:800,cursor:"pointer"}}>{liveSelectingWinner?"👆 Tap the winning number...":"🎯 Choose Winning Number"}</button>
              <RouletteBoard pickNumbers={liveSelectingWinner} roulette={sess.roulette} winningNumber={liveWinNumber} stratBets={stratBets} spinning={false} onBet={livePlaceBet} boardBets={liveBoardBets} chipColor={(CHIPS.find(c=>c.val===selectedChip)||CHIPS[0]).color} betResults={liveBetResults} stratChips={computeStratChips(nonClosedTracks)} landscape={isLandscape} droughts={sess.droughts} spins={sess.spins} showDroughts={settings.showDroughtCounts!==false} headStart={settings.headStartUnseen===true} counterShows={settings.counterShows} percentileOutlines={settings.percentileOutlines}/>
              <div style={{display:"flex",gap:3,justifyContent:"center",flexWrap:"wrap"}}>{CHIPS.map(c=>(<button key={c.val} onClick={()=>{setSelectedChip(c.val);setLiveSelectingWinner(false);}} style={{width:34,height:34,borderRadius:"50%",border:"2px solid "+(selectedChip===c.val&&!liveSelectingWinner?"#fbbf24":c.border),background:c.color,color:c.val>=100?"#fff":c.val<=0.5?"#1e293b":"#1e293b",fontSize:c.val<1?6:8,fontWeight:900,cursor:"pointer",boxShadow:selectedChip===c.val&&!liveSelectingWinner?"0 0 8px #fbbf24":"none",display:"flex",alignItems:"center",justifyContent:"center"}}>{c.label}</button>))}</div>
              <div style={{display:"flex",gap:3}}><button onClick={liveUndoBet} disabled={liveManualBets.length===0||!!liveBetResults} style={{flex:1,padding:"5px 0",borderRadius:6,border:"1px solid #2d4057",background:"#0f1923",color:liveManualBets.length>0&&!liveBetResults?"#60a5fa":"#374151",fontSize:8,fontWeight:700}}>↩Undo</button><button onClick={liveClearBets} disabled={liveManualBets.length===0||!!liveBetResults} style={{flex:1,padding:"5px 0",borderRadius:6,border:"1px solid #2d4057",background:"#0f1923",color:liveManualBets.length>0&&!liveBetResults?"#f87171":"#374151",fontSize:8,fontWeight:700}}>✕Clear</button><button onClick={liveDoubleBets} disabled={liveManualBets.length===0||!!liveBetResults} style={{flex:1,padding:"5px 0",borderRadius:6,border:"1px solid #2d4057",background:"#0f1923",color:liveManualBets.length>0&&!liveBetResults?"#fbbf24":"#374151",fontSize:8,fontWeight:700}}>2×</button><button onClick={liveRepeatBets} disabled={liveLastBets.length===0} style={{flex:1,padding:"5px 0",borderRadius:6,border:"1px solid #2d4057",background:"#0f1923",color:liveLastBets.length>0?"#86efac":"#374151",fontSize:8,fontWeight:700}}>♻Rpt</button></div>
              {liveTotalBet>0&&<div style={{textAlign:"center",fontSize:10,fontWeight:800,color:"#fbbf24"}}>Bet: {cur.symbol}{formatNumber(liveTotalBet)}</div>}
              <div style={{textAlign:"center",fontSize:8,color:"#374151"}}>center=straight · edge=split · corner=corner</div>
            </div>
          );
        })()}

        {/* Drought panel. Its slot is reserved at DROUGHT_PANEL_HEIGHT and hidden, not removed, when there are no numbers, so clearing moves nothing below it. */}
        <div aria-hidden={sess.spins.length===0} style={{minHeight:DROUGHT_PANEL_HEIGHT,visibility:sess.spins.length>0?"visible":"hidden"}}>
          <DroughtPanel emDroughts={emDroughts} dozD={dozD} colD={colD} dozP={dozP} colP={colP} spins={sess.spins} droughts={sess.droughts} roulette={sess.roulette}/>
        </div>

        {/* Track cards with drag-to-reorder */}
        <FieldLabel>Active Strategy Tracks</FieldLabel>
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {nonClosedTracks.map((t,idx) => {
            const tbl=computeTableForTrack(t);
            const isSel=selectedTrackId===t.id;
            const isHighlight=highlightTrackId===t.id;
            const isDragging=draggingId===t.id;
            const isDragOver=dragOverId===t.id;
            const isEditing=editTrackId===t.id;
            const dolPnl=t.pnl*(t.config.unit||1);
            return (
              <div key={t.id}>
                <div
                  onTouchStart={e=>{if(e.target.dataset.handle){e.preventDefault();setDraggingId(t.id);}}}
                  onTouchMove={e=>{if(draggingId&&draggingId!==t.id){e.preventDefault();setDragOverId(t.id);}}}
                  onTouchEnd={()=>{if(draggingId&&dragOverId){moveTrack(draggingId,dragOverId);}setDraggingId(null);setDragOverId(null);}}
                  onClick={()=>setSelectedTrackId(isSel?null:t.id)}
                  style={{background:"#0f1923",borderRadius:12,padding:"10px 12px",border:"2px solid "+(isHighlight?"#ffffff":isEditing?"#60a5fa":isDragOver?"#60a5fa":isSel?t.color:"#2d4057"),cursor:"pointer",opacity:isDragging?0.4:1,transition:"border 0.3s,opacity 0.2s"}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                    <span data-handle="1" style={{fontSize:14,color:"#374151",cursor:"grab",userSelect:"none",touchAction:"none",flexShrink:0}}>⠿</span>
                    <div style={{width:10,height:10,borderRadius:"50%",background:t.color,flexShrink:0}}/>
                    <span style={{fontSize:11,fontWeight:700,color:t.color,flex:1}}>{TRACK_ICONS[t.type]} {t.type==="fibonacci"?"Progression Bet":t.type==="custom"?"Custom Bet":"The Solution"}</span>
                    <span style={{fontSize:9,color:t.state==="active"?"#4ade80":t.state==="parked"?"#fbbf24":"#94a3b8",fontWeight:700}}>[{t.state.toUpperCase()}]</span>
                    <span style={{fontSize:12,fontWeight:800,color:dolPnl>=0?"#4ade80":"#f87171"}}>{dolPnl>=0?"+":"-"}{cur.symbol}{formatNumber(dolPnl)}</span>
                  </div>
                  {t.type==="solution" && <div style={{fontSize:10,color:t.color,fontWeight:700,height:14,lineHeight:"14px",marginBottom:4,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{solutionChaseText(t,sess.droughts,sess.spins)}</div>}
                  <BetTargets type={t.type} config={t.config} style={{marginBottom:6}}/>
                  <div style={{display:"flex",gap:8,marginBottom:6}}>
                    <span style={{fontSize:10,color:"#94a3b8"}}>Lvl <strong style={{color:t.level>=10?"#f87171":t.level>=6?"#fbbf24":"#e2e8f0"}}>{t.level}</strong>/{tbl.length}</span>
                  </div>
                  <div style={{display:"flex",gap:5}}>
                    <button onClick={e=>{e.stopPropagation();parkToggle(t.id);}} style={{flex:1,padding:"4px 0",borderRadius:6,border:"1px solid #2d4057",background:t.state==="parked"?"#134e2a":"#1e2d3d",color:t.state==="parked"?"#4ade80":"#94a3b8",fontSize:9,fontWeight:700,cursor:"pointer"}}>{t.state==="parked"?"▶ Resume":"⏸ Park"}</button>
                    <button onClick={e=>{e.stopPropagation();setEditTrackId(isEditing?null:t.id);}} style={{padding:"4px 8px",borderRadius:6,border:"1px solid "+(isEditing?"#60a5fa":"#1e3a5f"),background:isEditing?"#1e3a5f":"transparent",color:"#60a5fa",fontSize:9,cursor:"pointer"}}>✏️ Edit</button>
                    <button onClick={e=>{e.stopPropagation();if(window.confirm("Close track?"))closeTrack(t.id);}} style={{padding:"4px 8px",borderRadius:6,border:"1px solid #7f1d1d",background:"transparent",color:"#f87171",fontSize:9,cursor:"pointer"}}>×</button>
                  </div>
                </div>
                {isEditing && (
                  <EditTrackCfg track={t} currency={currency} tableMinBet={settings.tableMinBet||1} onSave={cfg=>updateTrackConfig(t.id,cfg)} onCancel={()=>setEditTrackId(null)}/>
                )}
              </div>
            );
          })}
          <div style={{display:"flex",gap:6}}>
            {!addOpen && (
              <button onClick={()=>setAddOpen(true)} style={{flex:1,padding:"10px 0",borderRadius:12,border:"2px dashed #2d4057",background:"transparent",color:"#64748b",fontSize:13,cursor:"pointer"}}>+ Add Track</button>
            )}
            {prevSessState && (
              <button onClick={undoLastSpin} style={{padding:"10px 14px",borderRadius:12,border:"1px solid #f59e0b",background:"#1c1000",color:"#fbbf24",fontSize:12,fontWeight:700,cursor:"pointer"}}>↩ Undo</button>
            )}
          </div>
        </div>

        {addOpen && <AddTrackPanel onAdd={addTrack} onClose={()=>setAddOpen(false)} nextColor={nextColorIdx} type={pendingTrackType} cfg={pendingTrackCfg} onTypeChange={(t)=>{setPendingTrackType(t);setPendingTrackCfg(t==="fibonacci"?defaultFibCfg():solDefaultCfg(settings));}} onCfgChange={setPendingTrackCfg} closedTracks={sess.tracks.filter(t=>t.state==="closed")} currency={currency} tableMinBet={settings.tableMinBet||1} droughts={sess.droughts} wheel={sess.roulette} solColor={pickTrackColor("solution",pendingTrackCfg,sess.tracks)} onEntryDefault={setSolEntryDefault}/>}

        {!primaryTrack && !addOpen && (
          <div style={{background:"#1e2d3d",borderRadius:14,padding:"20px",textAlign:"center",border:"1px dashed #2d4057"}}>
            <div style={{fontSize:24,marginBottom:8}}>🎲</div>
            <div style={{color:"#64748b",fontSize:13,marginBottom:12}}>No active tracks yet</div>
            <button onClick={()=>setAddOpen(true)} style={{padding:"10px 20px",borderRadius:10,border:"none",background:"#16a34a",color:"white",fontSize:13,fontWeight:700,cursor:"pointer"}}>+ Add First Strategy</button>
          </div>
        )}

        {/* Solution candidates -- shown even without active Solution track */}
        {solCandidates.length>0 && (
          <Card>
            <FieldLabel>{"🎯 Solution Candidates ("+solCandidates.length+")"}</FieldLabel>
            <div style={{fontSize:10,color:"#64748b",marginBottom:6}}>Tap a number to start tracking it with The Solution</div>
            <SolutionPicker droughts={sess.droughts} wheel={sess.roulette} threshold={solDefaultEntry} count={Math.max(6,Math.min(20,solCandidates.length))} chosen={null} color="#f59e0b"
              onChoose={num=>{setPendingTrackType("solution");setPendingTrackCfg({...solDefaultCfg(settings),activeBets:[{number:num,level:0,invest:0}],chaseNumber:num});setAddOpen(true);}}/>
          </Card>
        )}

        {primaryTrack && primaryTrack.type==="fibonacci" && (
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {hasMix && outcomes && outcomes.jackpot && (
              <div style={{background:"#1c1500",borderRadius:14,padding:12,border:"1px solid #f59e0b"}}>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                  {[{l:"JP Bet",v:row?formatChips(row.totalBet,primaryTrack.config.unit,currency):"--",c:"#fbbf24"},{l:"JP Return",v:formatMoney(outcomes.jackpot.ret*(primaryTrack.config.unit||1),currency),c:"#fbbf24"},{l:"JP Profit",v:(outcomes.jackpot.profit*(primaryTrack.config.unit||1)>=0?"+":"-")+cur.symbol+Math.abs(outcomes.jackpot.profit*(primaryTrack.config.unit||1)).toFixed(cur.dec),c:outcomes.jackpot.profit>=0?"#4ade80":"#f87171"}].map(({l,v,c}) => (
                    <div key={l} style={{textAlign:"center"}}>
                      <div style={{fontSize:8,color:"#78350f",textTransform:"uppercase",marginBottom:2}}>{l}</div>
                      <div style={{fontSize:16,fontWeight:800,color:c}}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <Card>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <div style={{width:10,height:10,borderRadius:"50%",background:primaryTrack.color}}/>
                  <span style={{fontSize:11,color:"#94a3b8",textTransform:"uppercase",letterSpacing:1}}>Miss Level</span>
                </div>
                <span style={{fontSize:26,fontWeight:800,color:primaryTrack.level>=10?"#f87171":primaryTrack.level>=6?"#fbbf24":"#86efac"}}>
                  {primaryTrack.level}<span style={{fontSize:12,color:"#475569",fontWeight:400}}>/{primFibTbl.length}</span>
                </span>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
                {[{l:"Bet/Spin",v:row?formatChips(row.totalBet,primaryTrack.config.unit,currency):"--",c:"#60a5fa"},{l:"Total Spent",v:row?formatChips(row.totalInvest,primaryTrack.config.unit,currency):"--",c:"#f87171"},{l:"Partial Win",v:outcomes?formatMoney(outcomes.partial.ret*(primaryTrack.config.unit||1),currency):"--",c:"#a78bfa"},{l:"Partial Profit",v:outcomes?signChips(outcomes.partial.profit,primaryTrack.config.unit||1,currency):"--",c:outcomes&&outcomes.partial.profit>=0?"#4ade80":"#f97316"}].map(({l,v,c}) => (
                  <div key={l} style={{background:"#0f1923",borderRadius:10,padding:"10px 8px",textAlign:"center",border:"1px solid #2d4057"}}>
                    <div style={{fontSize:8,color:"#64748b",textTransform:"uppercase",marginBottom:2}}>{l}</div>
                    <div style={{fontSize:16,fontWeight:800,color:c}}>{v}</div>
                  </div>
                ))}
              </div>
              <FibGrid onNumber={v=>tapNumber(v,true)} onGhost={ghostSpin} dozenTargets={dts} colTargets={cts} fibRow={row} trackOverlays={trackOverlays.filter(o=>o.id!==primaryTrack.id)} flashNum={flashNum} roulette={sess.roulette} droughts={sess.droughts} spins={sess.spins} showDroughts={settings.showDroughtCounts!==false} headStart={settings.headStartUnseen===true} counterShows={settings.counterShows}/>
              <div style={{textAlign:"center",fontSize:9,color:"#374151",marginTop:4}}>Long-press any number to log as ghost spin (no progression)</div>
              {primaryTrack.level>=primFibTbl.length-1&&primFibTbl.length>0 && (
                <div style={{marginTop:8,background:"#7f1d1d",borderRadius:8,padding:8,textAlign:"center",fontSize:11,color:"#fca5a5"}}>Stop loss reached!</div>
              )}
            </Card>
          </div>
        )}

        {primaryTrack && primaryTrack.type==="solution" && (
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            <Card>
              <div style={{fontSize:12,fontWeight:800,color:primaryTrack.color,height:16,lineHeight:"16px",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{solutionChaseText(primaryTrack,sess.droughts,sess.spins)}</div>
            </Card>
            <SolActiveBets bets={solBets} table={solTable} chase={solChase} track={primaryTrack} currency={currency} onToggle={num=>addSolBet(primaryTrack.id,num)}/>
            <Card>
              <FieldLabel>Coldest numbers - tap one to chase it</FieldLabel>
              <SolutionPicker droughts={sess.droughts} wheel={sess.roulette} threshold={solEntryThreshold} count={6} chosen={solChase?solChase.number:null} color={primaryTrack.color}
                onChoose={num=>chaseSolNumber(primaryTrack.id,num)}/>
            </Card>
            <Card>
              <FieldLabel>{inRange.length>0?inRange.length+" numbers at or past entry":"No numbers in range yet"}</FieldLabel>
              <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                {inRange.map(num => {
                  const d=sess.droughts[num]||0, isAct=solBets.some(b=>b.number===num);
                  const over=d-solEntryThreshold, deep=d>solEntryThreshold+solTable.length;
                  return (
                    <button key={num} onClick={()=>addSolBet(primaryTrack.id,num)} style={{padding:"7px 9px",borderRadius:9,cursor:"pointer",textAlign:"center",minWidth:48,border:(isAct?"2":"1")+"px solid "+(isAct?primaryTrack.color:deep?"#dc2626":"#f59e0b"),background:isAct?"#0d2a0d":deep?"#200505":"#1c1000"}}>
                      <div style={{fontSize:14,fontWeight:900,color:RED.has(+num)?"#f87171":"#f1f5f9"}}>{num}</div>
                      <div style={{fontSize:8,color:deep?"#f87171":"#fbbf24",fontWeight:700}}>+{over}</div>
                    </button>
                  );
                })}
              </div>
            </Card>
            <Card>
              <FieldLabel>Tap Winning Number</FieldLabel>
              <SolGrid onNumber={v=>tapNumber(v,true)} droughts={sess.droughts} entry={solEntryThreshold} maxLvl={solTable.length} activeBets={solBets} wheelNums={wheelNums} trackOverlays={trackOverlays.filter(o=>o.id!==primaryTrack.id)} flashNum={flashNum} chasedNumber={solChase?solChase.number:null} chaseColor={primaryTrack.color}/>
            </Card>
          </div>
        )}

        {nonClosedTracks.filter(t=>t.state==="active").length>0 && (
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            <div style={{fontSize:10,color:"#64748b",textTransform:"uppercase",letterSpacing:1}}>Abandon Progression</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {nonClosedTracks.filter(t=>t.state==="active").map(t=>{
                const tbl=computeTableForTrack(t);
                const row=tbl[Math.min(t.level,tbl.length-1)];
                return(
                  <button key={t.id} onClick={()=>{if(window.confirm(`Abandon progression at level ${t.level}?`))updSess(s=>{const tr=s.tracks.find(x=>x.id===t.id);if(tr){tr.pnl-=row?row.totalInvest:0;tr.bets.push({type:"abandon",level:tr.level});tr.level=0;}});}}
                    style={{flex:1,padding:"8px 10px",borderRadius:9,border:"1px solid "+(t.color+"66"),background:"#0f1923",color:t.color,fontSize:11,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:5}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:t.color,flexShrink:0}}/>
                    {TRACK_ICONS[t.type]} {betTargetText(t.type,t.config,false,2)} · Lvl {t.level}
                  </button>
                );
              })}
            </div>
          </div>
        )}

      </div>
    );
  }
  // Declared inside App for the same reason as GamePage.
  function TablePage() {
    return <TablePageView sess={sess} selectedTrackId={selectedTrackId} setSelectedTrackId={setSelectedTrackId} nonClosedTracks={nonClosedTracks} cur={cur} selectedLevel={selectedLevel} setSelectedLevel={setSelectedLevel}/>;
  }

  // Secondary Live-mode pages are split out so this stateful coordinator stays below the source ceiling.

  // -- Bankroll Edit --
  function BankrollEdit({onClose}) {
    const [val, setVal] = useState(sess.bankrollCurrent);
    function save() { updSess(s=>{s.bankrollCurrent=val;}); onClose(); }
    return (
      <Modal onClose={onClose}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div style={{fontSize:17,fontWeight:800,color:"#e2e8f0"}}>Edit Bankroll</div>
          <button onClick={onClose} style={{background:"transparent",border:"none",color:"#64748b",fontSize:22,cursor:"pointer"}}>×</button>
        </div>
        <MoneyInput value={val} onChange={setVal} currCode={currency} label="Current Bankroll"/>
        <button onClick={save} style={{width:"100%",marginTop:16,padding:"14px 0",borderRadius:12,border:"none",background:"#16a34a",color:"white",fontSize:15,fontWeight:800,cursor:"pointer"}}>Save</button>
      </Modal>
    );
  }

  // -- Root --
  const TABS = ["Tracker","Full Table","Spin Log","Stats","Settings"];

  return (
    <div style={{minHeight:"100vh",background:"#0f1923",color:"#e2e8f0",fontFamily:"'Segoe UI',system-ui,sans-serif"}}>
      <div style={{width:"100%",maxWidth:isLandscape?9999:460,margin:"0 auto",display:"flex",flexDirection:"column",alignItems:"center",gap:isLandscape?4:12,padding:isLandscape?"4px 8px 8px":"16px 14px 80px",boxSizing:"border-box"}}>

        {/* Header */}
        <div style={{width:"100%",textAlign:"center"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10,marginBottom:4}}>
            <RouletteIcon size={28}/>
            <h1 style={{margin:0,fontSize:18,color:"#86efac",letterSpacing:1}}>Nexus Roulette Tracker</h1>
          </div>
          {/* Mode Toggle */}
          <div style={{display:"flex",justifyContent:"center",gap:6,marginTop:6,marginBottom:2}}>
            <button onClick={()=>setAppMode("game")} style={{padding:"5px 16px",borderRadius:20,border:"none",background:appMode==="game"?"#7c3aed":"#1e2d3d",color:appMode==="game"?"white":"#64748b",fontSize:11,fontWeight:700,cursor:"pointer"}}>🎮 Game</button>
            <button onClick={()=>setAppMode("live")} style={{padding:"5px 16px",borderRadius:20,border:"none",background:appMode==="live"?"#16a34a":"#1e2d3d",color:appMode==="live"?"white":"#64748b",fontSize:11,fontWeight:700,cursor:"pointer"}}>🎰 Live</button>
            <button onClick={()=>setAppMode("sim")} style={{padding:"5px 16px",borderRadius:20,border:"none",background:appMode==="sim"?"#c2410c":"#1e2d3d",color:appMode==="sim"?"white":"#64748b",fontSize:11,fontWeight:700,cursor:"pointer"}}>🔬 Experimental{simRunning&&!simDone?" ⏳":simDone?" ✅":""}</button>
          </div>
          {(appMode==="live"||appMode==="game") && (
            <div>
              <div style={{display:"flex",justifyContent:"center",alignItems:"center",gap:12,marginTop:4,flexWrap:"wrap"}}>
                <button onClick={()=>setEditBankroll(true)} style={{fontSize:12,color:"#64748b",background:"transparent",border:"none",cursor:"pointer",padding:0}}>
                  Bank: <strong style={{color:"#60a5fa"}}>{formatMoney(sess.bankrollCurrent,currency)}</strong> <span style={{fontSize:9,color:"#334155"}}>✏️</span>
                </button>
                <span style={{fontSize:12,color:"#64748b"}}>Profit: <strong style={{color:pnlColor}}>{pnlVal>=0?"+":"-"}{cur.symbol}{formatNumber(pnlVal)}</strong></span>
                <span style={{fontSize:12,color:"#64748b"}}>Spins: <strong style={{color:"#e2e8f0"}}>{sess.spins.length}</strong></span>
              </div>
              <div style={{display:"flex",gap:8,marginTop:8,justifyContent:"center"}}>
                <button onClick={()=>setBuyInOpen(true)} style={{padding:"8px 20px",borderRadius:20,border:"none",background:"#16a34a",color:"white",fontSize:12,fontWeight:700,cursor:"pointer"}}>💰 Buy In</button>
                <button onClick={()=>setCashOutOpen(true)} style={{padding:"8px 20px",borderRadius:20,border:"none",background:"#c2410c",color:"white",fontSize:12,fontWeight:700,cursor:"pointer"}}>💸 Cash Out</button>
              </div>
            </div>
          )}
        </div>

        {window.parent!==window&&(appMode==="live"||appMode==="game") && <CasinoRecordingBar recording={appMode==="live"?liveRecording:gameRecording} label={appMode==="live"?"Live mode":"Game mode"}/>}
        <CasinoSyncBar sync={casinoSync}/>

        {/* Storage failure banner */}
        {saveError && (
          <div style={{width:"100%",padding:"10px 14px",borderRadius:12,border:"2px solid #991b1b",background:"#200505",color:"#f87171",fontSize:12,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
            <span>⚠ Could not save to device storage — recent changes may be lost. ({saveError})</span>
            <button onClick={()=>setSaveError(null)} style={{padding:"4px 10px",borderRadius:8,border:"1px solid #7f1d1d",background:"transparent",color:"#f87171",fontSize:11,fontWeight:700,cursor:"pointer"}}>Dismiss</button>
          </div>
        )}

        {/* Update banner */}
        {updateAvailable && <UpdateBanner appState={appState} updateAvailable={updateAvailable}/>}

        {/* Version badge */}
        <div style={{fontSize:9,color:"#374151",textAlign:"center"}}>v{APP_VERSION}</div>

        {appMode==="sim" && <SimModePage simCfg={simCfg} setSimCfg={setSimCfg} simRunning={simRunning} setSimRunning={setSimRunning} simProgress={simProgress} setSimProgress={setSimProgress} simResults={simResults} setSimResults={setSimResults} simDone={simDone} setSimDone={setSimDone} simStopRef={simStopRef} currency={currency} cur={cur}/>}

        {appMode==="game" && <GamePage/>}

        {appMode==="live" && (
          <div style={{width:"100%",minWidth:0,overflow:"hidden"}}>
            {/* Statistical context bar -- informed by sim results if available */}
            {simDone && simResults && sess.tracks.length>0 && (
              <StatContextBar simResults={simResults} simCfg={simCfg} sess={sess} cur={cur} pnlVal={pnlVal}/>
            )}
            {/* Tabs */}
            <div style={{display:"flex",background:"#1e2d3d",borderRadius:12,padding:4,width:"100%",overflowX:"auto",marginBottom:0}}>
              {TABS.map((t,i) => (
                <button key={t} onClick={()=>setTab(i)} style={{flex:1,padding:"9px 2px",borderRadius:9,border:"none",cursor:"pointer",background:tab===i?"#134e2a":"transparent",color:tab===i?"#86efac":"#64748b",fontSize:9,fontWeight:700,whiteSpace:"nowrap"}}>{t}</button>
              ))}
            </div>
            {tab===0 && <TrackerPage/>}
            {tab===1 && <TablePage/>}
            {tab===2 && <SpinPage sess={sess} updSess={updSess} trackOverlays={trackOverlays}/>}
            {tab===3 && <StatsPage sess={sess} livePauseOffset={livePauseOffset} pnlVal={pnlVal} cur={cur} currency={currency} pnlColor={pnlColor} saveSession={saveSession} newEmptySession={newEmptySession} tearSession={tearSession} reactivateTrack={reactivateTrack} saved={saved} resumeSaved={resumeSaved} renameSaved={renameSaved} addCatchUp={setBoardAdd} readPhoto={()=>openBoardPhoto(window.location,sess.roulette,setBoardReturn)} exportJSON={exportJSON} venueSession={appMode==="live"} onEditVenue={venueSheets.openEdit}/>}
            {tab===4 && <SettingsPage settings={settings} updSettings={updSettings} setCurrencyOpen={setCurrencyOpen} currency={currency} cur={cur} updSess={updSess} sess={sess} setChangelogOpen={setChangelogOpen} updApp={updApp} importJSON={importJSON} setHardResetOpen={setHardResetOpen}/>}
          </div>
        )}

      {/* Modals */}
      {appMode==="live" && boardReturn && boardReturn.kind==="numbers" && <BoardPhotoReview numbers={boardReturn.numbers} roulette={sess.roulette} onAdd={addBoardNumbers} onCancel={()=>setBoardReturn(null)}/>}
      {result && <ResultFlash result={result} cur={cur} onDismiss={()=>setResult(null)}/>}
      {buyInOpen && <BuyInModal defaultAmount={settings.defaultBuyIn||100} currency={currency} currentBankroll={sess.bankrollCurrent} onBuyIn={doBuyIn} onClose={()=>setBuyInOpen(false)}/>}
      {cashOutOpen && <CashOutModal maxAmount={sess.bankrollCurrent} currency={currency} currentBankroll={sess.bankrollCurrent} onCashOut={doCashOut} onClose={()=>setCashOutOpen(false)}/>}
      {currencyOpen && <CurrencyModal current={currency} bankroll={sess.bankrollCurrent} onSave={changeCurrency} onClose={()=>setCurrencyOpen(false)}/>}
      {changelogOpen && <ChangelogModal onClose={()=>setChangelogOpen(false)}/>}
      {editBankroll && <BankrollEdit onClose={()=>setEditBankroll(false)}/>}
      {hardResetOpen && <HardResetModal onClose={()=>setHardResetOpen(false)} onExport={exportJSON}/>}
      {venueSheets.sheets}

      {/* Floating feedback button */}
      <button onClick={()=>setFeedbackOpen(true)} style={{position:"fixed",top:12,left:12,width:36,height:36,borderRadius:"50%",border:"none",background:"#1e2d3d",color:"#94a3b8",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",boxShadow:"0 2px 8px rgba(0,0,0,0.4)",zIndex:900}}>🐛</button>

      {/* Feedback modal */}
      {feedbackOpen && (
        <Modal onClose={()=>setFeedbackOpen(false)}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <div style={{fontSize:17,fontWeight:800,color:"#e2e8f0"}}>🐛💡 Feedback</div>
            <button onClick={()=>setFeedbackOpen(false)} style={{background:"transparent",border:"none",color:"#64748b",fontSize:22,cursor:"pointer"}}>×</button>
          </div>
          <div style={{fontSize:12,color:"#94a3b8",marginBottom:12,lineHeight:1.5}}>Found a bug? Have an idea to make the app better? Let us know! You can also use your phone's voice-to-text.</div>
          <textarea value={feedbackText} onChange={e=>setFeedbackText(e.target.value)} placeholder="What's on your mind? Describe what's not working or what you'd like to see..." style={{width:"100%",minHeight:120,padding:12,borderRadius:10,border:"1px solid #2d4057",background:"#0f1923",color:"#e2e8f0",fontSize:14,fontFamily:"inherit",resize:"vertical",boxSizing:"border-box"}}/>
          <button onClick={submitFeedback} disabled={!feedbackText.trim()} style={{width:"100%",marginTop:12,padding:"14px 0",borderRadius:12,border:"none",background:feedbackText.trim()?"#16a34a":"#374151",color:"white",fontSize:15,fontWeight:800,cursor:feedbackText.trim()?"pointer":"not-allowed"}}>
            Send Feedback
          </button>
        </Modal>
      )}
      </div>
    </div>
  );
}

// -- Statistical Context Bar --
