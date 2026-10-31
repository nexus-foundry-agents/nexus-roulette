import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';

// F13 follow-on: resume, rename and catch-up through the real App. The App bundle is loaded the way build.js
// concatenates it, and the real App runs under the hook runner that board-add-repeats.test.mjs uses. That harness is
// copied here rather than imported, because importing a test file would run its tests a second time. Browser storage
// is the sandbox's localStorage, so a reload is a new mount on the same storage. Standalone only: the App is its own
// parent, so the Casino bridge is not involved. The sync merge is the real casino-sync.mjs, read only.

const SRC = new URL('../nexus-src/src/', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));
const flushPromises = () => new Promise((resolve) => setImmediate(resolve));
const compiled = new Map();

const T = (y, m, d, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();
const STARTED = T(2026, 9, 30, 18, 0); // Friday 30 October 18:00 local: when the walk-away session started
const SAVED_AT = T(2026, 9, 30, 21, 0); // the stamp on the saved copy
const TODAY = T(2026, 9, 31, 9, 0); // Saturday 31 October: the day the player comes back
const AMERICAN = ['0', '00', ...Array.from({ length: 36 }, (_, i) => String(i + 1))];
const SETTINGS = {
  currency: 'USD', defaultBuyIn: 100, onboarded: true, vibration: false, showDroughtCounts: true,
  headStartUnseen: false, counterShows: 'spins', percentileOutlines: true,
  tableMinBet: 10, tableMaxBet: 500, tableMaxTotal: 10000,
};

// The drought counts a spin list leaves: each number counts the spins since it last came up (all of them if never).
function droughtsAfter(spins) {
  const out = {};
  AMERICAN.forEach((n) => {
    const at = spins.lastIndexOf(n);
    out[n] = at < 0 ? spins.length : spins.length - 1 - at;
  });
  return out;
}

// A progression track on the first dozen (1 to 12, dozen index 0). Level 0 bets 1 chip; the table is 1, 1, 2, 3, 5 chips.
function track(over = {}) {
  return {
    id: 'trk-a', type: 'fibonacci', color: '#60a5fa', state: 'active',
    config: {
      type: 'fibonacci', unit: 1, roi: 15, betMode: 'progression', dozenTargets: [0], colTargets: [], evenTargets: [],
      stopLoss: 200, parkRules: { droughtThreshold: null, waitForWin: false, parkAfterStopLoss: false, parkAfterLoss: false },
    },
    level: 0, pnl: 0, bets: [], createdAtSpin: 0, closedAtSpin: null, wins: 0, sequences: 0,
    ...over,
  };
}

function session(over = {}) {
  return {
    id: 's', name: 'Session 10/30/2026', created: STARTED, modified: STARTED, roulette: 'american', bankroll: 500,
    bankrollCurrent: 500, totalBuyIn: 0, buyIns: [], spins: [], droughts: droughtsAfter([]), tracks: [],
    totalCashOut: 0, cashOuts: [], sessionStartedAt: STARTED, sessionEndedAt: null, mode: 'live',
    ...over,
  };
}

// A saved Live session with a track mid-progression, a table venue with a dealer change, and bankroll that matches its pnl.
function savedA(over = {}) {
  return session({
    id: 'saved-a', spins: ['1', '24', '5', '16'], droughts: droughtsAfter(['1', '24', '5', '16']), bankrollCurrent: 502,
    tracks: [track({ level: 1, pnl: 2, wins: 2, sequences: 2, bets: [
      { spinIdx: 0, level: 0, outcome: 'win', profit: 2, cat: 'win' },
      { spinIdx: 1, level: 0, outcome: 'loss', profit: -1, cat: 'loss' },
      { spinIdx: 2, level: 0, outcome: 'win', profit: 1, cat: 'win' },
      { spinIdx: 3, level: 0, outcome: 'loss', profit: -1, cat: 'loss' },
    ] })],
    venue: { casino: 'Harbor Casino', kind: 'table', table: 'Table 4', dealer: 'Ana' },
    dealerChanges: [{ fromSpin: 0, dealer: 'Ben' }, { fromSpin: 2, dealer: 'Ana' }],
    ...over,
  });
}

// The session the player was on before walking away: one spin, a track that won it, and a parked track on the second dozen.
function savedNine(over = {}) {
  return session({
    id: 'live-1', name: 'Session 10/30/2026', created: STARTED, modified: SAVED_AT, spins: ['9'],
    droughts: droughtsAfter(['9']), bankrollCurrent: 502,
    tracks: [
      track({ level: 0, pnl: 2, wins: 1, sequences: 1, bets: [{ spinIdx: 0, level: 0, outcome: 'win', profit: 2, cat: 'win' }] }),
      track({ id: 'trk-b', state: 'parked', color: '#f472b6', config: { ...track().config, dozenTargets: [1] } }),
    ],
    ...over,
  });
}

const liveEmpty = () => session({ id: 'live-0', name: 'Session 10/31/2026', created: TODAY, modified: TODAY, sessionStartedAt: null });
const gameIdle = () => session({ id: 'game-idle', name: 'Game 10/31/2026', created: TODAY, modified: TODAY, mode: 'game', sessionStartedAt: null });
const seedOf = (over) => ({ savedSessions: [], currentSession: liveEmpty(), gameSession: gameIdle(), settings: SETTINGS, ...over });

// The compiled bundle, keyed by its source, so each mount reruns the App without recompiling it.
async function bundle(react, store) {
  const build = await readFile(new URL('../nexus-src/build.js', import.meta.url), 'utf8');
  const files = [...build.match(/const FILES = \[([\s\S]*?)\];/)[1].matchAll(/^\s*'([^']+)'/gm)].map((m) => m[1]);
  const sources = await Promise.all(files.map((f) => readFile(new URL(f, SRC), 'utf8')));
  const combined = files.map((f, i) => `\n// ===== ${f} =====\n${sources[i]}`).join('\n').replace(/\r\n?/g, '\n');
  if (!compiled.has(combined)) {
    compiled.set(combined, transformSync(combined, {
      babelrc: false,
      configFile: false,
      filename: 'app.jsx',
      presets: [
        [presetReact, { runtime: 'classic' }],
        [presetEnv, { targets: { ie: 11 }, modules: 'commonjs', useBuiltIns: false }],
      ],
    }).code);
  }
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    React: react,
    setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval() {},
    addEventListener() {}, removeEventListener() {},
    localStorage: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; },
    },
    require: (name) => {
      if (name === 'react') return react;
      throw new Error(`unexpected module in the bundle: ${name}`);
    },
  };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  sandbox.window = sandbox;
  sandbox.window.parent = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(compiled.get(combined), sandbox, { filename: 'session-flows-bundle.js' });
  // expr() evaluates in the bundle's own realm; json() returns plain data from it.
  sandbox.expr = (source, vars) => { sandbox.vars = vars || {}; return vm.runInContext(source, sandbox); };
  sandbox.json = (source, vars) => JSON.parse(sandbox.expr(`JSON.stringify(${source})`, vars));
  return sandbox;
}

