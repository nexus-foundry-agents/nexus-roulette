import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';

// UNDO-OTHER-GAPS: Undo last spin restores the session as it was before the last tapped spin. Three paths changed the session
// without touching that snapshot, so Undo could reverse more than the spin:
//   - Abandon Progression writes an abandon record into a track's bets and moves its P&L, but no money record, so the money
//     check never sees it. Undo is refused after an abandon made after the spin, with its reason (undoBlockReason).
//   - Clear History on the Spin Log tab removes the spins, and Undo could bring them back. It clears the snapshot with them.
//   - End Session, Tear and New session replace the current session, and Undo could restore the replaced one. Each clears it.
// The real App runs under the hook runner that track-edit-park.test.mjs uses. The runner is copied here rather than imported,
// because importing a test file would run its tests a second time (the convention of the other App tests).

const SRC = new URL('../nexus-src/src/', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));
const flushPromises = () => new Promise((resolve) => setImmediate(resolve));
const compiled = new Map();
const AMERICAN = ['0', '00', ...Array.from({ length: 36 }, (_, i) => String(i + 1))];
const SPINS = ['1', '24', '5', '16'];
const PARK_RULES = { droughtThreshold: null, waitForWin: false, parkAfterStopLoss: false, parkAfterLoss: false };
// A number outside the first dozen: the Progression Bet on the first dozen misses it, so its money moves.
const MISS = '30';

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
function freshProgression() {
  return {
    id: 'prog-1', type: 'fibonacci', color: '#60a5fa', state: 'active', level: 0, pnl: 0, wins: 0, sequences: 0,
    createdAtSpin: 0, closedAtSpin: null, bets: [],
    config: { type: 'fibonacci', unit: 1, roi: 15, betMode: 'progression', dozenTargets: [0], colTargets: [], evenTargets: [], stopLoss: 200, parkRules: PARK_RULES },
  };
}

