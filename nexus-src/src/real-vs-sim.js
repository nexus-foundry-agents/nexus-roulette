// -- Real vs simulated (F12): what was logged at each casino, machine or table, and dealer, against the simulated wheel. --
// Pure: no React here. The sheet is components/RealVsSimPage.jsx. Depends on session.js (normalizeVenue, dealerSegments),
// constants.js (getWheelNumbers, dozenOf, columnOf) and percentile.js (streakPercentile, streakLabel), which reads the
// generated table in streak-percentiles.js. Facts only: counts, streak lengths, percentiles and a plain reference.
//
// A venue is a casino, then a machine or table, then a dealer, as F11 stores them. A stretch is a run of consecutive spins
// at one venue key: a whole session for a machine, one dealer's span of a session for a table. Streaks are counted inside a
// stretch, the way streak-percentiles.js counts them inside a session: a completed losing streak is consecutive spins without
// a hit on the bet, ended by a hit. A streak still open at the end of a stretch is not counted. 0 and 00 are a loss for every
// dozen and column. Keys are lower-case text, so the same venue typed two ways is one venue.

const RVS_MIN_SPINS = 100;
const RVS_NO_CASINO = 'No casino name';
const RVS_NO_DEALER = 'No dealer recorded';
const RVS_CATEGORIES = ['dozen:0', 'dozen:1', 'dozen:2', 'column:0', 'column:1', 'column:2'];
// A selection is All at every level (null). A key is the lower-case text of a value; the dealer key is '' for a table
// with no dealer recorded, which is a choice of its own, distinct from All.
const RVS_ALL = { casino: null, place: null, dealer: null };

// The wheel a session was played on: European when saved as European, American otherwise.
function rvsWheel(sess) { return sess.roulette === 'european' ? 'european' : 'american'; }

// The machine or table of a venue: its kind, and the label the venue shows for it.
function rvsPlace(v) {
  if (v.kind === 'machine') {
    return { kind: 'machine', label: [v.maker, v.model, v.version].filter(Boolean).join(' ') || 'No machine details' };
  }
  if (v.kind === 'table') return { kind: 'table', label: v.table || 'No table label' };
  return { kind: '', label: 'No machine or table recorded' };
}

// Whether a spin hits a dozen or column category ('dozen:0' to 'dozen:2', 'column:0' to 'column:2'). 0 and 00 hit none.
function rvsHit(v, category) {
  const want = Number(category.split(':')[1]);
  return (category.indexOf('dozen:') === 0 ? dozenOf(v) : columnOf(v)) === want;
}

// The longest completed losing streak in one stretch for one category: the longest run of spins without a hit that a hit
// ends. A run still open at the end of the stretch is not counted.
function rvsLongestLoss(spins, category) {
  let run = 0;
  let best = 0;
  spins.forEach(v => {
    if (rvsHit(v, category)) { if (run > best) best = run; run = 0; }
    else run += 1;
  });
  return best;
}

// The runs of spins at one venue, from the saved sessions it is given (the caller adds the current one). A session with no
// venue is left out, and so is any spin that is not a number on its wheel. A table is split at its dealer changes, so each
// stretch has one dealer. Stretches keep the order of the sessions.
function venueStretches(sessions) {
  const out = [];
  (sessions || []).forEach(sess => {
    if (!sess || typeof sess !== 'object' || !Array.isArray(sess.spins)) return;
    const v = normalizeVenue(sess.venue);
    if (!v) return;
    const wheel = rvsWheel(sess);
    const legal = getWheelNumbers(wheel);
    const spins = sess.spins.map(x => String(x));
    const place = rvsPlace(v);
    const casino = v.casino || null;
    const isTable = v.kind === 'table';
    const spans = isTable ? dealerSegments(sess, spins.length) : [{ from: 0, to: spins.length, dealer: null }];
    spans.forEach(span => {
      const kept = spins.slice(span.from, span.to).filter(x => legal.indexOf(x) >= 0);
      if (!kept.length) return;
      out.push({
        casinoKey: casino ? casino.toLowerCase() : '',
        casino: casino || RVS_NO_CASINO,
        placeKey: place.kind + ':' + place.label.toLowerCase(),
        place: place.label,
        dealerKey: isTable ? (span.dealer ? span.dealer.toLowerCase() : '') : null,
        dealer: isTable ? (span.dealer || RVS_NO_DEALER) : null,
        wheel,
        spins: kept,
      });
    });
  });
  return out;
}

// The venue key of a stretch: casino, machine or table, and dealer (null for a machine).
function venueKeyOf(st) { return JSON.stringify([st.casinoKey, st.placeKey, st.dealerKey]); }

// The stretches grouped by venue key, largest first, ties by label. Each group carries its labels, its spin count and its
// stretch count.
function venueGroups(stretches) {
  const map = {};
  (stretches || []).forEach(st => {
    const key = venueKeyOf(st);
    if (!map[key]) map[key] = { key, casino: st.casino, place: st.place, dealer: st.dealer, spins: 0, stretches: 0 };
    map[key].spins += st.spins.length;
    map[key].stretches += 1;
  });
  return Object.keys(map).map(k => map[k]).sort((a, b) =>
    b.spins - a.spins || a.casino.localeCompare(b.casino) || a.place.localeCompare(b.place) || String(a.dealer).localeCompare(String(b.dealer)));
}

