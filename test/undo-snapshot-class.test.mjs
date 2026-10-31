import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';

// UNDO-SNAPSHOT-CLASS: every action that replaces the session clears Undo, in one place. The Undo snapshot records the session
// id and the mode it was taken from, and Undo is offered only while both still match. So resuming a saved session, a JSON
// import, a Game/Live mode switch, and any replace nobody has listed (a sync that brings in another copy of the session) cannot
// restore the session they replaced. A same-id change the tap does not explain (a new wheel from Restart Onboarding, a venue,
// a label, a spin list that is not the snapshot plus the tapped spin) is refused by undoBlockReason (spin-apply.js).
// The real App runs under the hook runner that undo-other-gaps.test.mjs uses. The runner is copied here rather than imported,
// because importing a test file would run its tests a second time (the convention of the other App tests).

const SRC = new URL('../nexus-src/src/', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));
const flushPromises = () => new Promise((resolve) => setImmediate(resolve));
const compiled = new Map();
const AMERICAN = ['0', '00', ...Array.from({ length: 36 }, (_, i) => String(i + 1))];
const PARK_RULES = { droughtThreshold: null, waitForWin: false, parkAfterStopLoss: false, parkAfterLoss: false };
// A number outside the first dozen: the Progression Bet on the first dozen misses it, so its money moves by one chip.
const MISS = '30';

const CHANGED_REASON = 'Undo is off: the session was changed after the spin it would reverse. Undo would drop that change.';
const SPIN_REASON = 'Undo is off after a ghost spin or an untracked spin. Fix the number instead.';

// Each number counts the spins since it last came up (every spin when it never has), as applySpin keeps them.
function droughtsAfter(spins) {
  const out = {};
  AMERICAN.forEach((n) => {
    const at = spins.lastIndexOf(n);
    out[n] = at < 0 ? spins.length : spins.length - 1 - at;
  });
  return out;
}

// A Progression Bet on the first dozen, at level 0, with no record: the spins a test settles are its whole record.
function freshProgression(over = {}) {
  return {
    id: 'prog-1', type: 'fibonacci', color: '#60a5fa', state: 'active', level: 0, pnl: 0, wins: 0, sequences: 0,
    createdAtSpin: 0, closedAtSpin: null, bets: [],
    config: { type: 'fibonacci', unit: 1, roi: 15, betMode: 'progression', dozenTargets: [0], colTargets: [], evenTargets: [], stopLoss: 200, parkRules: PARK_RULES },
    ...over,
  };
}

// A Live session on the American wheel with the given tracks and spins, and the droughts those spins leave.
function liveSession(ctx, tracks, spins) {
  return { ...plain(ctx.newSession('american', 500)), id: 'undo-session', tracks: plain(tracks), spins: [...spins], droughts: droughtsAfter(spins) };
}

// Another session of the same shape: no spins, the same bankroll, so no money record tells it apart from the one on screen.
function otherSession(ctx, id, over = {}) {
  return { ...plain(ctx.newSession('american', 500)), id, name: 'Other session', ...over };
}

async function bundle(react) {
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
  const store = {};
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
      throw new Error(`unexpected module in test bundle: ${name}`);
    },
  };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  sandbox.window = sandbox;
  sandbox.window.parent = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(compiled.get(combined), sandbox, { filename: 'bundle.js' });
  return sandbox;
}

