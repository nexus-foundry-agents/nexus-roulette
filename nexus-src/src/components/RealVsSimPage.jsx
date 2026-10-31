// -- Real vs simulated sheet (F12): what was logged at each casino, machine or table, and dealer, against the simulated wheel. --
// Opened from Stats (StatsPage in SecondaryPages.jsx) with one button, in one shared Modal. The logic is in real-vs-sim.js.
// The venue chips are the Sessions sheet's chips (SessionsChip, SessionsPage.jsx). Reserved space (rule 82): the note lines
// keep their height, the 38 number cells are always drawn (00 is hidden, not removed, on a European venue) and the rows keep
// a fixed height, so nothing moves as the venue changes. Facts only.

// The style of a note line: it keeps its height whether or not it has text.
const RVS_TEXT = { color: "#94a3b8", fontSize: 11, lineHeight: "16px", minHeight: 16, overflowWrap: "anywhere" };

// One chip row of the venue picker: All, then each value that exists. The note under the chips keeps its line, and shows
// only when the row has no value to offer.
function RvsChoiceRow({ title, chips, active, none, onPick }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>{title}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, height: 66, overflowY: "auto", alignItems: "center", alignContent: "flex-start", minWidth: 0 }}>
        <SessionsChip active={active === null} onClick={() => onPick(null)}>All</SessionsChip>
        {chips.map(c => (
          <SessionsChip key={"c" + c.key} active={active === c.key} onClick={() => onPick(c.key)}>{c.label}</SessionsChip>
        ))}
      </div>
      <div style={{ fontSize: 11, color: "#475569", minHeight: 14, visibility: chips.length === 0 ? "visible" : "hidden" }}>{none}</div>
    </div>
  );
}

// One number: its hits, then its simulated reference for the same spins. A cell that is not on this venue's wheel keeps its
// place and is hidden.
function RvsNumberCell({ cell }) {
  const isZero = cell.number === "0" || cell.number === "00";
  const red = !isZero && RED.has(+cell.number);
  return (
    <div aria-hidden={!cell.onWheel} style={{ minWidth: 0, minHeight: 58, boxSizing: "border-box", padding: "5px 2px", borderRadius: 8, border: "1px solid #2d4057", background: isZero ? "#166534" : red ? "#7f1d1d" : "#0d1117", color: isZero ? "#bbf7d0" : red ? "#fecaca" : "#f1f5f9", textAlign: "center", visibility: cell.onWheel ? "visible" : "hidden", fontVariantNumeric: "tabular-nums" }}>
      <div style={{ fontSize: 12, fontWeight: 800 }}>{cell.number}</div>
      <div style={{ fontSize: 13, fontWeight: 700 }}>{cell.count}</div>
      <div style={{ fontSize: 9, color: "#94a3b8" }}>{"ref " + cell.reference.toFixed(1)}</div>
    </div>
  );
}