// A small hook runner for the real App: state, refs, memo and effects, rendered and flushed by hand.
async function mountApp({ seed, store = {} } = {}) {
  const hooks = [];
  const effects = [];
  const recordings = [];
  let cursor = 0;
  let dirty = true;
  let tree;
  const changed = (before, after) => !before || !after || after.some((value, i) => !Object.is(value, before[i]));
  const react = { ...React,
    useState(initial) {
      const i = cursor++;
      if (!hooks[i]) hooks[i] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = hooks[i];
      if (!slot.set) slot.set = (value) => {
        const next = typeof value === 'function' ? value(slot.value) : value;
        if (!Object.is(next, slot.value)) { slot.value = next; dirty = true; }
      };
      return [slot.value, slot.set];
    },
    useRef(initial) { const i = cursor++; return hooks[i] || (hooks[i] = { current: initial }); },
    useMemo(run, deps) {
      const i = cursor++;
      if (!hooks[i] || changed(hooks[i].deps, deps)) hooks[i] = { value: run(), deps };
      return hooks[i].value;
    },
    useCallback(run, deps) { return react.useMemo(() => run, deps); },
    useEffect(run, deps) {
      const i = cursor++;
      if (!hooks[i] || changed(hooks[i].deps, deps)) {
        const previous = hooks[i];
        hooks[i] = { deps, cleanup: previous && previous.cleanup };
        effects.push(() => { if (hooks[i].cleanup) hooks[i].cleanup(); hooks[i].cleanup = run(); });
      }
    },
  };
  const ctx = await bundle(react, store);
  if (seed) store[ctx.expr('STORAGE_KEY')] = JSON.stringify(seed);
  // Standalone storage, a recording that keeps each spin (the framed recording needs a Casino shell), and no timers,
  // network or document events. Storage and the App's own save path are the real ones.
  ctx.useCasinoRecording = (mode) => ({ record: (spin) => { recordings.push({ mode, ...plain(spin) }); } });
  ctx.navigator = {};
  ctx.document = { addEventListener() {}, removeEventListener() {} };
  ctx.location = { hash: '', pathname: '/roulette/', search: '' };
  ctx.history = { state: null, replaceState() {} };
  ctx.URLSearchParams = URLSearchParams;
  ctx.CustomEvent = class { constructor(type) { this.type = type; } };
  ctx.dispatchEvent = () => {};
  ctx.fetch = async () => ({ json: async () => ({}) });
  ctx.setTimeout = () => 1;
  ctx.clearTimeout = () => {};
  function render() {
    cursor = 0; dirty = false;
    tree = ctx.module.exports.default();
  }
  async function flush() {
    for (let i = 0; i < 100; i++) {
      if (dirty) render();
      for (const effect of effects.splice(0)) effect();
      await flushPromises();
      if (!dirty && effects.length === 0) return;
    }
    assert.fail('the App did not settle');
  }
  function find(type, node) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) { for (const child of node) { const found = find(type, child); if (found) return found; } return null; }
    if (node.type === type || (typeof type === 'string' && typeof node.type === 'function' && node.type.name === type)) return node;
    return find(type, node.props && node.props.children);
  }
  function buttons(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach((child) => buttons(child, out)); return out; }
    if (node.type === 'button') out.push(node);
    return buttons(node.props && node.props.children, out);
  }
  return {
    ctx, store, recordings, flush,
    state: () => hooks[0].value.appState,
    decision: () => hooks[0].value.decision,
    // Presses a button of the rendered tree (a mode toggle or a tab) and settles the App.
    async press(label, exact = false) {
      const hit = buttons(tree).find((b) => (exact ? b.props.children === label : String(b.props.children).includes(label)));
      assert.ok(hit, `a button reads "${label}"`);
      hit.props.onClick();
      await flush();
    },
    // The props the Stats page gives the sessions sheet: resumeSaved, renameSaved and addCatchUp, as the App wires them.
    stats() {
      const page = find('StatsPage', tree);
      assert.ok(page, 'the Stats tab is open');
      return page.props;
    },
  };
}

