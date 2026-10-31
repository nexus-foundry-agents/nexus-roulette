import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';

// UNDO-TRACK-EDITS: Undo last spin is refused after any track change made after the spin. The refusal is one comparison in
// undoBlockReason (spin-apply.js): the session's tracks must be the snapshot's tracks plus the tapped spin's own settlement, so an
// action added later is refused by the same comparison. The snapshot also records the tapped number, so a replace of that number
// is refused. The Undo button keeps its slot in the Add Track row (rule 82): its visibility changes, and the row has the same slots
// whatever Undo is doing.
// The real App runs under the hook runner that undo-snapshot-class.test.mjs uses. The runner is copied here rather than imported,
// because importing a test file would run its tests a second time (the convention of the other App tests).

const SRC = new URL('../nexus-src/src/', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));
const flushPromises = () => new Promise((resolve) => setImmediate(resolve));
const compiled = new Map();
const AMERICAN = ['0', '00', ...Array.from({ length: 36 }, (_, i) => String(i + 1))];
const PARK_RULES = { droughtThreshold: null, waitForWin: false, parkAfterStopLoss: false, parkAfterLoss: false };
// A number outside the first dozen: the Progression Bet on the first dozen misses it.
const MISS = '30';

const UNDO_TRACK_REASON = 'Undo is off after a track change. Fix the number instead.';
const CHANGED_REASON = 'Undo is off: the session was changed after the spin it would reverse. Undo would drop that change.';

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

// A Solution track holding the given numbers at level 0, chasing the first.
function solutionTrack(ctx, numbers, over = {}) {
  const config = { ...ctx.defaultSolCfg(), activeBets: numbers.map((n) => ({ number: n, level: 0, invest: 0 })), chaseNumber: numbers[0] };
  return { ...plain(ctx.newTrack('solution', 1, config, '#f59e0b')), ...over };
}