// The dozen or column table: hits, the simulated reference hits, the longest completed losing streak and its percentile. A
// row with no completed streak shows a dash in its percentile, so every row keeps its shape.
function RvsBetTable({ title, rows }) {
  const cols = "minmax(0,1.5fr) repeat(4,minmax(0,1fr))";
  const head = { fontSize: 10, color: "#64748b", textAlign: "right", fontWeight: 700, minWidth: 0, overflowWrap: "anywhere" };
  const cell = { fontSize: 11, color: "#e2e8f0", textAlign: "right", fontVariantNumeric: "tabular-nums", minWidth: 0, minHeight: 30, overflowWrap: "anywhere", padding: "4px 0", borderTop: "1px solid #1f2937" };
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>{title}</div>
      <div style={{ display: "grid", gridTemplateColumns: cols, gap: 4, alignItems: "baseline", minWidth: 0 }}>
        <div style={{ ...head, textAlign: "left" }}>Bet</div>
        <div style={head}>Hits</div>
        <div style={head}>Reference</div>
        <div style={head}>Longest</div>
        <div style={head}>Percentile</div>
        {rows.map(r => (
          <React.Fragment key={r.category}>
            <div style={{ ...cell, textAlign: "left" }}>{r.label}</div>
            <div style={cell}>{r.hits}</div>
            <div style={cell}>{r.reference.toFixed(1)}</div>
            <div style={cell}>{r.longest}</div>
            <div style={cell}>{r.percentile === null ? "—" : percentTag(r.percentile)}</div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

// The sheet. sessions is the saved list (undefined while it loads, null when it cannot be read); current is the live session.
function RealVsSimPage({ sessions, current, onClose }) {
  const [sel, setSel] = useState(RVS_ALL);
  const model = useMemo(() => {
    if (sessions === undefined) return { state: "loading" };
    if (sessions === null) return { state: "error" };
    try {
      return { state: "ready", stretches: venueStretches(realVsSimSessions(sessions, current)) };
    } catch (e) {
      return { state: "error" };
    }
  }, [sessions, current]);
  const stretches = model.state === "ready" ? model.stretches : [];
  const choices = useMemo(() => venueChoices(stretches, sel), [stretches, sel]);
  const stats = useMemo(() => venueStats(stretches.filter(st => matchesVenue(st, sel))), [stretches, sel]);

  function body() {
    if (model.state === "loading") {
      return <div style={{ textAlign: "center", padding: "20px 0", color: "#475569", fontSize: 12 }}>Loading the logged sessions…</div>;
    }
    if (model.state === "error") {
      return <div role="alert" style={{ textAlign: "center", padding: "20px 0", color: "#f87171", fontSize: 12 }}>Could not read the logged sessions.</div>;
    }
    if (stretches.length === 0) {
      return <div style={{ textAlign: "center", padding: "20px 0", color: "#475569", fontSize: 12 }}>No sessions logged at a venue yet.</div>;
    }
    const labelOf = (list, key) => {
      const hit = list.filter(c => c.key === key)[0];
      return hit ? hit.label : null;
    };
    const venueText = [
      labelOf(choices.casino, sel.casino) || "All casinos",
      labelOf(choices.place, sel.place) || "All machines and tables",
      sel.dealer !== null ? labelOf(choices.dealer, sel.dealer) : null,
    ].filter(Boolean).join(" · ");
    const machineChosen = sel.place !== null && sel.place.indexOf("machine:") === 0;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        <RvsChoiceRow title="Casino" chips={choices.casino} active={sel.casino} none="No casino recorded"
          onPick={k => setSel(s => venuePick(s, "casino", k))}/>
        <RvsChoiceRow title="Machine or table" chips={choices.place} active={sel.place} none="No machine or table recorded"
          onPick={k => setSel(s => venuePick(s, "place", k))}/>
        <RvsChoiceRow title="Dealer" chips={choices.dealer} active={sel.dealer} none={machineChosen ? "Machines have no dealer." : "No dealer recorded."}
          onPick={k => setSel(s => venuePick(s, "dealer", k))}/>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#e2e8f0", lineHeight: "20px", height: 40, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflowWrap: "anywhere" }}>{venueText}</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            <span style={{ fontSize: 11, color: "#64748b", textTransform: "uppercase", letterSpacing: 1 }}>Spins observed</span>
            <strong style={{ fontSize: 20, color: "#e2e8f0", fontVariantNumeric: "tabular-nums" }}>{stats.spins}</strong>
          </div>
          <div aria-live="polite" style={RVS_TEXT}>{venueNote(stats.spins)}</div>
        </div>
        <div style={{ minWidth: 0 }}>
          <FieldLabel>Numbers: hits and simulated reference</FieldLabel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(64px,1fr))", gap: 4, minWidth: 0 }}>
            {stats.numbers.map(cell => <RvsNumberCell key={cell.number} cell={cell}/>)}
          </div>
          <div style={{ ...RVS_TEXT, marginTop: 6 }}>ref is the simulated reference: the spins divided by the pockets on the wheel.</div>
        </div>
        <RvsBetTable title="Dozens" rows={stats.dozens}/>
        <RvsBetTable title="Columns" rows={stats.columns}/>
        <div style={RVS_TEXT}>
          Longest is the longest completed losing streak: consecutive spins without a hit, ended by a hit. Percentile is the share of
          the simulated completed streaks of that bet on that wheel that are that length or shorter, rounded down.
        </div>
        <div style={{ ...RVS_TEXT, color: "#475569", fontSize: 9 }}>
          {STREAK_PERCENTILE_DATA.meta.sessions.toLocaleString("en-US") + " simulated sessions x " + STREAK_PERCENTILE_DATA.meta.spinsPerSession.toLocaleString("en-US") + " spins per wheel, from streak-percentiles.js"}
        </div>
      </div>
    );
  }

  return (
    <Modal onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <div style={{ flex: "1 1 0", minWidth: 0, fontSize: 15, fontWeight: 800, color: "#e2e8f0" }}>Real vs simulated</div>
          <button type="button" onClick={onClose} style={{ flex: "0 0 auto", padding: "6px 12px", borderRadius: 8, border: "1px solid #2d4057", background: "#1e2d3d", color: "#94a3b8", fontSize: 12, cursor: "pointer" }}>Close</button>
        </div>
        {body()}
      </div>
    </Modal>
  );
}