// Opens the Live page on the Stats tab, where the sessions sheet is reached.
async function openStats(app) {
  await app.press('Live');
  await app.press('Stats', true);
}

// -- Resume --

test('resume: the unsaved current session is saved first, then the saved session becomes current exactly as it was saved', async () => {
  const app = await mountApp({ seed: seedOf({
    savedSessions: [savedA()],
    currentSession: session({ id: 'current-c', name: 'Session 10/31/2026', created: TODAY, modified: TODAY + 600000,
      sessionStartedAt: TODAY, spins: ['5', '6'], droughts: droughtsAfter(['5', '6']) }),
  }) });
  await app.flush();
  await openStats(app);
  const before = plain(app.state());
  const saved = before.savedSessions.find((x) => x.id === 'saved-a');
  assert.equal(app.ctx.expr('resumeStep(vars.cur, vars.list, "saved-a")', { cur: before.currentSession, list: before.savedSessions }),
    'confirm', 'the sheet asks first, because the current session has unsaved spins');

  app.stats().resumeSaved('saved-a');
  await app.flush();

  const state = plain(app.state());
  assert.deepEqual(state.currentSession, saved, 'the resumed session is the saved copy, as it was saved');
  assert.equal(state.currentSession.id, 'saved-a');
  assert.equal(state.currentSession.tracks[0].level, 1, 'the track level as saved');
  assert.equal(state.currentSession.tracks[0].bets.length, 4, 'the track bets as saved');
  assert.deepEqual(state.currentSession.droughts, droughtsAfter(['1', '24', '5', '16']), 'the droughts as saved');
  assert.deepEqual(state.currentSession.venue, { casino: 'Harbor Casino', kind: 'table', table: 'Table 4', dealer: 'Ana' }, 'the venue as saved');
  const kept = state.savedSessions.find((x) => x.id === 'current-c');
  assert.ok(kept, 'the unsaved current session is saved first');
  assert.deepEqual(kept.spins, ['5', '6'], 'its spins are kept');
  assert.equal(kept.mode, 'live', 'it is saved as a Live session');
  assert.deepEqual(state.savedSessions.find((x) => x.id === 'saved-a'), saved, 'the saved copy itself is unchanged');
});