// A Live session on the American wheel with the given tracks and spins, and the droughts those spins leave.
function liveSession(ctx, tracks, spins) {
  return { ...plain(ctx.newSession('american', 500)), id: 'undo-session', tracks: plain(tracks), spins: [...spins], droughts: droughtsAfter(spins) };
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
  function trackerNode(predicate, what) {
    const node = collect(trackerTree(), predicate)[0];
    assert.ok(node, what);
    return node;
  }
  // A tracker button (the Add Track button, a card's Park, Close or Resume), pressed with the event a card's handler reads.
  async function pressTracker(predicate, what) {
    trackerNode(predicate, what).props.onClick({ stopPropagation() {} });
    await flush();
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
    trackerNode((n) => n.type && n.type.name === 'FibGrid', 'the Progression grid is showing').props.onNumber(value);
    await flush();
  }
  // A tap on the Solution's grid: tapNumber through the Solution track.
  async function tapSolution(value) {
    trackerNode((n) => n.type && n.type.name === 'SolGrid', 'the Solution grid is showing').props.onNumber(value);
    await flush();
  }
  // The Solution's Active Bets: one tap adds or removes that held bet (addSolBet).
  async function solToggle(number) {
    trackerNode((n) => n.type && n.type.name === 'SolActiveBets', 'the Solution Active Bets are showing').props.onToggle(number);
    await flush();
  }
  // Two track cards dragged by their handle: the touch handlers the card draws, in the order a touch sends them (moveTrack).
  async function dragCard(from, to) {
    const cards = () => collect(trackerTree(), (n) => n.type === 'div' && n.props.onTouchStart && n.props.onTouchMove && n.props.onTouchEnd);
    assert.ok(cards().length >= 2, 'two track cards are drawn');
    cards()[from].props.onTouchStart({ target: { dataset: { handle: '1' } }, preventDefault() {} });
    await flush();
    cards()[to].props.onTouchMove({ preventDefault() {} });
    await flush();
    cards()[from].props.onTouchEnd();
    await flush();
  }
  // The Add Track row: the element whose children include the "+ Add Track" button. The Undo button is its other child.
  function addRow() {
    const row = collect(trackerTree(), (n) => n.type === 'div' && Array.isArray(n.props.children)
      && n.props.children.some((c) => c && c.type === 'button' && c.props.children === '+ Add Track'))[0];
    assert.ok(row, 'the Add Track row is drawn');
    return row;
  }
  // The Undo last spin button as the Tracker page draws it (null when it is not drawn).
  function undoButton() {
    return collect(trackerTree(), (n) => n.type === 'button' && n.props.children === '↩ Undo')[0] || null;
  }
  // Undo is offered when the button is drawn, visible and not disabled.
  function undoAvailable() {
    const button = undoButton();
    return !!button && button.props.disabled !== true && button.props.style.visibility !== 'hidden';
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
  const state = () => hooks[0].value.appState;
  return {
    ctx, flush, render, live, tab, tapGrid, tapSolution, solToggle, dragCard, pressTracker, trackerNode, addRow, undoButton,
    undoAvailable, undoNote, attemptUndo, pageProps, hooks, state,
    tracks: () => plain(state().currentSession.tracks),
  };
}

// A Live session with the given tracks and spins, mounted and switched to Live.
async function mountLive(tracks = [freshProgression()], spins = []) {
  const app = await mountApp((ctx) => ({ currentSession: liveSession(ctx, tracks, spins) }));
  await app.flush();
  await app.live();
  return app;
}

// A Live session whose tracks are built from the bundle's own factories (a Solution track needs them), mounted in Live.
async function mountLiveWith(build) {
  const app = await mountApp((ctx) => ({ currentSession: liveSession(ctx, build(ctx), []) }));
  await app.flush();
  await app.live();
  return app;
}

// A same-session replace that changes only the tapped number, as a sync that brings in another copy of the session would.
function replaceLastSpin(app, value) {
  const appState = plain(app.state());
  const s = appState.currentSession;
  s.spins[s.spins.length - 1] = value;
  s.droughts = droughtsAfter(s.spins);
  app.hooks[0].set({ ...app.hooks[0].value, appState });
}

// -- Each track action made after a spin, through the real App --

// The action made after the spin stays. Undo is pressed first (a handler that refuses does nothing), so a silent revert shows as
// a change to the spins or the tracks. Then the refusal is checked as the Tracker draws it.
async function assertKeptAfterUndo(app, expect) {
  app.ctx.confirm = () => true;
  await app.attemptUndo();
  assert.equal(app.state().currentSession.spins.length, expect.spins, 'Undo did not reverse the spin');
  assert.deepEqual(app.tracks(), expect.tracks, 'Undo did not drop the track change');
  assert.equal(app.undoAvailable(), false, 'Undo is not offered after the track change');
  assert.equal(app.undoNote().props.children, UNDO_TRACK_REASON, 'the track-change reason is drawn');
}

test('addTrack after a spin: Undo is refused and does not drop the new track', async () => {
  const app = await mountLive([freshProgression()], []);
  await app.tapGrid(MISS);
  await app.pressTracker((n) => n.type === 'button' && n.props.children === '+ Add Track', 'the Add Track button is drawn');
  app.trackerNode((n) => n.type && n.type.name === 'AddTrackPanel', 'the add panel is drawn').props.onAdd('fibonacci', app.ctx.defaultFibCfg());
  await app.flush();
  assert.equal(app.tracks().length, 2, 'the track is added after the spin');
  await assertKeptAfterUndo(app, { spins: 1, tracks: app.tracks() });
});

test('closeTrack after a spin: Undo is refused and the track stays closed', async () => {
  const app = await mountLive([freshProgression(), freshProgression({ id: 'prog-2' })], []);
  app.ctx.confirm = () => true;
  await app.tapGrid(MISS);
  await app.pressTracker((n) => n.type === 'button' && n.props.children === '×', 'the first track card has its × button');
  assert.equal(app.tracks()[0].state, 'closed', 'the track is closed after the spin');
  await assertKeptAfterUndo(app, { spins: 1, tracks: app.tracks() });
});

test('reactivateTrack after a spin: Undo is refused and the track stays active', async () => {
  const app = await mountLive([freshProgression(), freshProgression({ id: 'prog-2', state: 'closed', closedAtSpin: 0 })], []);
  app.ctx.confirm = () => true;
  await app.tapGrid(MISS);
  await app.tab('Stats');
  app.pageProps('StatsPage').reactivateTrack('prog-2');
  await app.flush();
  assert.equal(app.tracks()[1].state, 'active', 'the track is reactivated after the spin');
  await assertKeptAfterUndo(app, { spins: 1, tracks: app.tracks() });
});

test('moveTrack after a spin: Undo is refused and the track keeps its new place', async () => {
  const app = await mountLive([freshProgression(), freshProgression({ id: 'prog-2' })], []);
  app.ctx.confirm = () => true;
  await app.tapGrid(MISS);
  await app.dragCard(0, 1);
  assert.deepEqual(app.tracks().map((t) => t.id), ['prog-2', 'prog-1'], 'the first track is moved after the spin');
  await assertKeptAfterUndo(app, { spins: 1, tracks: app.tracks() });
});

test('a Solution bet added after a spin: Undo is refused and the bet stays', async () => {
  const app = await mountLiveWith((ctx) => [solutionTrack(ctx, ['17'])]);
  app.ctx.confirm = () => true;
  await app.tapSolution('5');
  await app.solToggle('9');
  assert.deepEqual(app.tracks()[0].config.activeBets.map((b) => b.number).sort(), ['17', '9'], 'the bet is added after the spin');
  await assertKeptAfterUndo(app, { spins: 1, tracks: app.tracks() });
});

test('a Solution bet removed after a spin: Undo is refused and the bet stays removed', async () => {
  const app = await mountLiveWith((ctx) => [solutionTrack(ctx, ['17', '9'])]);
  app.ctx.confirm = () => true;
  await app.tapSolution('5');
  await app.solToggle('9');
  assert.deepEqual(app.tracks()[0].config.activeBets.map((b) => b.number), ['17'], 'the bet is removed after the spin');
  await assertKeptAfterUndo(app, { spins: 1, tracks: app.tracks() });
});

// -- The tapped number (FIX C) --

test('a same-session replace of the tapped number refuses Undo, and Undo keeps the replaced spin', async () => {
  const app = await mountLive([freshProgression()], []);
  app.ctx.confirm = () => true;
  await app.tapGrid(MISS);
  replaceLastSpin(app, '31');
  await app.flush();
  assert.deepEqual(app.state().currentSession.spins, ['31'], 'the tapped spin is replaced');
  await app.attemptUndo();
  assert.deepEqual(app.state().currentSession.spins, ['31'], 'Undo did not reverse the replaced spin');
  assert.equal(app.undoAvailable(), false, 'Undo is not offered after the replace');
  assert.equal(app.undoNote().props.children, CHANGED_REASON, 'the changed-session reason is drawn');
});

// -- The Add Track row keeps its slots (FIX B, rule 82) --

// The row's layout, without what Undo and Add change when they are offered, refused or shown: visibility, opacity and cursor.
function layoutOf(style) {
  const { visibility, opacity, cursor, ...layout } = style;
  return layout;
}

test('the Add Track row has the same slots with Undo absent, offered, refused, and while the add panel is open', async () => {
  const app = await mountLive([freshProgression()], []);
  const rowState = () => {
    const kids = app.addRow().props.children;
    return { kinds: kids.map((c) => (c ? c.type : null)), add: kids[0], undo: kids[1] };
  };
  const absent = rowState();
  assert.ok(absent.undo, 'with no spin the Undo button still has its slot in the row');
  assert.equal(absent.undo.props.style.visibility, 'hidden', 'with no spin Undo is kept in its slot, hidden');
  assert.equal(absent.undo.props['aria-hidden'], true, 'and hidden from the accessibility tree');

  await app.tapGrid(MISS);
  const offered = rowState();
  assert.equal(offered.undo.props.style.visibility, 'visible', 'after a spin Undo is offered');
  assert.equal(offered.undo.props.disabled, false, 'and enabled');

  await app.pressTracker((n) => n.type === 'button' && n.props.children === '⏸ Park', 'the card Park button is drawn');
  const refused = rowState();
  assert.equal(refused.undo.props.style.visibility, 'visible', 'after a park Undo is drawn, disabled');
  assert.equal(refused.undo.props.disabled, true, 'and refused');

  await app.pressTracker((n) => n.type === 'button' && n.props.children === '+ Add Track', 'the Add Track button is drawn');
  const adding = rowState();

  for (const [label, s] of [['absent', absent], ['offered', offered], ['refused', refused], ['adding', adding]]) {
    assert.deepEqual(s.kinds, ['button', 'button'], `${label}: the row holds the Add button and the Undo button`);
    assert.deepEqual(layoutOf(s.add.props.style), layoutOf(absent.add.props.style), `${label}: the Add button keeps its layout`);
    assert.deepEqual(layoutOf(s.undo.props.style), layoutOf(absent.undo.props.style), `${label}: the Undo button keeps its layout`);
  }
  assert.equal(adding.add.props.style.visibility, 'hidden', 'while the add panel is open the Add button is hidden in its slot');
  assert.equal(adding.add.props['aria-hidden'], true, 'and hidden from the accessibility tree');
  assert.equal(offered.add.props.style.visibility, 'visible', 'the Add button is visible while the panel is closed');
});

// -- undoBlockReason: what the tap explains, and what it does not (raw sessions, as the App and its unit tests pass them) --

test('undoBlockReason: a track change of any kind after the spin refuses Undo; the tap alone and a Save do not', async () => {
  const ctx = await bundle(React);
  const base = plain(ctx.newSession('american', 500));
  base.tracks = plain([freshProgression(), solutionTrack(ctx, ['17'], { id: 'sol-1' })]);
  base.spins = ['1', '2'];
  base.droughts = droughtsAfter(base.spins);
  const tapped = plain(ctx.applySpin(base, '7', true).sess);
  assert.equal(ctx.undoBlockReason(tapped, base, '7'), null, 'the tapped spin alone can be undone');
  const saved = { ...tapped, mode: 'live', metrics: { netPnL: 0 }, modified: tapped.modified + 5 };
  assert.equal(ctx.undoBlockReason(saved, base, '7'), null, 'a Save stamps mode and metrics and changes no track');
  const changes = [
    ['a track added', (t) => t.push(freshProgression({ id: 'trk-new', createdAtSpin: 3 }))],
    ['a track closed', (t) => { t[0].state = 'closed'; t[0].closedAtSpin = 3; }],
    ['a track parked', (t) => { t[0].state = 'parked'; }],
    ['the tracks reordered', (t) => { t.reverse(); }],
    ['a Solution bet added', (t) => { t[1].config.activeBets.push({ number: '9', level: 0, invest: 0 }); }],
    ['a Solution bet removed', (t) => { t[1].config.activeBets = []; }],
    ['a Solution chase changed', (t) => { t[1].config.chaseNumber = '9'; }],
    ['a track pnl changed', (t) => { t[0].pnl += 1; }],
    ['a bet added to a track record', (t) => { t[0].bets.push({ spinIdx: 2, level: 0, outcome: 'loss', profit: -1, cat: 'loss' }); }],
  ];
  for (const [what, change] of changes) {
    const changed = plain(tapped);
    change(changed.tracks);
    assert.equal(ctx.undoBlockReason(changed, base, '7'), UNDO_TRACK_REASON, `${what} after the spin refuses Undo`);
  }
});

test('undoBlockReason: the tapped number must be the last spin, and a replace of it is refused with the changed-session reason', async () => {
  const ctx = await bundle(React);
  const base = plain(ctx.newSession('american', 500));
  base.spins = ['1', '2'];
  base.droughts = droughtsAfter(base.spins);
  const tapped = plain(ctx.applySpin(base, '7', true).sess);
  assert.equal(ctx.undoBlockReason(tapped, base, '7'), null, 'the recorded number is the last spin');
  assert.equal(ctx.undoBlockReason(tapped, base, '8'), CHANGED_REASON, 'a snapshot that recorded another number is refused');
  assert.equal(ctx.undoBlockReason(tapped, base), CHANGED_REASON, 'a snapshot with no recorded number is refused');
  const replaced = plain(ctx.applySpin(base, '9', true).sess);
  assert.equal(ctx.undoBlockReason(replaced, base, '7'), CHANGED_REASON, 'a replace of the tapped number is refused');
});

test('the track-change and changed-number reasons are worded in spin-apply.js only, and App.jsx stays under the 900-line cap', async () => {
  const spin = await readFile(new URL('spin-apply.js', SRC), 'utf8');
  const app = await readFile(new URL('App.jsx', SRC), 'utf8');
  assert.ok(spin.includes(UNDO_TRACK_REASON), 'spin-apply.js holds the track-change reason');
  assert.doesNotMatch(app, /Undo is off after a track change/, 'App.jsx names no track-change reason of its own');
  assert.ok(app.split('\n').length - 1 < 900, 'App.jsx stays under the 900-line test cap');
});