// A small hook runner for the real App: state, refs, memo and effects, rendered and flushed by hand. The seed is a function of
// the bundle, so it can build sessions with the bundle's own factories. Mounts in Game mode, as the App does.
async function mountApp(seed = () => ({})) {
  const hooks = [];
  const effects = [];
  let cursor = 0;
  let dirty = true;
  let tree = null;
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
  const ctx = await bundle(react);
  const initial = plain(ctx.loadApp());
  initial.settings.onboarded = true;
  initial.settings.vibration = false;
  initial.currentSession = plain(ctx.newSession('american', 500));
  initial.currentSession.id = 'undo-session';
  initial.gameSession = plain(ctx.newSession('american', 500));
  initial.gameSession.id = 'game-session';
  Object.assign(initial, seed(ctx));
  ctx.loadApp = () => plain(initial);
  ctx.saveApp = () => true;
  ctx.useCasinoRecording = () => ({ record() {}, start() {}, stop() {} });
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
  ctx.alert = () => {};

  function render() {
    cursor = 0;
    dirty = false;
    tree = ctx.module.exports.default();
  }
  async function flush() {
    for (let i = 0; i < 100; i++) {
      if (dirty) render();
      for (const effect of effects.splice(0)) effect();
      await flushPromises();
      if (!dirty && effects.length === 0) return;
    }
    assert.fail('App did not settle');
  }

  // Every element under node that passes the test, in tree order. Walks children arrays and props.children.
  function collect(node, test, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach((child) => collect(child, test, out)); return out; }
    if (test(node)) out.push(node);
    collect(node.props && node.props.children, test, out);
    return out;
  }
  // The Tracker page is a plain function of its props, so it is run here to reach the track cards and the Undo button.
  function trackerTree() {
    const tracker = collect(tree, (n) => n.type && n.type.name === 'TrackerPage')[0];
    assert.ok(tracker, 'the Tracker page is showing (Live mode, Tracker tab)');
    return tracker.type(tracker.props);
  }
  // A page that holds hooks of its own is run on hook slots of its own, from base, so App's slots stay put.
  function pageTree(fn, props, base) {
    const saved = cursor;
    cursor = base;
    try { return fn(props); } finally { cursor = saved; }
  }
  function pageProps(name) {
    const page = collect(tree, (n) => n.type && n.type.name === name)[0];
    assert.ok(page, `the ${name} is showing`);
    return page.props;
  }
  async function press(predicate, what) {
    const button = collect(tree, predicate)[0];
    assert.ok(button, what);
    button.props.onClick();
    await flush();
  }
  function live() { return press((n) => n.type === 'button' && n.props.children === '🎰 Live', 'the Live mode button is showing'); }
  async function tab(label) { return press((n) => n.type === 'button' && n.props.children === label, `the ${label} tab is showing`); }
  // A tap on the Progression grid: tapNumber, which keeps the snapshot that Undo last spin reverts to.
  async function tapGrid(value) {
    const grid = collect(trackerTree(), (n) => n.type && n.type.name === 'FibGrid')[0];
    assert.ok(grid, 'the Progression grid is showing');
    grid.props.onNumber(value);
    await flush();
  }
  // A tap in Game mode through GamePageView's tapNumber (the spin it calls once its animation ends).
  async function gameTap(value) {
    pageProps('GamePageView').tapNumber(value, true, true);
    await flush();
  }
  // Presses a button that a page with hooks of its own draws (SettingsPage's Restart Onboarding).
  async function pressInPage(name, label, base) {
    const page = collect(tree, (n) => n.type && n.type.name === name)[0];
    assert.ok(page, `the ${name} is showing`);
    const button = collect(pageTree(page.type, page.props, base), (n) => n.type === 'button' && n.props.children === label)[0];
    assert.ok(button, `${name} draws a "${label}" button`);
    button.props.onClick();
    await flush();
  }
  // The Undo last spin button as the Tracker page draws it (null when it is not drawn).
  function undoButton() {
    return collect(trackerTree(), (n) => n.type === 'button' && n.props.children === '↩ Undo')[0] || null;
  }
  // Undo is offered when the button is drawn and not disabled.
  function undoAvailable() {
    const button = undoButton();
    return !!button && button.props.disabled !== true;
  }
  // The note under the track cards that carries the Undo refusal. It is always drawn; only its text and visibility change.
  function undoNote() {
    const note = collect(trackerTree(), (n) => n.type === 'div' && n.props['data-undo-note'])[0];
    assert.ok(note, 'the Undo note slot is drawn');
    return note;
  }
  // Presses the Undo button's handler, as a tap does, when the button is drawn at all. The handler itself must refuse.
  async function attemptUndo() {
    const button = undoButton();
    if (button) { button.props.onClick(); await flush(); }
  }
  async function undo() {
    const button = undoButton();
    assert.ok(button, 'the Undo button is drawn');
    button.props.onClick();
    await flush();
  }
  async function resumeSaved(id) {
    pageProps('StatsPage').resumeSaved(id);
    await flush();
  }
  async function saveSession() {
    pageProps('StatsPage').saveSession();
    await flush();
  }
  // Settings' JSON import, through the real file picker path: the input's click hands it the file, read synchronously.
  async function importSessions(payload) {
    const file = { text: JSON.stringify(payload) };
    const input = { click() { this.onchange({ target: { files: [file] } }); } };
    ctx.document = { createElement: () => input, body: { appendChild() {}, removeChild() {} }, addEventListener() {}, removeEventListener() {} };
    ctx.FileReader = class { readAsText(f) { this.onload({ target: { result: f.text } }); } };
    pageProps('SettingsPage').importJSON();
    await flush();
  }
  async function completeOnboarding(choices) {
    pageProps('OnboardingScreen').onComplete(choices);
    await flush();
  }
  // The venue sheet with this title (the start step is "Where are you playing?").
  function sheet(title) {
    return collect(tree, (n) => n.type && n.type.name === 'VenueModal' && n.props.title === title)[0] || null;
  }
  // The hook slot that holds the Undo snapshot with its session id and mode (App's state, found by its shape).
  function undoSlot() {
    return hooks.find((h) => h && h.value && typeof h.value === 'object' && 'sessionId' in h.value) || null;
  }
  const state = () => hooks[0].value.appState;
  return {
    ctx, flush, render, live, tab, tapGrid, gameTap, pressInPage, undoButton, undoAvailable, undoNote, attemptUndo, undo,
    resumeSaved, saveSession, importSessions, completeOnboarding, sheet, undoSlot, pageProps, hooks, state,
    tracks: () => plain(state().currentSession.tracks),
  };
}