test('resume: a save and a reload keep the resumed session and the copy of the session that was current', async () => {
  const app = await mountApp({ seed: seedOf({
    savedSessions: [savedA()],
    currentSession: session({ id: 'current-c', name: 'Session 10/31/2026', created: TODAY, modified: TODAY + 600000,
      sessionStartedAt: TODAY, spins: ['5', '6'], droughts: droughtsAfter(['5', '6']) }),
  }) });
  await app.flush();
  await openStats(app);
  app.stats().resumeSaved('saved-a');
  await app.flush();
  const afterResume = plain(app.state());

  // A page reload: a new App mounted on the same browser storage, which the App wrote on each change.
  const reloaded = await mountApp({ store: app.store });
  await reloaded.flush();
  const state = plain(reloaded.state());
  assert.equal(state.currentSession.id, 'saved-a', 'the resumed session is still current after a reload');
  assert.deepEqual(state.currentSession, afterResume.currentSession, 'the resumed session is the same after a reload');
  assert.deepEqual(state.savedSessions, afterResume.savedSessions, 'the saved list is the same after a reload');
  assert.deepEqual(state.savedSessions.find((x) => x.id === 'current-c').spins, ['5', '6'], 'the spins saved first are still there');
});

// Finding SESSIONS-APP-FLOW-F1. session.js:462-465 saves only the session of the active mode, so resuming a Game session
// from Live replaces the Game session in progress (App.jsx:438-442) without saving its unsaved spins. The sheet checks only
// the Live session, so it does not warn either. Expected: the Game session is saved first, as the Live one is.
test('resume from Live: an unsaved Game session in progress is saved, not replaced', {
  todo: 'SESSIONS-APP-FLOW-F1: resuming a Game session from Live replaces the Game session in progress without saving its unsaved spins (App.jsx:438-442, session.js:466-486)',
}, async () => {
  const app = await mountApp({ seed: seedOf({
    savedSessions: [savedA(), session({ id: 'game-saved', name: 'Game 10/30/2026', created: STARTED, modified: SAVED_AT,
      mode: 'game', spins: ['1'], droughts: droughtsAfter(['1']) })],
    gameSession: session({ id: 'game-1', name: 'Game 10/31/2026', created: TODAY, modified: TODAY + 600000,
      mode: 'game', sessionStartedAt: TODAY, spins: ['7', '8'], droughts: droughtsAfter(['7', '8']) }),
  }) });
  await app.flush();
  await openStats(app);
  app.stats().resumeSaved('game-saved');
  await app.flush();
  const state = plain(app.state());
  assert.equal(state.gameSession.id, 'game-saved', 'the saved Game session becomes the Game session');
  assert.ok(state.savedSessions.find((x) => x.id === 'game-1'), 'the Game session in progress is saved first');
  assert.deepEqual(state.savedSessions.find((x) => x.id === 'game-1').spins, ['7', '8'], 'its unsaved spins are kept');
});

// -- Rename --

test('rename: the label persists through a save and a reload, trimmed and stamped as modified', async () => {
  const app = await mountApp({ seed: seedOf({ savedSessions: [savedA()] }) });
  await app.flush();
  await openStats(app);
  const before = Date.now();
  app.stats().renameSaved('saved-a', '  Tuesday table  ');
  await app.flush();
  const row = plain(app.state().savedSessions.find((x) => x.id === 'saved-a'));
  assert.equal(row.label, 'Tuesday table', 'the label is trimmed, as typed');
  assert.ok(row.modified >= before, 'the rename stamps the session modified, so a sync merge keeps this copy');

  const reloaded = await mountApp({ store: app.store });
  await reloaded.flush();
  assert.equal(plain(reloaded.state().savedSessions.find((x) => x.id === 'saved-a')).label, 'Tuesday table', 'the label after a reload');
  assert.deepEqual(plain(reloaded.state().savedSessions.find((x) => x.id === 'saved-a')).spins, savedA().spins, 'the rename changes nothing else');
});

