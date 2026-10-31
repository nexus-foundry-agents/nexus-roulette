import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';

// TRACK-EDIT-PARK: every Edit Config save that changes anything parks the track it came from and starts a new active track
// with the saved config. A Solution's held bets, their levels and its chased number move to the new track.
// The real App runs under the hook runner that board-add-repeats.test.mjs uses. The runner is copied here rather than
// imported, because importing a test file would run its tests a second time (session-flows.test.mjs does the same). A save
// is the one the Edit Config panel makes: its onSave prop, which calls updateTrackConfig. Settlement and correction are the
// real spin-apply.js.

const SRC = new URL('../nexus-src/src/', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));
const flushPromises = () => new Promise((resolve) => setImmediate(resolve));
const compiled = new Map();
const AMERICAN = ['0', '00', ...Array.from({ length: 36 }, (_, i) => String(i + 1))];
const SPINS = ['1', '24', '5', '16'];
const PARK_RULES = { droughtThreshold: null, waitForWin: false, parkAfterStopLoss: false, parkAfterLoss: false };

// Each number counts the spins since it last came up (every spin when it never has), as applySpin keeps them.
function droughtsAfter(spins) {
  const out = {};
  AMERICAN.forEach((n) => {
    const at = spins.lastIndexOf(n);
    out[n] = at < 0 ? spins.length : spins.length - 1 - at;
  });
  return out;
}

const straight = (target, baseAmount) => ({ type: 'straight', target, baseAmount });

// A Progression Bet on the first dozen, at level 1, with a short record.
function progression(over = {}) {
  return {
    id: 'prog-1', type: 'fibonacci', color: '#60a5fa', state: 'active', level: 1, pnl: 1, wins: 1, sequences: 0,
    createdAtSpin: 0, closedAtSpin: null,
    bets: [
      { spinIdx: 0, level: 0, outcome: 'win', profit: 2, cat: 'win' },
      { spinIdx: 1, level: 0, outcome: 'loss', profit: -1, cat: 'loss' },
    ],
    config: { type: 'fibonacci', unit: 1, roi: 15, betMode: 'progression', dozenTargets: [0], colTargets: [], evenTargets: [], stopLoss: 200, parkRules: PARK_RULES },
    ...over,
  };
}

// A Custom Bet with one straight spot, with a short record.
function custom(over = {}) {
  return {
    id: 'cus-1', type: 'custom', color: '#f59e0b', state: 'active', level: 0, pnl: 4, wins: 1, sequences: 0,
    createdAtSpin: 0, closedAtSpin: null,
    bets: [{ spinIdx: 2, level: 0, outcome: 'win', profit: 4, cat: 'win' }],
    config: { type: 'custom', unit: 1, roi: 15, betMode: 'flat', stopLoss: 200, positions: [straight('17', 1), straight('5', 1)], parkRules: PARK_RULES },
    ...over,
  };
}