// A Live session with the given tracks and spins, mounted and switched to Live.
async function mountLive(tracks = [freshProgression()], spins = [], extra = () => ({})) {
  const app = await mountApp((ctx) => ({ currentSession: liveSession(ctx, tracks, spins), ...extra(ctx) }));
  await app.flush();
  await app.live();
  return app;
}

// -- The session-id and mode binding, through the real App --

test('resume: Undo is not offered after a saved session is resumed, and the resumed session is not overwritten', async () => {
  const app = await mountLive([freshProgression()], [], (ctx) => ({ savedSessions: [otherSession(ctx, 'saved-b')] }));
  await app.tapGrid(MISS);
  assert.equal(app.state().currentSession.spins.length, 1, 'the tapped spin is recorded');
  await app.tab('Stats');
  await app.resumeSaved('saved-b');
  await app.tab('Tracker');
  assert.equal(app.state().currentSession.id, 'saved-b', 'the saved session is current');
  assert.equal(app.undoAvailable(), false, 'Undo is not offered after the resume');
  await app.attemptUndo();
  assert.equal(app.state().currentSession.id, 'saved-b', 'Undo did not restore the session the resume replaced');
});

test('JSON import: Undo is not offered after an import loads a session, and the imported session is not overwritten', async () => {
  const app = await mountLive([freshProgression()], []);
  await app.tapGrid(MISS);
  await app.tab('Settings');
  await app.importSessions({ sessions: [otherSession(app.ctx, 'imp-1')] });
  await app.tab('Tracker');
  assert.equal(app.state().currentSession.id, 'imp-1', 'the imported session is current');
  assert.equal(app.undoAvailable(), false, 'Undo is not offered after the import');
  await app.attemptUndo();
  assert.equal(app.state().currentSession.id, 'imp-1', 'Undo did not restore the session the import replaced');
});

test('Restart Onboarding with a new wheel: Undo is not offered, and Undo does not turn the wheel back', async () => {
  const app = await mountLive([freshProgression()], []);
  app.ctx.confirm = () => true;
  await app.tapGrid(MISS);
  const bankroll = app.state().currentSession.bankrollCurrent;
  await app.tab('Settings');
  await app.pressInPage('SettingsPage', 'Restart Onboarding', 7000);
  await app.completeOnboarding({ roulette: 'european', bankroll, defaultBuyIn: 100, currency: 'USD', tableMinBet: 10, tableMaxBet: 500, tableMaxTotal: 10000 });
  await app.tab('Tracker');
  assert.equal(app.state().currentSession.roulette, 'european', 'the wheel is changed');
  assert.equal(app.undoAvailable(), false, 'Undo is not offered after the wheel changed');
  await app.attemptUndo();
  assert.equal(app.state().currentSession.roulette, 'european', 'Undo did not turn the wheel back');
});

test('Game/Live mode switch: a snapshot taken in Game is not offered in Live, and nothing from Game is restored into Live', async () => {
  const app = await mountApp();
  await app.flush();
  await app.gameTap('7');
  assert.equal(app.state().gameSession.spins.length, 1, 'the Game spin is recorded');
  await app.tab('🎰 Live');
  assert.equal(app.undoAvailable(), false, 'Undo is not offered in Live');
  await app.attemptUndo();
  assert.equal(app.state().currentSession.spins.length, 0, 'the Live session stays empty');
  assert.equal(app.state().gameSession.spins.length, 1, 'the Game session keeps its spin');
});

test('a snapshot whose session id does not match is never applied, even when something sets it', async () => {
  const app = await mountLive([freshProgression()], []);
  app.ctx.confirm = () => true;
  await app.tapGrid(MISS);
  const before = plain(app.state().currentSession);
  const slot = app.undoSlot();
  assert.ok(slot, 'the Undo snapshot is held with its session id and mode');
  slot.set({ ...slot.value, sessionId: 'some-other-session' });
  app.render();
  assert.equal(app.undoAvailable(), false, 'a snapshot for another session is not offered');
  await app.attemptUndo();
  assert.deepEqual(plain(app.state().currentSession), before, 'and nothing is restored');
  await app.flush();
});