test('rename: the label survives the account-sync merge by its modified stamp, whichever snapshot is on the left', async () => {
  const app = await mountApp({ seed: seedOf({ savedSessions: [savedA()] }) });
  await app.flush();
  await openStats(app);
  app.stats().renameSaved('saved-a', 'Tuesday table');
  await app.flush();
  // This device after a save and a reload, and its envelope from the sync meta the App wrote.
  const reloaded = await mountApp({ store: app.store });
  await reloaded.flush();
  const local = plain(reloaded.state());
  const renamed = local.savedSessions.find((x) => x.id === 'saved-a');
  const meta = reloaded.ctx.expr('syncMetaFromStored(vars.stored, vars.app)',
    { stored: reloaded.store[reloaded.ctx.expr('ROULETTE_SYNC_META_KEY')], app: local });
  const localSnapshot = plain(reloaded.ctx.expr('rouletteSnapshot(vars.app, vars.meta)', { app: local, meta }));
  const remoteEnvelope = { modifiedAt: plain(meta).modifiedAt + 100, resetAt: 0 };
  const remoteState = (copy) => ({ savedSessions: [copy], currentSession: liveEmpty(), gameSession: gameIdle(), settings: SETTINGS });
  const remoteSnapshot = (copy) => plain(reloaded.ctx.expr('rouletteSnapshot(vars.app, vars.meta)', { app: remoteState(copy), meta: remoteEnvelope }));
  const mergeBoth = (remote) => [
    plain(reloaded.ctx.expr('mergeRouletteSnapshots(vars.a, vars.b)', { a: localSnapshot, b: remote })),
    plain(reloaded.ctx.expr('mergeRouletteSnapshots(vars.a, vars.b)', { a: remote, b: localSnapshot })),
  ];
  const labelOf = (merged) => merged.appState.savedSessions.find((x) => x.id === 'saved-a');

  // Arm 1: another device saved this session after the original save and before this rename, under the old name.
  for (const merged of mergeBoth(remoteSnapshot(savedA({ label: 'Old name', modified: SAVED_AT + 60000 })))) {
    assert.equal(labelOf(merged).label, 'Tuesday table', 'the renamed copy is newer by its stamp, so it wins');
    assert.equal(labelOf(merged).modified, renamed.modified, 'the winning copy carries the rename stamp');
  }

  // Arm 2, the control: the other device saved a copy after this rename. Only the stamp differs from arm 1.
  for (const merged of mergeBoth(remoteSnapshot(savedA({ label: 'Renamed elsewhere', modified: renamed.modified + 1000 })))) {
    assert.equal(labelOf(merged).label, 'Renamed elsewhere', 'a later stamp on the other device wins');
  }
});

// Finding SESSIONS-APP-FLOW-F2. The rename changes the saved row and the live slot of the same session (session.js:490-504).
// casino-sync.mjs:104-120 merges saved rows by stamp but takes currentSession and gameSession from the newer envelope. So a
// device whose envelope is newer, having changed only its settings, brings back its unrenamed copy of the session as the
// current one. The sheet shows the live copy in the current row (SessionsPage.jsx list), so the rename disappears there.
test('rename: a renamed current session keeps its label when a device with a newer envelope and an older copy is merged', {
  todo: 'SESSIONS-APP-FLOW-F2: a rename of the current session is lost on the current row when a device with a newer envelope (casino-sync.mjs:119-120) merges back its older live copy',
}, async () => {
  const app = await mountApp({ seed: seedOf({ savedSessions: [savedA()], currentSession: savedA() }) });
  await app.flush();
  await openStats(app);
  app.stats().renameSaved('saved-a', 'Tuesday table');
  await app.flush();
  const reloaded = await mountApp({ store: app.store });
  await reloaded.flush();
  const local = plain(reloaded.state());
  const meta = plain(reloaded.ctx.expr('syncMetaFromStored(vars.stored, vars.app)',
    { stored: reloaded.store[reloaded.ctx.expr('ROULETTE_SYNC_META_KEY')], app: local }));
  // The other device changed only its settings after the rename. Its copy of the session predates the rename.
  const other = { savedSessions: [savedA()], currentSession: savedA(), gameSession: gameIdle(), settings: { ...SETTINGS, currency: 'EUR' } };
  const remote = plain(reloaded.ctx.expr('rouletteSnapshot(vars.app, vars.meta)', { app: other, meta: { modifiedAt: meta.modifiedAt + 100, resetAt: 0 } }));
  const localSnapshot = plain(reloaded.ctx.expr('rouletteSnapshot(vars.app, vars.meta)', { app: local, meta }));
  const merged = plain(reloaded.ctx.expr('mergeRouletteSnapshots(vars.a, vars.b)', { a: localSnapshot, b: remote }));
  assert.equal(merged.appState.savedSessions.find((x) => x.id === 'saved-a').label, 'Tuesday table', 'the saved row keeps the rename');
  assert.equal(merged.appState.currentSession.label, 'Tuesday table', 'the current row keeps the rename too');
});