// The Solution chases 17 and also holds 33. 17 has missed once before, so it sits at level 2 and 33 at level 0.
function solution(over = {}) {
  return {
    id: 'sol-1', type: 'solution', color: '#fbbf24', state: 'active', level: 0, pnl: -1, wins: 0, sequences: 0,
    createdAtSpin: 0, closedAtSpin: null,
    bets: [{ spinIdx: 1, level: 0, outcome: 'loss', profit: -1, cat: 'loss' }],
    config: {
      type: 'solution', unit: 1, roi: 10, entryThreshold: 120, stopLoss: 200, parkRules: PARK_RULES,
      activeBets: [{ number: '17', level: 2, invest: 4 }, { number: '33', level: 0, invest: 0 }], chaseNumber: '17',
    },
    ...over,
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
  let confirmAnswer = null; // the answer every in-app confirm gets (answerConfirm), as the old window.confirm stub answered every call; null leaves it open
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
  initial.currentSession.id = 'edit-session';
  // The bundle's own loadApp, kept so reload() can run the real load migrations (session.js) on what the app holds.
  const realLoadApp = ctx.loadApp;
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
      // The in-app confirm: the dialog a press opened is answered as the test set it, as its confirm button would.
      const asked = confirmAnswer !== null && collect(tree, (n) => n.type && n.type.name === 'ConfirmDialog')[0];
      if (asked) asked.props.onAnswer(confirmAnswer);
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
  function cardOf(id) {
    const card = collect(trackerTree(), (n) => n.type === 'div' && n.key === id)[0];
    assert.ok(card, `track ${id} has a card`);
    return card;
  }
  function live() {
    const button = collect(tree, (n) => n.type === 'button' && String(n.props.children).includes('Live'))[0];
    assert.ok(button, 'the Live mode button is showing');
    button.props.onClick();
  }
  // Presses the card's Edit button and returns the Edit Config panel it opens.
  async function openEdit(id) {
    const edit = collect(cardOf(id), (n) => n.type === 'button' && /Edit$/.test(String(n.props.children)))[0];
    assert.ok(edit, `track ${id} has an Edit button`);
    edit.props.onClick({ stopPropagation() {} });
    await flush();
    const panel = collect(cardOf(id), (n) => n.type && n.type.name === 'EditTrackCfg')[0];
    assert.ok(panel, 'the Edit Config panel is open');
    return panel;
  }
  // The panel's Save: its onSave, with the config the panel holds.
  async function save(panel, cfg) {
    panel.props.onSave(cfg);
    await flush();
  }
  // The card's Park button, pressed: the toggle the Tracker page runs (parkToggle), not an edit.
  async function parkButton(id) {
    const park = collect(cardOf(id), (n) => n.type === 'button' && /Park$/.test(String(n.props.children)))[0];
    assert.ok(park, `track ${id} has a Park button`);
    park.props.onClick({ stopPropagation() {} });
    await flush();
  }
  // A long-press on a recent number opens the picker through SpinCorrectionContext. This presses it for one spin and
  // returns the number picker the Tracker page then draws, with the blockedReason the player is shown.
  async function openPicker(index) {
    const opener = collect(trackerTree(), (n) => n.type && n.type._context)[0];
    assert.ok(opener, 'the recent-numbers strip is showing');
    opener.props.value(index);
    await flush();
    const picker = collect(trackerTree(), (n) => n.type && n.type.name === 'SpinNumberPicker')[0];
    assert.ok(picker, `the number picker is open for spin ${index}`);
    return picker;
  }
  // A tap on the Progression grid: tapNumber, which keeps the snapshot that Undo last spin reverts to.
  async function tapGrid(value) {
    const grid = collect(trackerTree(), (n) => n.type && n.type.name === 'FibGrid')[0];
    assert.ok(grid, 'the Progression grid is showing');
    grid.props.onNumber(value);
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
    answerConfirm: (value) => { confirmAnswer = value; },
    ctx, flush, live, openEdit, save, parkButton, openPicker, state, tapGrid, undoButton, undoNote, undo,
    // A press of a root-page control (the header's Buy In, Cash Out and Bank buttons), found by a predicate on its node.
    async press(match) {
      const button = collect(tree, (n) => n.type === 'button' && match(n))[0];
      assert.ok(button, 'the control is showing');
      button.props.onClick();
      await flush();
    },
    // The component a root-page modal draws while it is open (BuyInModal, CashOutModal, BankrollEdit), or null.
    modal(name) { return collect(tree, (n) => n.type && n.type.name === name)[0] || null; },
    // The long-press ghost spin the Progression grid makes: FibGrid's onGhost, which ghostSpin handles.
    async ghost(value) {
      const grid = collect(trackerTree(), (n) => n.type && n.type.name === 'FibGrid')[0];
      assert.ok(grid, 'the Progression grid is showing');
      grid.props.onGhost(value);
      await flush();
    },
    // Saves what the app holds, then loads it again through the real loadApp, so the load migrations run on it as on a reload.
    async reload() {
      ctx.localStorage.setItem(vm.runInContext('STORAGE_KEY', ctx), JSON.stringify(state()));
      hooks[0].value = { ...hooks[0].value, appState: plain(realLoadApp()) };
      dirty = true;
      await flush();
    },
    // Clear numbers, as the spin tools' confirm does.
    async clear() {
      const tools = collect(trackerTree(), (n) => n.type && n.type.name === 'SpinTools')[0];
      assert.ok(tools, 'the spin tools are showing');
      tools.props.onConfirm();
      await flush();
    },
    // Copied into this realm: the App's state is made inside the sandbox, and deepStrictEqual compares prototypes.
    tracks: () => plain(state().currentSession.tracks),
    restoreSession(over) {
      hooks[0].value = { ...hooks[0].value, appState: { ...hooks[0].value.appState,
        currentSession: { ...hooks[0].value.appState.currentSession, ...over } } };
      dirty = true;
    },
  };
}

// A Progression Bet with no record yet, so the spins a test settles are its whole record and a replay reproduces it.
function freshProgression(over = {}) {
  return progression({ bets: [], level: 0, pnl: 0, wins: 0, ...over });
}

// The refusal the number picker shows for a spin played before the last edit (EDIT_BOUNDARY_REASON in spin-apply.js).
const EDIT_REASON = 'This spin was played before you edited a track. Corrections can only change spins after the last edit.';
// The refusal for a spin played before a Park button press, and the Undo refusal the Tracker page draws (spin-apply.js).
const PARK_REASON = 'This spin was played before a track was parked. Corrections can only change spins after the last park.';
const UNDO_REASON = 'Undo is off: a track was edited or parked after the spin it would reverse, and Undo would drop that change.';
// The Undo refusals for money moved after the spin, and for a spin recorded after it (UNDO_MONEY_REASON, UNDO_SPIN_REASON in spin-apply.js).
const MONEY_REASON = 'Undo is off after a buy-in, cash-out or bankroll change. Fix the number instead.';
const SPIN_REASON = 'Undo is off after a ghost spin or an untracked spin. Fix the number instead.';

// Settles spins on the app's current session the way a tap does, and writes the result back as that session.
async function settle(app, values) {
  let sess = app.state().currentSession;
  for (const v of values) sess = app.ctx.applySpin(sess, v, true).sess;
  app.restoreSession(plain(sess));
  await app.flush();
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

test('a base-only Progression edit parks the track: its record stays as it was, and the new track starts fresh at the new base', async () => {
  const app = await mountLive([progression()]);
  const before = plain(app.tracks()[0]);
  const panel = await app.openEdit('prog-1');
  await app.save(panel, { ...plain(panel.props.track.config), unit: 2 });

  assert.equal(app.tracks().length, 2, 'the edit adds one track');
  const [parked, fresh] = app.tracks();
  assert.deepEqual(parked, { ...before, state: 'parked', parkedAtSpin: SPINS.length }, 'the parked track keeps its whole record and config, and the park point of the edit');
  assert.notEqual(fresh.id, parked.id, 'the new track is a new track');
  assert.equal(fresh.state, 'active');
  assert.equal(fresh.config.unit, 2, 'the new track has the new base');
  assert.equal(fresh.config.roi, 15, 'the other settings carry over');
  assert.deepEqual(fresh.config.dozenTargets, [0]);
  assert.equal(fresh.level, 0);
  assert.equal(fresh.pnl, 0, 'the P&L starts fresh');
  assert.deepEqual(fresh.bets, [], 'the spin record starts fresh');
  assert.equal(fresh.wins, 0);
  assert.equal(fresh.sequences, 0);
  assert.equal(fresh.createdAtSpin, SPINS.length, 'it starts at the spin count of the edit');

  // The next spin settles only the new track, at the new base: a miss at level 0 pays one chip at $2.00.
  const { sess, totalDelta } = app.ctx.applySpin(app.state().currentSession, '0', true);
  assert.equal(Math.round(totalDelta * 100), -200, 'the miss is priced at the new base');
  assert.equal(sess.tracks[1].pnl, -1, 'the new track pays one chip');
  assert.equal(sess.tracks[0].pnl, parked.pnl, 'the parked track does not settle the spin');
});

test('a Custom Bet base-only edit parks the track the same way: the parked record is unchanged and the spots carry over', async () => {
  const app = await mountLive([custom()]);
  const before = plain(app.tracks()[0]);
  const panel = await app.openEdit('cus-1');
  await app.save(panel, { ...plain(panel.props.track.config), unit: 0.5 });

  const [parked, fresh] = app.tracks();
  assert.deepEqual(parked, { ...before, state: 'parked', parkedAtSpin: SPINS.length }, 'the parked track keeps its whole record and config, and the park point of the edit');
  assert.equal(fresh.state, 'active');
  assert.equal(fresh.config.unit, 0.5);
  assert.deepEqual(fresh.config.positions, before.config.positions, 'the spots carry over');
  assert.equal(fresh.pnl, 0);
  assert.deepEqual(fresh.bets, []);
  assert.equal(fresh.level, 0);
});

test('an edit that changes a field other than the base parks the track the same way', async () => {
  const app = await mountLive([progression()]);
  const before = plain(app.tracks()[0]);
  const panel = await app.openEdit('prog-1');
  await app.save(panel, { ...plain(panel.props.track.config), roi: 20 });

  const [parked, fresh] = app.tracks();
  assert.deepEqual(parked, { ...before, state: 'parked', parkedAtSpin: SPINS.length });
  assert.equal(fresh.config.roi, 20);
  assert.equal(fresh.config.unit, 1, 'the base is unchanged');
  assert.equal(fresh.pnl, 0);
  assert.deepEqual(fresh.bets, []);
});

test('a Solution edit parks the track, carries its held bets and chase to the new track with their levels, and starts a fresh P&L', async () => {
  const app = await mountLive([solution()]);
  const before = plain(app.tracks()[0]);
  const panel = await app.openEdit('sol-1');
  await app.save(panel, { ...plain(panel.props.track.config), unit: 0.5, entryThreshold: 90 });

  assert.equal(app.tracks().length, 2);
  const [parked, fresh] = app.tracks();
  assert.equal(parked.state, 'parked');
  assert.deepEqual(parked.bets, before.bets, 'the parked track keeps its history');
  assert.equal(parked.pnl, before.pnl, 'and its P&L');
  assert.equal(parked.config.unit, 1, 'and its settings');
  assert.deepEqual(parked.config.activeBets, [], 'it holds no bets after the edit, so resuming it cannot put them on the board twice');
  assert.equal(parked.config.chaseNumber, null);
  assert.equal(app.ctx.solutionChase(parked, SPINS).state, 'none', 'the parked track is not chasing');

  assert.notEqual(fresh.id, parked.id);
  assert.equal(fresh.state, 'active');
  assert.equal(fresh.config.unit, 0.5, 'the new track has the saved base');
  assert.equal(fresh.config.entryThreshold, 90, 'and the saved threshold');
  assert.deepEqual(fresh.config.activeBets, before.config.activeBets, 'the held bets come across with their levels and invest');
  assert.equal(fresh.config.chaseNumber, '17', 'the chase comes across');
  assert.equal(app.ctx.solutionChase(fresh, SPINS).number, '17', 'the new track is chasing 17');
  assert.equal(fresh.pnl, 0, 'the P&L starts fresh');
  assert.deepEqual(fresh.bets, []);
  assert.equal(fresh.wins, 0);
  assert.equal(fresh.sequences, 0);
  assert.equal(fresh.level, 0);
  assert.equal(fresh.createdAtSpin, SPINS.length);
});

test('the chase continues on the new track: the next spin settles the carried bets at their levels, and the parked track settles nothing', async () => {
  const app = await mountLive([solution()]);
  const panel = await app.openEdit('sol-1');
  await app.save(panel, { ...plain(panel.props.track.config), unit: 0.5, entryThreshold: 90 });
  const [parked, fresh] = app.tracks();
  const table = app.ctx.computeTableForTrack(fresh);

  // '1' is not held, so both held bets miss: 17 pays its level-2 stake and moves to level 3, 33 pays level 0 and moves to level 1.
  const { sess, totalDelta } = app.ctx.applySpin(app.state().currentSession, '1', true);
  const after = plain(sess).tracks;
  assert.deepEqual(after[1].config.activeBets.map((b) => [b.number, b.level]), [['17', 3], ['33', 1]], 'both bets advance a level');
  const cost = table[2].c + table[0].c;
  assert.equal(after[1].pnl, -cost, 'the new track pays both misses at the levels they were on');
  assert.equal(Math.round(totalDelta * 100), -Math.round(cost * 0.5 * 100), 'the misses are priced at the new base of 0.50');
  assert.deepEqual(after[0], parked, 'the parked track does not settle the spin');
});

test('a save that changes nothing does nothing, on every track type', async () => {
  const app = await mountLive([progression(), custom(), solution()]);
  const before = plain(app.tracks());
  for (const id of ['prog-1', 'cus-1', 'sol-1']) {
    const panel = await app.openEdit(id);
    await app.save(panel, plain(panel.props.track.config));
    assert.deepEqual(app.tracks(), before, `${id}: a save with no change leaves every track as it was`);
  }
});

test('a Solution panel left open while a held bet is tapped is not a change: the save adds no track and keeps the live bets', async () => {
  const app = await mountLive([solution()]);
  const panel = await app.openEdit('sol-1');
  const copy = plain(panel.props.track.config); // what the panel holds, taken before the tap
  // A number is tapped while the panel is open: 5 joins the held bets on the live track.
  const live = plain(app.tracks()[0]);
  live.config.activeBets.push({ number: '5', level: 0, invest: 0 });
  app.restoreSession({ tracks: [live] });
  await app.flush();
  const beforeSave = plain(app.tracks());

  await app.save(panel, copy);
  assert.deepEqual(app.tracks(), beforeSave, 'the save changes nothing');
  assert.equal(app.tracks().length, 1, 'no new track is added');
  assert.deepEqual(app.tracks()[0].config.activeBets.map((b) => b.number), ['17', '33', '5'], 'the tapped bet is kept');
});

test('after a base-only Progression edit, a spin from the edit onward can still be corrected, and the session still reproduces its record', async () => {
  const app = await mountLive([progression()]);
  const panel = await app.openEdit('prog-1');
  await app.save(panel, { ...plain(panel.props.track.config), unit: 2 });
  // Two spins after the edit, settled the way a tap settles them.
  let sess = app.state().currentSession;
  for (const v of ['7', '8']) sess = app.ctx.applySpin(sess, v, true).sess;
  assert.equal(app.ctx.spinCorrectionBlock(sess), null, 'the record reproduces from its own spins');
  const result = app.ctx.correctSpin(sess, 5, '9', Date.now());
  assert.equal(result.ok, true, 'the spin after the edit can be corrected');
  assert.equal(result.changed, true);
});

// KNOWN LIMITATION, CHANGELOG Open. spin-apply.js replays a Solution track from its starting bets at level 0, so a track that
// starts with a bet above level 0 (which an edit can now hand over) does not reproduce its record. Such a session refuses a
// spin correction with its reason, and nothing changes. The level-0 arm is the same correction, accepted, so the two arms
// differ only in the level the bet starts at.
test('KNOWN LIMITATION: a Solution track that starts with a bet above level 0 refuses spin correction and changes nothing; at level 0 the same correction is accepted', async () => {
  const { ctx } = await mountApp();
  const session = (level) => {
    let s = plain(ctx.newSession('american', 500));
    for (const v of ['1', '2', '3', '4']) s = plain(ctx.applySpin(s, v, false).sess);
    const t = ctx.newTrack('solution', 0, { ...ctx.defaultSolCfg(), activeBets: [{ number: '17', level, invest: 0 }], chaseNumber: '17' }, '#fbbf24');
    t.createdAtSpin = s.spins.length;
    s.tracks.push(t);
    for (const v of ['5', '6']) s = plain(ctx.applySpin(s, v, true).sess);
    return s;
  };
  assert.equal(ctx.correctSpin(session(0), 5, '7', 1).ok, true, 'at level 0 the correction is accepted');

  const carried = session(2);
  const refused = ctx.correctSpin(carried, 5, '7', 1);
  assert.equal(refused.ok, false, 'at level 2 the replay starts the bet at level 0, so the record does not reproduce and the correction is refused');
  assert.match(refused.reason, /can't be corrected/);
  assert.deepEqual(carried.spins, ['1', '2', '3', '4', '5', '6'], 'the session is unchanged');
});

test('class search: the in-place helpers are gone from every source file, and the Solution save is the only caller of editedTrackConfig', async () => {
  const files = (await readdir(SRC, { recursive: true })).map((f) => f.replace(/\\/g, '/')).filter((f) => /\.(js|jsx|mjs)$/.test(f));
  const problems = [];
  const callers = [];
  for (const f of files) {
    const src = await readFile(new URL(f, SRC), 'utf8');
    if (/canEditInPlace|rebaseTrackPnl|rebaseChips|\binPlace\b/.test(src)) problems.push(`${f} still names an in-place helper`);
    if (/\beditedTrackConfig\s*\(/.test(src) && !/function editedTrackConfig\s*\(/.test(src)) callers.push(f);
  }
  assert.deepEqual(problems, []);
  assert.deepEqual(callers, ['App.jsx'], 'editedTrackConfig is called from updateTrackConfig only');
});

// CORRECTION-PAST-PARK: a spin played before an edit parked a track cannot be corrected. The parked track keeps its record as
// it was, so a correction could not reach its P&L or the bankroll. The picker shows the refusal, and correctSpin applies it.
test('a base-only edit: a spin from before it is refused in the picker with the edit reason, and choosing a number changes nothing; a spin from the edit onward still corrects', async () => {
  const app = await mountLive([progression()]);
  const panel = await app.openEdit('prog-1');
  await app.save(panel, { ...plain(panel.props.track.config), unit: 2 });
  const [parked, fresh] = app.tracks();
  assert.equal(fresh.startedByEdit, true, 'the new track is marked as started by an edit, at the spin count of the edit');
  assert.equal(fresh.createdAtSpin, SPINS.length);
  assert.equal(parked.startedByEdit, undefined, 'the parked track carries no edit mark');
  await settle(app, ['7', '8']);

  const before = plain(app.state().currentSession);
  const refused = await app.openPicker(1);
  assert.equal(refused.props.blockedReason, EDIT_REASON, 'the picker shows the edit reason');
  refused.props.onChoose('9');
  await app.flush();
  assert.deepEqual(plain(app.state().currentSession), before, 'the refused correction changes no record, the bankroll included');
  assert.deepEqual(app.tracks()[0], parked, 'the parked track is as it was');

  const allowed = await app.openPicker(4);
  assert.equal(allowed.props.blockedReason, null, 'the first spin from the edit is not refused');
  assert.equal(app.ctx.correctSpin(app.state().currentSession, 4, '9', 1).ok, true);
  assert.equal(app.ctx.correctSpin(app.state().currentSession, 5, '9', 1).ok, true);
});

test('the boundary is exact for a base edit and an ROI edit alike: the last spin before the edit is refused, the first spin after it is not', async () => {
  for (const change of [{ unit: 2 }, { roi: 20 }]) {
    const app = await mountLive([progression()]);
    const panel = await app.openEdit('prog-1');
    await app.save(panel, { ...plain(panel.props.track.config), ...change });
    await settle(app, ['7', '8']);
    const sess = app.state().currentSession;
    const field = Object.keys(change)[0];
    assert.equal(app.ctx.spinCorrectionBlockAt(sess, SPINS.length - 1), EDIT_REASON, `${field}: the last spin before the edit is refused`);
    assert.equal(app.ctx.spinCorrectionBlockAt(sess, SPINS.length), null, `${field}: the first spin after the edit is not`);
    const refused = app.ctx.correctSpin(sess, SPINS.length - 1, '9', 1);
    assert.equal(refused.ok, false, `${field}: the correction is refused`);
    assert.equal(refused.reason, EDIT_REASON);
    assert.deepEqual(plain(app.state().currentSession), plain(sess), `${field}: nothing changes`);
    assert.equal(app.ctx.correctSpin(sess, SPINS.length, '9', 1).ok, true, `${field}: the spin after the edit corrects`);
  }
});

test('a session with no edit corrects as before: no spin is refused for an edit', async () => {
  const app = await mountLive([freshProgression()], []);
  await settle(app, SPINS);
  const sess = app.state().currentSession;
  assert.equal(app.ctx.spinCorrectionBlockAt(sess, 0), null);
  assert.equal(app.ctx.correctSpin(sess, 0, '9', 1).ok, true, 'the first spin corrects');
  const picker = await app.openPicker(0);
  assert.equal(picker.props.blockedReason, null, 'the picker offers every number');
});

test('a Park from the Park button is not an edit: it carries no edit mark and the edit refusal does not apply', async () => {
  const app = await mountLive([freshProgression()], []);
  await settle(app, SPINS);
  await app.parkButton('prog-1');
  assert.equal(app.tracks()[0].state, 'parked');
  assert.equal(app.tracks()[0].startedByEdit, undefined);
  const picker = await app.openPicker(1);
  assert.notEqual(picker.props.blockedReason, EDIT_REASON, 'a Park is not an edit, so the edit refusal does not apply');
});

test('Clear numbers removes the edit boundary with the spins: a spin played after the clear is not refused for the edit', async () => {
  const app = await mountLive([progression()]);
  const panel = await app.openEdit('prog-1');
  await app.save(panel, { ...plain(panel.props.track.config), unit: 2 });
  await settle(app, ['7', '8']);
  assert.equal(app.ctx.spinCorrectionBlockAt(app.state().currentSession, 0), EDIT_REASON, 'before the clear the first spin is refused');
  const cleared = app.ctx.clearSpins(app.state().currentSession, 1);
  assert.notEqual(app.ctx.spinCorrectionBlockAt(cleared, 0), EDIT_REASON, 'the clear took the edit boundary with the spins');
  let sess = cleared;
  for (const v of ['7', '8']) sess = app.ctx.applySpin(sess, v, true).sess;
  assert.notEqual(app.ctx.spinCorrectionBlockAt(sess, 0), EDIT_REASON, 'a spin played after the clear is not refused for the edit');
  assert.notEqual(app.ctx.spinCorrectionBlockAt(sess, 1), EDIT_REASON);
});

test('the boundary is the most recent edit: after two edits, spins before the later one are refused', async () => {
  const app = await mountLive([progression()]);
  let panel = await app.openEdit('prog-1');
  await app.save(panel, { ...plain(panel.props.track.config), unit: 2 });
  const second = app.tracks()[1].id;
  await settle(app, ['7', '8']);
  panel = await app.openEdit(second);
  await app.save(panel, { ...plain(panel.props.track.config), unit: 3 });
  await settle(app, ['9']);
  const sess = app.state().currentSession;
  assert.equal(app.ctx.spinCorrectionBlockAt(sess, 4), EDIT_REASON, 'a spin before the first edit is refused');
  assert.equal(app.ctx.spinCorrectionBlockAt(sess, 5), EDIT_REASON, 'a spin after the first edit but before the second is refused');
  assert.equal(app.ctx.spinCorrectionBlockAt(sess, 6), null, 'the spin from the second edit onward is not');
});

test('a Solution edit that carries a bet above level 0 still refuses a correction: before the edit with the edit reason, after it with the session reason', async () => {
  const app = await mountLive([solution()]);
  const panel = await app.openEdit('sol-1');
  await app.save(panel, { ...plain(panel.props.track.config), unit: 0.5 });
  await settle(app, ['1', '2']);
  const sess = app.state().currentSession;
  const before = app.ctx.correctSpin(sess, 1, '9', 1);
  assert.equal(before.ok, false);
  assert.equal(before.reason, EDIT_REASON);
  const after = app.ctx.correctSpin(sess, 5, '9', 1);
  assert.equal(after.ok, false, 'the carried bet at level 2 does not replay from level 0');
  assert.match(after.reason, /can't be corrected/);
});

// UNDO-AND-PARK: a Park button press is a correction boundary like an edit, and Undo last spin never silently removes a
// track edit or park made after the spin it reverses.
test('a Park from the Park button refuses a correction to a spin played before it, with the park reason, and changes nothing', async () => {
  const app = await mountLive([freshProgression()], []);
  await settle(app, SPINS);
  await app.parkButton('prog-1');
  await settle(app, ['7', '8']);
  const sess = app.state().currentSession;
  assert.equal(app.ctx.spinCorrectionBlockAt(sess, 0), PARK_REASON, 'the first spin, played before the park, is refused');
  assert.equal(app.ctx.spinCorrectionBlockAt(sess, 3), PARK_REASON, 'the last spin before the park is refused');
  assert.equal(app.ctx.spinCorrectionBlockAt(sess, 4), null, 'the first spin after the park is not');
  // '1' was a hit on the parked track; '24' would turn that hit into a miss, a change its parked record could not follow.
  const refused = app.ctx.correctSpin(sess, 0, '24', 1);
  assert.equal(refused.ok, false, 'the correction is refused');
  assert.equal(refused.reason, PARK_REASON);
  assert.deepEqual(plain(app.state().currentSession), plain(sess), 'nothing changes, the bankroll included');
  const picker = await app.openPicker(0);
  assert.equal(picker.props.blockedReason, PARK_REASON, 'the number picker shows the same refusal');
  picker.props.onChoose('24');
  await app.flush();
  assert.deepEqual(plain(app.state().currentSession), plain(sess), 'choosing a number in the picker changes nothing');
  assert.equal(app.tracks()[0].state, 'parked');
  assert.equal(app.ctx.correctSpin(sess, 4, '9', 1).ok, true, 'a spin from the park onward still corrects');
});

test('a session with no park corrects as before: no spin is refused for a park, and the hit corrects', async () => {
  const app = await mountLive([freshProgression()], []);
  await settle(app, SPINS);
  const sess = app.state().currentSession;
  assert.equal(app.ctx.spinCorrectionBlockAt(sess, 0), null);
  assert.equal(app.ctx.correctSpin(sess, 0, '24', 1).ok, true, 'the same correction is accepted with no park');
  const picker = await app.openPicker(0);
  assert.equal(picker.props.blockedReason, null, 'the picker offers every number');
});

test('Clear numbers takes the park point with the spins, and Undo of Clear puts it back', async () => {
  const app = await mountLive([freshProgression()], []);
  await settle(app, SPINS);
  await app.parkButton('prog-1');
  const parked = app.state().currentSession;
  const cleared = app.ctx.clearSpins(parked, 1);
  assert.equal(cleared.tracks[0].parkedAtSpin, 0, 'the clear resets the park point with the spins');
  let sess = cleared;
  for (const v of ['7', '8']) sess = app.ctx.applySpin(sess, v, true).sess;
  assert.notEqual(app.ctx.spinCorrectionBlockAt(sess, 0), PARK_REASON, 'a spin played after the clear is not refused for the park');
  const restored = app.ctx.restoreSpinState(cleared, app.ctx.snapshotSpinState(parked), 2);
  assert.equal(restored.tracks[0].parkedAtSpin, 4, 'Undo of the clear puts the park point back');
  assert.equal(app.ctx.spinCorrectionBlockAt(restored, 0), PARK_REASON, 'and the spins before it are refused again');
});

test('Undo after a spin and then an edit is refused: the edit and the spin both stay', async () => {
  const app = await mountLive([freshProgression()], []);
  app.answerConfirm(true);
  await app.tapGrid('7');
  assert.equal(app.state().currentSession.spins.length, 1, 'the tap settled one spin');
  const panel = await app.openEdit('prog-1');
  await app.save(panel, { ...plain(panel.props.track.config), unit: 2 });
  assert.equal(app.tracks().length, 2, 'the edit added its new track');
  await app.undo();
  assert.equal(app.tracks().length, 2, 'Undo did not remove the edit');
  assert.equal(app.tracks()[1].startedByEdit, true, 'the new track is still the edit');
  assert.equal(app.state().currentSession.spins.length, 1, 'Undo is refused, so the spin stays too');
});

test('Undo after a spin and then a Park is refused: the park stays, and so does the spin', async () => {
  const app = await mountLive([freshProgression()], []);
  app.answerConfirm(true);
  await app.tapGrid('7');
  await app.parkButton('prog-1');
  assert.equal(app.tracks()[0].state, 'parked');
  await app.undo();
  assert.equal(app.tracks()[0].state, 'parked', 'Undo did not bring the parked track back');
  assert.equal(app.state().currentSession.spins.length, 1, 'Undo is refused, so the spin stays too');
});

test('a refused Undo is disabled and its reason is drawn in the reserved note slot, which is there in both states', async () => {
  const app = await mountLive([freshProgression()], []);
  await app.tapGrid('7');
  assert.equal(app.undoButton().props.disabled, false, 'Undo is available while nothing has changed since the spin');
  assert.equal(app.undoNote().props.children, null, 'no refusal is drawn');
  assert.equal(app.undoNote().props.style.visibility, 'hidden');
  await app.parkButton('prog-1');
  assert.equal(app.undoButton().props.disabled, true, 'Undo is disabled once a park is newer than the spin');
  assert.equal(app.undoNote().props.children, UNDO_REASON, 'the reason is drawn');
  assert.equal(app.undoNote().props.style.visibility, 'visible');
});

test('Undo still works when nothing changed since the spin, and a park made before the spin is kept by it', async () => {
  const app = await mountLive([freshProgression()], []);
  app.answerConfirm(true);
  await app.tapGrid('7');
  await app.undo();
  assert.equal(app.state().currentSession.spins.length, 0, 'Undo reverts the spin');
  assert.equal(app.tracks()[0].pnl, 0, 'and its P&L');

  const two = await mountLive([freshProgression(), freshProgression({ id: 'prog-2' })], []);
  two.answerConfirm(true);
  await two.parkButton('prog-1');
  await two.tapGrid('7');
  await two.undo();
  assert.equal(two.tracks()[0].state, 'parked', 'the park made before the spin is in the record Undo puts back');
  assert.equal(two.state().currentSession.spins.length, 0, 'and the spin is reverted');
});

test('the refusal reasons live in spin-apply.js only, and the Undo handler and picker read them from there', async () => {
  const app = await readFile(new URL('App.jsx', SRC), 'utf8');
  assert.doesNotMatch(app, /This spin was played before|Undo is off:/, 'App.jsx names no reason of its own');
  assert.match(app, /blockedReason=\{spinCorrectionBlockAt\(sess,spinCorrection\.index\)\}/, 'the picker reads spinCorrectionBlockAt');
  assert.match(app, /const undoWhy = undoBlockReason\(sess, prevSessState, undoSpin\);/, 'the Undo refusal comes from undoBlockReason, with the tapped number');
  assert.match(app, /function undoLastSpin\(\) \{\s*if\(!prevSessState \|\| undoWhy\) return;/, 'the Undo handler refuses on that reason');
});

test('Undo of a spin keeps an edit made before that spin: the boundary is strictly after the spin, so only later changes refuse', async () => {
  const app = await mountLive([freshProgression()], []);
  app.answerConfirm(true);
  const panel = await app.openEdit('prog-1');
  await app.save(panel, { ...plain(panel.props.track.config), unit: 2 });
  assert.equal(app.tracks().length, 2, 'the edit is made before the spin');
  await app.tapGrid('7');
  assert.equal(app.state().currentSession.spins.length, 1, 'the spin is settled after the edit');
  await app.undo();
  assert.equal(app.state().currentSession.spins.length, 0, 'Undo reverts the spin');
  assert.equal(app.tracks().length, 2, 'and keeps the edit');
  assert.equal(app.tracks()[1].startedByEdit, true, 'the new track is still the edit');
});

// UNDO-MONEY: Undo last spin restores the session from before the spin, so money that moved after the spin would go with it,
// as would a spin recorded after the tracked one. Undo is refused for each, with its reason, and changes nothing.

// The header's Buy In, Cash Out and bankroll edit, entered through the modal or the edit sheet exactly as the player does.
async function buyIn(app, amount) {
  await app.press((n) => n.props.children === '💰 Buy In');
  const modal = app.modal('BuyInModal');
  modal.props.onBuyIn(amount);
  modal.props.onClose();
  await app.flush();
}
async function cashOut(app, amount) {
  await app.press((n) => n.props.children === '💸 Cash Out');
  const modal = app.modal('CashOutModal');
  modal.props.onCashOut(amount);
  modal.props.onClose();
  await app.flush();
}
async function setBankroll(app, value) {
  await app.press((n) => Array.isArray(n.props.children) && n.props.children[0] === 'Bank: ');
  app.modal('BankrollEdit').props.onSave(value);
  await app.flush();
}

test('Undo after a spin and then a buy-in is refused with the money reason: the buy-in and the spin both stay', async () => {
  const app = await mountLive([freshProgression()], []);
  app.answerConfirm(true);
  await app.tapGrid('7');
  await buyIn(app, 100);
  assert.equal(app.state().currentSession.buyIns.length, 1, 'the buy-in is recorded');
  const before = plain(app.state().currentSession);
  assert.equal(app.undoButton().props.disabled, true, 'Undo is disabled after the buy-in');
  assert.equal(app.undoNote().props.children, MONEY_REASON, 'the money reason is drawn');
  await app.undo();
  assert.deepEqual(plain(app.state().currentSession), before, 'Undo changes nothing: the spin and the buy-in both stay');
});

test('Undo after a spin and then a cash-out is refused the same way', async () => {
  const app = await mountLive([freshProgression()], []);
  app.answerConfirm(true);
  await app.tapGrid('7');
  await cashOut(app, 40);
  assert.equal(app.state().currentSession.cashOuts.length, 1, 'the cash-out is recorded');
  const before = plain(app.state().currentSession);
  assert.equal(app.undoButton().props.disabled, true, 'Undo is disabled after the cash-out');
  assert.equal(app.undoNote().props.children, MONEY_REASON, 'the money reason is drawn');
  await app.undo();
  assert.deepEqual(plain(app.state().currentSession), before, 'Undo changes nothing: the spin and the cash-out both stay');
});

test('Undo after a spin and then a bankroll edit is refused the same way', async () => {
  const app = await mountLive([freshProgression()], []);
  app.answerConfirm(true);
  await app.tapGrid('7');
  await setBankroll(app, 650);
  assert.equal(app.state().currentSession.bankrollCurrent, 650, 'the bankroll is edited');
  assert.equal(app.state().currentSession.bankrollEdits.length, 1, 'the edit is recorded on the session');
  const before = plain(app.state().currentSession);
  assert.equal(app.undoButton().props.disabled, true, 'Undo is disabled after the edit');
  assert.equal(app.undoNote().props.children, MONEY_REASON, 'the money reason is drawn');
  await app.undo();
  assert.deepEqual(plain(app.state().currentSession), before, 'Undo changes nothing: the spin and the edited bankroll both stay');
});

// The arm of the bankroll test: a save that leaves the bankroll as it was is not a money move, so it refuses nothing.
test('a bankroll save that leaves the bankroll as it was is not a money move: Undo stays available and nothing is recorded', async () => {
  const app = await mountLive([freshProgression()], []);
  app.answerConfirm(true);
  await app.tapGrid('7');
  const current = app.state().currentSession.bankrollCurrent;
  await setBankroll(app, current);
  assert.equal(app.state().currentSession.bankrollEdits, undefined, 'no edit is recorded for an unchanged bankroll');
  assert.equal(app.undoButton().props.disabled, false, 'Undo is available');
  assert.equal(app.undoNote().props.children, null, 'no refusal is drawn');
});

test('Undo after a spin and then a ghost spin is refused with the spin reason: the ghost spin and the spin both stay', async () => {
  const app = await mountLive([freshProgression()], []);
  app.answerConfirm(true);
  await app.tapGrid('7');
  await app.ghost('9');
  assert.equal(app.state().currentSession.spins.length, 2, 'the ghost spin is recorded after the tracked one');
  const before = plain(app.state().currentSession);
  assert.equal(app.undoButton().props.disabled, true, 'Undo is disabled after the ghost spin');
  assert.equal(app.undoNote().props.children, SPIN_REASON, 'the spin reason is drawn');
  await app.undo();
  assert.deepEqual(plain(app.state().currentSession), before, 'Undo changes nothing: the spin and the ghost spin both stay');
});

// The arms of the money tests: a buy-in or cash-out made before the spin is part of what Undo puts back, so it refuses nothing.
test('a buy-in or cash-out made before a spin does not block Undo of that spin, and both stay', async () => {
  const app = await mountLive([freshProgression()], []);
  app.answerConfirm(true);
  await buyIn(app, 100);
  await cashOut(app, 40);
  await app.tapGrid('7');
  assert.equal(app.undoButton().props.disabled, false, 'Undo is available: no money moved after the spin');
  assert.equal(app.undoNote().props.children, null, 'no refusal is drawn');
  await app.undo();
  assert.equal(app.state().currentSession.spins.length, 0, 'Undo reverts the spin');
  assert.equal(app.state().currentSession.buyIns.length, 1, 'the buy-in made before it stays');
  assert.equal(app.state().currentSession.cashOuts.length, 1, 'and so does the cash-out');
});

// Clear numbers keeps the money and its spin indices and resets the spin count. A buy-in made after the first spin carries
// spin index 1; with the count back at zero it must not refuse Undo of a spin played after the clear.
test('a buy-in made before Clear numbers does not block Undo of a spin played after the clear', async () => {
  const app = await mountLive([freshProgression()], []);
  app.answerConfirm(true);
  await app.tapGrid('7');
  await buyIn(app, 100);
  await app.clear();
  assert.equal(app.state().currentSession.spins.length, 0, 'Clear numbers removed the spin');
  assert.equal(app.state().currentSession.buyIns.length, 1, 'and kept the buy-in');
  await app.tapGrid('8');
  assert.equal(app.undoButton().props.disabled, false, 'Undo is available: nothing moved after the spin played after the clear');
  await app.undo();
  assert.equal(app.state().currentSession.spins.length, 0, 'Undo reverts that spin');
  assert.equal(app.state().currentSession.buyIns.length, 1, 'and keeps the buy-in');
});

test('undoBlockReason: nothing to undo gives no reason; a spin no track settled after the tracked spin, or a money change after it, is refused', async () => {
  const { ctx } = await mountApp();
  const before = plain(ctx.newSession('american', 500));
  assert.equal(ctx.undoBlockReason(before, null), null, 'with no snapshot there is nothing to undo');
  const tracked = plain(ctx.applySpin(before, '7', true).sess);
  assert.equal(ctx.undoBlockReason(tracked, before, '7'), null, 'the tracked spin alone can be undone');
  const untracked = plain(ctx.applySpin(tracked, '3', false).sess);
  assert.equal(ctx.undoBlockReason(untracked, before, '7'), SPIN_REASON, 'a spin no track settled, recorded after the tracked one, is refused');
  const converted = { ...tracked, bankroll: 450 };
  assert.equal(ctx.undoBlockReason(converted, before, '7'), MONEY_REASON, 'a change to the starting bankroll, as a currency conversion makes, is money');
});

// IMPORT-AND-MIGRATION PARK POINTS: every park carries the spin count it was made at. An import parks active tracks and stamps
// them; a load gives a parked track with no park point the session's spin count at load, once, and never moves one it has.
test('an import parks its active tracks, and each parked track gets its park point at the imported spin count; a park point it already has is kept', async () => {
  const ctx = await bundle(React);
  const imported = plain(ctx.newSession('american', 500));
  imported.spins = ['1', '2', '3', '4', '5', '6', '7'];
  imported.tracks = [progression({ id: 'active-1' }), custom({ id: 'active-2' }), custom({ id: 'parked-1', state: 'parked', parkedAtSpin: 2 })];
  const loaded = plain(ctx.parkImportedSession(plain(imported)));
  assert.deepEqual(loaded.tracks.map((t) => t.state), ['parked', 'parked', 'parked'], 'the active tracks are parked');
  assert.deepEqual(loaded.tracks.map((t) => t.parkedAtSpin), [7, 7, 2], 'the parked tracks get the imported spin count, and the existing park point is kept');
});

test('the load migration gives a parked track with no park point the spin count at load, fires once, and never moves a park point', async () => {
  const ctx = await bundle(React);
  const key = vm.runInContext('STORAGE_KEY', ctx);
  const sess = plain(ctx.newSession('american', 500));
  sess.spins = ['1', '2', '3', '4', '5', '6', '7'];
  sess.tracks = [
    progression({ id: 'old-park', state: 'parked' }),
    custom({ id: 'stamped-park', state: 'parked', parkedAtSpin: 2 }),
    progression({ id: 'live' }),
  ];
  const state = plain(ctx.freshAppState());
  state.currentSession = sess;
  ctx.localStorage.setItem(key, JSON.stringify(state));

  const first = plain(ctx.loadApp()).currentSession.tracks;
  assert.equal(first[0].parkedAtSpin, 7, 'the parked track with no park point gets the spin count at load');
  assert.equal(first[1].parkedAtSpin, 2, 'a park point already stamped is not moved');
  assert.equal('parkedAtSpin' in first[2], false, 'an active track gets no park point');

  // The app saves what it loaded. Two more spins, then a later load: the park points stay where they were stamped.
  const saved = plain(ctx.loadApp());
  saved.currentSession.spins = [...saved.currentSession.spins, '8', '9'];
  ctx.localStorage.setItem(key, JSON.stringify(saved));
  const later = plain(ctx.loadApp()).currentSession.tracks;
  assert.equal(later[0].parkedAtSpin, 7, 'on a later load the park point is still 7, not the 9 spins now recorded');
  assert.equal(later[1].parkedAtSpin, 2);
});

test('the load migration covers saved sessions too: a parked track there gets that session\'s own spin count', async () => {
  const ctx = await bundle(React);
  const key = vm.runInContext('STORAGE_KEY', ctx);
  const saved = plain(ctx.newSession('american', 500));
  saved.id = 'saved-1';
  saved.spins = ['1', '2', '3'];
  saved.tracks = [progression({ id: 'saved-park', state: 'parked' })];
  const state = plain(ctx.freshAppState());
  state.savedSessions = [saved];
  ctx.localStorage.setItem(key, JSON.stringify(state));
  const loaded = plain(ctx.loadApp());
  assert.equal(loaded.savedSessions[0].tracks[0].parkedAtSpin, 3, 'the saved session\'s parked track gets its own spin count');
});

// EDIT-PARK-STAMP: an Edit Config save parks the track at the spin count of the edit, as a Park button press does. A reload runs
// the load migration, which stamps only a parked track with no park point. The edit's park point is kept, so a spin played after
// the edit is corrected after the reload and a spin before the edit is still refused.
test('an edit stamps its park point and a reload keeps it: a spin after the edit corrects after the reload, and a spin before it is refused', async () => {
  const app = await mountLive([progression()]);
  const panel = await app.openEdit('prog-1');
  await app.save(panel, { ...plain(panel.props.track.config), unit: 2 });
  assert.equal(app.tracks().find((t) => t.id === 'prog-1').parkedAtSpin, SPINS.length, 'the edit parks the track at its spin count');
  await settle(app, ['7', '8']);
  await app.reload();
  assert.equal(app.tracks().find((t) => t.id === 'prog-1').parkedAtSpin, SPINS.length, 'the reload keeps the edit park point; the migration did not move it to the spin count at load');

  const sess = app.state().currentSession;
  assert.equal(app.ctx.spinCorrectionBlockAt(sess, SPINS.length), null, 'the first spin after the edit is not refused after the reload');
  const accepted = app.ctx.correctSpin(sess, SPINS.length, '9', 1);
  assert.equal(accepted.ok, true, 'a spin played after the edit is corrected after the reload');
  assert.equal(accepted.changed, true);
  assert.equal(app.ctx.spinCorrectionBlockAt(sess, SPINS.length - 1), EDIT_REASON, 'the last spin before the edit is still refused');
  const refused = app.ctx.correctSpin(sess, SPINS.length - 1, '9', 1);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, EDIT_REASON);
  assert.deepEqual(plain(app.state().currentSession), plain(sess), 'and the refused correction changes nothing');
});

// An unstamped parked track (an older save or an import) gets the spin count at load. That stamp is the conservative boundary
// the brief set: it is the largest park point in the session, so every spin before the load is refused, the spins after an
// edit included. This pins that rule, so a change to it is a visible change to this test.
test('a parked track with no stamp gets the spin count at load, and that stamp refuses corrections to every spin before the load', async () => {
  const app = await mountLive([progression(), freshProgression({ id: 'old-park', state: 'parked' })]);
  const panel = await app.openEdit('prog-1');
  await app.save(panel, { ...plain(panel.props.track.config), unit: 2 });
  await settle(app, ['7', '8']);
  await app.reload();
  assert.equal(app.tracks().find((t) => t.id === 'old-park').parkedAtSpin, SPINS.length + 2, 'the unstamped park takes the spin count at load');
  assert.equal(app.tracks().find((t) => t.id === 'prog-1').parkedAtSpin, SPINS.length, 'the edit park keeps its own point');
  const sess = app.state().currentSession;
  assert.equal(app.ctx.spinCorrectionBlockAt(sess, SPINS.length), PARK_REASON, 'a spin after the edit but before the load is refused for the park');
  assert.equal(app.ctx.spinCorrectionBlockAt(sess, SPINS.length + 1), PARK_REASON, 'the last spin before the load is refused too');
});