test('a venue recorded after the spin (Save on the start sheet) refuses Undo with the change reason', async () => {
  const app = await mountLive([freshProgression()], []);
  await app.tapGrid(MISS);
  const start = app.sheet('Where are you playing?');
  assert.ok(start, 'the start sheet opens after the first tracked spin');
  start.props.onSave({ casino: 'Harbor Casino', kind: 'table', table: 'Table 4', dealer: 'Ana' }, []);
  await app.flush();
  assert.equal(app.state().currentSession.venue.casino, 'Harbor Casino', 'the venue is recorded');
  assert.equal(app.undoAvailable(), false, 'Undo is disabled once a venue is recorded after the spin');
  assert.equal(app.undoNote().props.children, CHANGED_REASON, 'the reason is drawn');
});

test('Skip on the start sheet leaves Undo offered, and Undo reverts the spin', async () => {
  const app = await mountLive([freshProgression()], []);
  app.ctx.confirm = () => true;
  await app.tapGrid(MISS);
  app.sheet('Where are you playing?').props.onDismiss();
  await app.flush();
  assert.equal(app.undoAvailable(), true, 'Undo is offered: nothing changed after the spin');
  await app.undo();
  assert.equal(app.state().currentSession.spins.length, 0, 'Undo reverts the spin');
});

test('Save of the session after a spin leaves Undo offered, as before, and Undo still reverts the spin', async () => {
  const app = await mountLive([freshProgression()], []);
  app.ctx.confirm = () => true;
  await app.tapGrid(MISS);
  await app.tab('Stats');
  await app.saveSession();
  await app.tab('Tracker');
  assert.equal(app.undoAvailable(), true, 'Undo is offered after a Save');
  await app.undo();
  assert.equal(app.state().currentSession.spins.length, 0, 'Undo reverts the spin after a Save');
});

// -- undoBlockReason: what the tap explains, and what it does not (raw sessions, as the App and its unit tests pass them) --

async function snapshotPair() {
  const ctx = await bundle(React);
  const base = plain(ctx.newSession('american', 500));
  base.spins = ['1', '2'];
  base.droughts = droughtsAfter(base.spins);
  const tapped = plain(ctx.applySpin(base, '7', true).sess);
  return { ctx, base, tapped };
}

test('undoBlockReason: the tapped spin, a Save and a track change alone are not refused', async () => {
  const { ctx, base, tapped } = await snapshotPair();
  assert.equal(ctx.undoBlockReason(tapped, base), null, 'the tapped spin alone can be undone');
  const saved = { ...tapped, modified: tapped.modified + 5, mode: 'live', metrics: { netPnL: 0 }, sessionStartedAt: 123,
    tracks: [...tapped.tracks, freshProgression({ id: 'trk-new', createdAtSpin: 3 })] };
  assert.equal(ctx.undoBlockReason(saved, base), null, 'a Save stamps mode and metrics, and a new track is a track change: neither refuses Undo');
});

test('undoBlockReason: a changed wheel, label or id is refused, because Undo would undo that change', async () => {
  const { ctx, base, tapped } = await snapshotPair();
  assert.equal(ctx.undoBlockReason({ ...tapped, roulette: 'european' }, base), CHANGED_REASON, 'a wheel change');
  assert.equal(ctx.undoBlockReason({ ...tapped, label: 'Tuesday' }, base), CHANGED_REASON, 'a label');
  assert.equal(ctx.undoBlockReason({ ...tapped, id: 'other' }, base), CHANGED_REASON, 'another session');
});

test('undoBlockReason: a spin list that is not the snapshot plus the tapped spin is refused, even at the same length', async () => {
  const { ctx, base, tapped } = await snapshotPair();
  assert.equal(ctx.undoBlockReason({ ...tapped, spins: ['1', '9', '7'] }, base), CHANGED_REASON, 'an earlier spin changed');
  assert.equal(ctx.undoBlockReason(base, base), CHANGED_REASON, 'no spin was added since the snapshot');
  assert.equal(ctx.undoBlockReason({ ...tapped, spins: ['1', '2', '7', '3'] }, base), SPIN_REASON, 'two spins since the snapshot keep their reason');
});

test('the changed-session reason is worded in spin-apply.js only, and App.jsx stays under the 900-line test cap', async () => {
  const spin = await readFile(new URL('spin-apply.js', SRC), 'utf8');
  const app = await readFile(new URL('App.jsx', SRC), 'utf8');
  assert.ok(spin.includes(CHANGED_REASON), 'spin-apply.js holds the changed-session reason');
  assert.doesNotMatch(app, /the session was changed after the spin/, 'App.jsx names no reason of its own');
  assert.ok(app.split('\n').length - 1 < 900, 'App.jsx stays under the 900-line test cap');
});
