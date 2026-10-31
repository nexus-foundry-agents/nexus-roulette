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
    ctx, flush, live, openEdit, save, parkButton, openPicker, state, tapGrid, undoButton, undoNote, undo,
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
  assert.deepEqual(parked, { ...before, state: 'parked' }, 'the parked track keeps its whole record and config');
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
  assert.deepEqual(parked, { ...before, state: 'parked' }, 'the parked track keeps its whole record and config');
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
  assert.deepEqual(parked, { ...before, state: 'parked' });
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
  app.ctx.confirm = () => true;
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
  app.ctx.confirm = () => true;
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
  app.ctx.confirm = () => true;
  await app.tapGrid('7');
  await app.undo();
  assert.equal(app.state().currentSession.spins.length, 0, 'Undo reverts the spin');
  assert.equal(app.tracks()[0].pnl, 0, 'and its P&L');

  const two = await mountLive([freshProgression(), freshProgression({ id: 'prog-2' })], []);
  two.ctx.confirm = () => true;
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
  assert.match(app, /const undoWhy = undoBlockReason\(sess, prevSessState\);/, 'the Undo refusal comes from undoBlockReason');
  assert.match(app, /function undoLastSpin\(\) \{\s*if\(!prevSessState \|\| undoWhy\) return;/, 'the Undo handler refuses on that reason');
});

test('Undo of a spin keeps an edit made before that spin: the boundary is strictly after the spin, so only later changes refuse', async () => {
  const app = await mountLive([freshProgression()], []);
  app.ctx.confirm = () => true;
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