// The counts, reference and streak facts for a set of stretches: one venue key, or every venue a selection holds.
//   spins: the spins counted.
//   numbers: the 38 American slots in wheel order, always all of them, so the grid keeps its size. count is the hits. reference
//     is the simulated reference: each spin adds 1 divided by the pockets of its wheel to each number on that wheel. onWheel is
//     false for 00 when no American spin is in the set; the grid hides that cell and keeps its place.
//   dozens, columns: hits, reference (each spin adds 12 divided by the pockets of its wheel, since a dozen and a column each hold
//     12 numbers), the longest completed losing streak and the wheel it was on, and its percentile among the completed streaks of
//     that bet on that wheel (null with no completed streak). table defaults to the generated table.
function venueStats(stretches, table) {
  const list = stretches || [];
  const numbers = getWheelNumbers('american');
  const count = {};
  const ref = {};
  numbers.forEach(n => { count[n] = 0; ref[n] = 0; });
  const betHits = {};
  const betRef = {};
  const longest = {};
  RVS_CATEGORIES.forEach(c => { betHits[c] = 0; betRef[c] = 0; longest[c] = { length: 0, wheel: null }; });
  let spins = 0;
  let american = false;
  list.forEach(st => {
    const wheelNums = getWheelNumbers(st.wheel);
    const pockets = wheelNums.length;
    const n = st.spins.length;
    spins += n;
    if (st.wheel === 'american') american = true;
    st.spins.forEach(v => { count[v] = (count[v] || 0) + 1; });
    wheelNums.forEach(x => { ref[x] += n / pockets; });
    RVS_CATEGORIES.forEach(c => {
      betRef[c] += n * 12 / pockets;
      betHits[c] += st.spins.filter(v => rvsHit(v, c)).length;
      const run = rvsLongestLoss(st.spins, c);
      if (run > longest[c].length) longest[c] = { length: run, wheel: st.wheel };
    });
  });
  const bet = c => ({
    category: c,
    label: streakLabel(c),
    hits: betHits[c],
    reference: betRef[c],
    longest: longest[c].length,
    percentile: longest[c].length > 0 ? streakPercentile(c, longest[c].wheel, longest[c].length, table) : null,
  });
  return {
    spins,
    numbers: numbers.map(n => ({ number: n, count: count[n], reference: ref[n], onWheel: n !== '00' || american })),
    dozens: [0, 1, 2].map(i => bet('dozen:' + i)),
    columns: [0, 1, 2].map(i => bet('column:' + i)),
  };
}

// The statistics of each venue key on its own, in venueGroups order.
function venueStatsByKey(stretches, table) {
  return venueGroups(stretches).map(g => ({
    ...g,
    ...venueStats((stretches || []).filter(st => venueKeyOf(st) === g.key), table),
  }));
}

// Whether a stretch is inside a selection. A null level is All.
function matchesVenue(st, sel) {
  const s = sel || RVS_ALL;
  return (s.casino === null || st.casinoKey === s.casino)
    && (s.place === null || st.placeKey === s.place)
    && (s.dealer === null || st.dealerKey === s.dealer);
}

// The choice lists a selection offers: each casino the stretches hold; the machines and tables under the chosen casino; the
// dealers under the chosen casino and machine or table. Only values that exist are listed, each once, by label. A machine has
// no dealer, so a machine selection offers none.
function venueChoices(stretches, sel) {
  const s = sel || RVS_ALL;
  const list = stretches || [];
  const unique = items => {
    const seen = {};
    const out = [];
    items.forEach(it => {
      if (!seen[it.key]) { seen[it.key] = true; out.push(it); }
    });
    return out.sort((a, b) => a.label.localeCompare(b.label));
  };
  const underCasino = list.filter(st => s.casino === null || st.casinoKey === s.casino);
  const underPlace = underCasino.filter(st => s.place === null || st.placeKey === s.place);
  return {
    casino: unique(list.map(st => ({ key: st.casinoKey, label: st.casino }))),
    place: unique(underCasino.map(st => ({ key: st.placeKey, label: st.place }))),
    dealer: unique(underPlace.filter(st => st.dealerKey !== null).map(st => ({ key: st.dealerKey, label: st.dealer }))),
  };
}

// The selection after one chip is tapped. A casino resets the machine or table and the dealer; a machine or table resets
// the dealer. Tapping the choice already applied changes nothing.
function venuePick(sel, level, key) {
  const s = sel || RVS_ALL;
  if (s[level] === key) return s;
  if (level === 'casino') return { casino: key, place: null, dealer: null };
  if (level === 'place') return { casino: s.casino, place: key, dealer: null };
  return { casino: s.casino, place: s.place, dealer: key };
}

// The line under the spin count: how few spins are logged, or nothing once there are enough. Its place is kept either way.
function venueNote(spins) {
  if (!(spins < RVS_MIN_SPINS)) return '';
  return 'Only ' + spins + (spins === 1 ? ' spin' : ' spins') + ' logged here.';
}

// The saved sessions with the current one. The live session replaces its saved copy, as the sessions sheet does, and a
// current session that was never saved is added, so no spin is counted twice or left out.
function realVsSimSessions(saved, current) {
  const list = (saved || []).map(s => (current && s && s.id === current.id ? current : s));
  if (current && !list.some(s => s && s.id === current.id)) list.push(current);
  return list;
}