// -- Catch-up --

test('catch-up: resumed, then "2 2 2 24 4" enters five spins in that order, each settled by the active track through commitBoardAdd', async () => {
  const app = await mountApp({ seed: seedOf({ savedSessions: [savedNine()] }) });
  await app.flush();
  await openStats(app);
  app.stats().resumeSaved('live-1');
  await app.flush();
  assert.equal(plain(app.state()).currentSession.id, 'live-1', 'the walk-away session is current');

  // The text the player types, through the same parser the catch-up card calls on every keystroke.
  const typed = app.ctx.json('parseBulkNumbers("2 2 2 24 4", "american", BOARD_MAX_NUMBERS)');
  assert.deepEqual(typed, { ok: true, numbers: ['2', '2', '2', '24', '4'] }, 'the typed entry parses to five numbers, oldest first');
  app.stats().addCatchUp(typed.numbers);
  await app.flush();

  // commitBoardAdd is the only producer of a decision, so an accepted decision shows the add went through it.
  assert.ok(app.decision(), 'the add produced a decision through commitBoardAdd');
  const decision = plain(app.decision());
  assert.equal(decision.accepted, true, 'commitBoardAdd accepted the add');
  assert.deepEqual(decision.action.numbers, ['2', '2', '2', '24', '4']);
  assert.equal(decision.spins.length, 5, 'one settled spin per number');

  const state = plain(app.state());
  const sess = state.currentSession;
  assert.deepEqual(sess.spins, ['9', '2', '2', '2', '24', '4'], 'the five numbers follow the session history, in order');
  assert.deepEqual(app.recordings.map((r) => r.segment), ['2', '2', '2', '24', '4'], 'only the five added spins are recorded, in order');

  // The active track: wins at level 0 on 2, 2, 2 (+2 each), a miss on 24 (-1, level to 1), a win on 4 at level 1 (+2).
  const active = sess.tracks[0];
  assert.equal(active.pnl, 9, 'pnl is the saved 2 plus 2 + 2 + 2 - 1 + 2');
  assert.equal(active.level, 0, 'the win on 4 returns the track to level 0');
  assert.equal(active.wins, 5, 'five wins in all, one of them saved');
  assert.equal(active.sequences, 5);
  assert.deepEqual(active.bets.map((b) => b.outcome), ['win', 'win', 'win', 'win', 'loss', 'win'], 'the bets settle in order');
  assert.deepEqual(active.bets.map((b) => b.spinIdx), [0, 1, 2, 3, 4, 5], 'each bet sits on its spin');
  // spin-apply.js resets the level to 0 before it records a progression win, so a win's bet carries level 0. The miss on
  // 24 is the bet placed at level 0 that moved the track to level 1.
  assert.deepEqual(active.bets.filter((b) => b.outcome === 'loss').map((b) => b.level), [0], 'the miss was placed at level 0');

  // The parked track does not settle: on its own dozen it would have won 24.
  const parked = sess.tracks[1];
  assert.deepEqual(parked.bets, [], 'a parked track is not settled');
  assert.equal(parked.pnl, 0);

  assert.equal(sess.bankrollCurrent, 509, 'bankroll is 502 plus the five spins settled (+7)');
  assert.deepEqual(sess.droughts, droughtsAfter(['9', '2', '2', '2', '24', '4']), 'the droughts count the five spins too');
});