// A Solution with no bets: a spin on it moves no money, so the bankroll and every money record stay as they were.
function idleSolution() {
  return {
    id: 'sol-1', type: 'solution', color: '#fbbf24', state: 'active', level: 0, pnl: 0, wins: 0, sequences: 0,
    createdAtSpin: 0, closedAtSpin: null, bets: [],
    config: { type: 'solution', unit: 1, roi: 10, entryThreshold: 120, stopLoss: 200, parkRules: PARK_RULES, activeBets: [], chaseNumber: null },
  };
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

// A small hook runner for the real App: state, refs, memo and effects, rendered and flushed by hand.
async function mountApp() {
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
  // The Tracker page is a plain function of its props, so it is run here to reach the track cards it draws.
  function trackerTree() {
    const tracker = collect(tree, (n) => n.type && n.type.name === 'TrackerPage')[0];
    assert.ok(tracker, 'the Tracker page is showing (Live mode)');
    return tracker.type(tracker.props);
  }
  // A page that holds hooks of its own (SpinPage, StatsPage) is run on hook slots of its own, from base, so App's slots stay put.
  function pageTree(fn, props, base) {
    const saved = cursor;
    cursor = base;
    try { return fn(props); } finally { cursor = saved; }
  }
  function live() {
    const button = collect(tree, (n) => n.type === 'button' && String(n.props.children).includes('Live'))[0];
    assert.ok(button, 'the Live mode button is showing');
    button.props.onClick();
  }
  // A tap on the Progression grid: tapNumber, which keeps the snapshot that Undo last spin reverts to.
  async function tapGrid(value) {
    const grid = collect(trackerTree(), (n) => n.type && n.type.name === 'FibGrid')[0];
    assert.ok(grid, 'the Progression grid is showing');
    grid.props.onNumber(value);
    await flush();
  }
  // A tap on the Solution grid, which is tapNumber as well.
  async function tapSolution(value) {
    const grid = collect(trackerTree(), (n) => n.type && n.type.name === 'SolGrid')[0];
    assert.ok(grid, 'the Solution grid is showing');
    grid.props.onNumber(value);
    await flush();
  }
  // The Abandon Progression button, the one whose label names the track's level (the Tracker page draws it under the cards).
  async function abandon() {
    const button = collect(trackerTree(), (n) => n.type === 'button' && String(n.props.children).includes('Lvl'))[0];
    assert.ok(button, 'an Abandon Progression button is showing');
    button.props.onClick();
    await flush();
  }
  // End Session: the header button (its confirm is stubbed by the test), then the venue step, which a session with no venue
  // opens first. Skip ends the session, as the venue step's dismiss does.
  async function endSession() {
    const button = collect(trackerTree(), (n) => n.type === 'button' && n.props.children === '■ End Session')[0];
    assert.ok(button, 'the End Session button is showing');
    button.props.onClick();
    await flush();
    // The start step (Where are you playing?) is a VenueModal too, so the end step is found by its title.
    const sheet = collect(tree, (n) => n.type && n.type.name === 'VenueModal' && n.props.title === 'Confirm venue')[0];
    assert.ok(sheet, 'the venue step opens for a session with no venue');
    sheet.props.onDismiss();
    await flush();
  }
  // Presses a tab of the Live page by its label.
  async function tab(label) {
    const button = collect(tree, (n) => n.type === 'button' && n.props.children === label)[0];
    assert.ok(button, `the ${label} tab is showing`);
    button.props.onClick();
    await flush();
  }
  // Presses a button that a page with hooks of its own draws (SpinPage's Clear History, StatsPage's Tear and New).
  async function pressInPage(name, label, base) {
    const page = collect(tree, (n) => n.type && n.type.name === name)[0];
    assert.ok(page, `the ${name} page is showing`);
    const button = collect(pageTree(page.type, page.props, base), (n) => n.type === 'button' && n.props.children === label)[0];
    assert.ok(button, `${name} draws a "${label}" button`);
    button.props.onClick();
    await flush();
  }
  // The Undo last spin button as the Tracker page draws it (null when it is not drawn).
  function undoButton() {
    return collect(trackerTree(), (n) => n.type === 'button' && n.props.children === '↩ Undo')[0] || null;
  }
  // The note under the track cards that carries the Undo refusal. It is always drawn; only its text and visibility change.
  function undoNote() {
    const note = collect(trackerTree(), (n) => n.type === 'div' && n.props['data-undo-note'])[0];
    assert.ok(note, 'the Undo note slot is drawn');
    return note;
  }
  // Presses the Undo button's handler, as a tap does: the handler itself must refuse, not the disabled attribute.
  async function undo() {
    const button = undoButton();
    assert.ok(button, 'the Undo button is drawn');
    button.props.onClick();
    await flush();
  }
  const state = () => hooks[0].value.appState;
  return {
    ctx, flush, live, tapGrid, tapSolution, abandon, endSession, tab, pressInPage, undoButton, undoNote, undo, state,
    tracks: () => plain(state().currentSession.tracks),
    restoreSession(over) {
      hooks[0].value = { ...hooks[0].value, appState: { ...hooks[0].value.appState,
        currentSession: { ...hooks[0].value.appState.currentSession, ...over } } };
      dirty = true;
    },
  };
}

// Mounts the real App in Live mode on a seeded session: its tracks, its spins and the droughts those spins leave.
async function mountLive(tracks, spins = SPINS) {
  const app = await mountApp();
  await app.flush();
  app.restoreSession({ tracks: plain(tracks), spins: [...spins], droughts: droughtsAfter(spins) });
  await app.flush();
  app.live();
  await app.flush();
  return app;
}

// The refusal Undo shows for an abandon made after the spin (ABANDON in spin-apply.js).
const ABANDON_REASON = 'Undo is off after a track was abandoned. Fix the number instead.';

test('Undo after an Abandon Progression is refused with its reason, and the abandon stays', async () => {
  const app = await mountLive([freshProgression()], []);
  await app.tapGrid(MISS);
  app.ctx.confirm = () => true;
  await app.abandon();
  const abandoned = app.tracks();
  assert.equal(abandoned[0].bets[abandoned[0].bets.length - 1].type, 'abandon', 'the abandon is recorded');

  assert.equal(app.undoButton().props.disabled, true, 'Undo is disabled after the abandon');
  assert.equal(app.undoNote().props.children, ABANDON_REASON, 'the abandon reason is drawn');
  assert.equal(app.undoNote().props.style.visibility, 'visible');

  await app.undo();
  assert.equal(app.state().currentSession.spins.length, 1, 'Undo is refused, so the spin stays');
  assert.deepEqual(app.tracks(), abandoned, 'Undo did not drop the abandon');
});

test('an abandon made before a spin is kept by Undo of that spin, and Undo is still offered', async () => {
  const app = await mountLive([freshProgression()], []);
  app.ctx.confirm = () => true;
  await app.abandon();
  const abandoned = app.tracks();
  await app.tapGrid(MISS);

  assert.equal(app.undoButton().props.disabled, false, 'Undo is offered: nothing changed after the spin');
  assert.equal(app.undoNote().props.children, null, 'no refusal is drawn');

  await app.undo();
  assert.equal(app.state().currentSession.spins.length, 0, 'Undo reverts the spin');
  assert.deepEqual(app.tracks(), abandoned, 'the abandon made before the spin is kept');
});

test('Clear History on the Spin Log tab leaves no Undo offered, so the cleared spins cannot come back', async () => {
  const app = await mountLive([freshProgression()], []);
  await app.tapGrid(MISS);
  await app.tab('Spin Log');
  app.ctx.confirm = () => true;
  await app.pressInPage('SpinPage', 'Clear History', 5000);
  assert.equal(app.state().currentSession.spins.length, 0, 'the spins are cleared');

  await app.tab('Tracker');
  assert.equal(app.undoButton(), null, 'Undo is not offered after Clear History');
});

test('End Session after a spin that moved no money leaves no Undo offered, so the ended session is not restored', async () => {
  const app = await mountLive([idleSolution()], []);
  await app.tapSolution(MISS);
  assert.equal(app.state().currentSession.spins.length, 1, 'the spin is recorded');
  app.ctx.confirm = () => true;
  await app.endSession();
  assert.equal(app.state().currentSession.spins.length, 0, 'the session has ended and a new one is current');

  assert.equal(app.undoButton(), null, 'Undo is not offered after End Session');
});

test('End Session after a spin that moved money leaves no Undo offered', async () => {
  const app = await mountLive([freshProgression()], []);
  await app.tapGrid(MISS);
  app.ctx.confirm = () => true;
  await app.endSession();
  assert.equal(app.state().currentSession.spins.length, 0, 'the session has ended and a new one is current');

  assert.equal(app.undoButton(), null, 'Undo is not offered after End Session');
});

test('Tear session after a tracked spin leaves no Undo offered, so the torn session is not restored', async () => {
  const app = await mountLive([freshProgression()], []);
  await app.tapGrid(MISS);
  await app.tab('Stats');
  app.ctx.confirm = () => true;
  await app.pressInPage('StatsPage', 'Tear', 6000);
  assert.equal(app.state().currentSession.spins.length, 0, 'the session is torn');

  await app.tab('Tracker');
  assert.equal(app.undoButton(), null, 'Undo is not offered after Tear');
});

test('New session after a tracked spin leaves no Undo offered, so the replaced session is not restored', async () => {
  const app = await mountLive([freshProgression()], []);
  await app.tapGrid(MISS);
  await app.tab('Stats');
  app.ctx.confirm = () => true;
  await app.pressInPage('StatsPage', 'New', 6000);
  assert.equal(app.state().currentSession.spins.length, 0, 'the new session is empty');

  await app.tab('Tracker');
  assert.equal(app.undoButton(), null, 'Undo is not offered after New');
});

test('the abandon refusal is worded in spin-apply.js only, and App.jsx names no Undo reason of its own', async () => {
  const spin = await readFile(new URL('spin-apply.js', SRC), 'utf8');
  const app = await readFile(new URL('App.jsx', SRC), 'utf8');
  assert.ok(spin.includes(ABANDON_REASON), 'spin-apply.js holds the abandon refusal');
  assert.doesNotMatch(app, /Undo is off after a track was abandoned/, 'App.jsx names no abandon refusal');
});
