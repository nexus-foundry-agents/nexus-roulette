import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';

// NO-NATIVE-DIALOGS: every confirmation in Roulette is the in-app ConfirmDialog, never a browser dialog. A native dialog looks
// the same as an injected one, so getting people used to it gets them used to the shape a phishing page uses (shared rule 27).
// The class check walks every source file: no window.confirm, window.alert or window.prompt, bare or through window, globalThis
// or self; no bare alert() or prompt(); and no bare confirm() whose argument is not an options object. The behaviour check runs the
// real App under the hook runner the other App tests copy (this file copies it too, rather than importing a test file): each kind
// of confirm site proceeds on confirm and does nothing on cancel.

const SRC = new URL('../nexus-src/src/', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));
const flushPromises = () => new Promise((resolve) => setImmediate(resolve));
const compiled = new Map();
const AMERICAN = ['0', '00', ...Array.from({ length: 36 }, (_, i) => String(i + 1))];
const SPINS = ['1', '24', '5', '16'];
const PARK_RULES = { droughtThreshold: null, waitForWin: false, parkAfterStopLoss: false, parkAfterLoss: false };
// A number outside the first dozen: the Progression Bet on the first dozen misses it, so its money moves.
const MISS = '30';

// No native dialog is left in source. The session import's three alert() calls report through the in-app dialog as a notice.
const PINNED = {};

// The code of a source file with its whole-line comments removed, so a comment that names a native dialog is not a call to one.
const code = (source) => source.split('\n').filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join('\n');
const NATIVE = [
  /\b(?:window|globalThis|self)\s*\.\s*(?:confirm|alert|prompt)\b/g,
  /(?<![\w.$])(?:alert|prompt)\s*\(/g,
  /(?<![\w.$])confirm\s*\((?!\s*\{)/g,
];
function nativeCalls(source) {
  const text = code(source);
  return NATIVE.reduce((hits, re) => hits + (text.match(re) || []).length, 0);
}

// Every source file under nexus-src/src, as paths relative to it.
async function sourceFiles(dir = '', out = []) {
  for (const entry of await readdir(new URL(dir, SRC), { withFileTypes: true })) {
    const rel = dir + entry.name;
    if (entry.isDirectory()) await sourceFiles(`${rel}/`, out);
    else if (/\.(jsx?|mjs)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

test('no native browser dialog is left anywhere in source', async () => {
  const found = {};
  for (const file of await sourceFiles()) {
    const hits = nativeCalls(await readFile(new URL(file, SRC), 'utf8'));
    if (hits) found[file] = hits;
  }
  assert.deepEqual(found, PINNED, 'a native browser dialog is in source');
});

test('the nine confirm sites await the one confirm, and only App calls useConfirm, the one place its dialog is drawn', async () => {
  const sites = {};
  for (const file of ['App.jsx', 'components/GamePage.jsx', 'components/SecondaryPages.jsx']) {
    sites[file] = (await readFile(new URL(file, SRC), 'utf8')).split('await confirm({').length - 1;
  }
  assert.deepEqual(sites, { 'App.jsx': 5, 'components/GamePage.jsx': 2, 'components/SecondaryPages.jsx': 2 });
  const callers = [];
  const drawers = [];
  for (const file of await sourceFiles()) {
    const source = await readFile(new URL(file, SRC), 'utf8');
    if (/= useConfirm\(\)/.test(code(source))) callers.push(file);
    if (/<ConfirmDialog\b/.test(code(source))) drawers.push(file);
  }
  assert.deepEqual(callers, ['App.jsx']);
  assert.deepEqual(drawers, ['components/ConfirmDialog.jsx']);
  const app = await readFile(new URL('App.jsx', SRC), 'utf8');
  assert.equal(app.split('{confirmDialog}').length - 1, 1, 'App draws the dialog once');
});

test('ConfirmDialog is the shared Modal with no overlay of its own, and build.js lists it after ui.jsx and before its callers', async () => {
  const dialog = await readFile(new URL('components/ConfirmDialog.jsx', SRC), 'utf8');
  assert.match(dialog, /<Modal onClose=\{/, 'the dialog is the shared Modal, so the backdrop rule is Modal\'s');
  assert.doesNotMatch(dialog, /position:\s*"fixed"/, 'the Modal draws the overlay; the dialog adds none');
  assert.equal(nativeCalls(dialog), 0, 'the dialog calls no native dialog');
  const build = await readFile(new URL('../nexus-src/build.js', import.meta.url), 'utf8');
  const at = (name) => build.indexOf(`'${name}'`);
  assert.ok(at('components/ConfirmDialog.jsx') > at('components/ui.jsx'), 'after ui.jsx, which holds Modal');
  for (const caller of ['App.jsx', 'components/GamePage.jsx', 'components/SecondaryPages.jsx']) {
    assert.ok(at('components/ConfirmDialog.jsx') < at(caller), `before ${caller}`);
  }
});

// Every element under node that passes the test, in tree order. Walks children arrays and props.children.
function collect(node, test, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((child) => collect(child, test, out)); return out; }
  if (test(node)) out.push(node);
  collect(node.props && node.props.children, test, out);
  return out;
}

// -- The App under the hook runner (copied from undo-other-gaps.test.mjs) --

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
    // A native dialog reached from the bundle is a failure: the app calls only its own confirm.
    confirm: () => { throw new Error('a native browser dialog was opened'); },
    alert: () => { throw new Error('a native browser dialog was opened'); },
    prompt: () => { throw new Error('a native browser dialog was opened'); },
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
  initial.currentSession.id = 'confirm-session';
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
  // Settles the App. A confirm dialog opened by a press stays open until the test answers it (answer()).
  async function flush() {
    for (let i = 0; i < 100; i++) {
      if (dirty) render();
      for (const effect of effects.splice(0)) effect();
      await flushPromises();
      if (!dirty && effects.length === 0) return;
    }
    assert.fail('App did not settle');
  }
  function trackerTree() {
    const tracker = collect(tree, (n) => n.type && n.type.name === 'TrackerPage')[0];
    assert.ok(tracker, 'the Tracker page is showing (Live mode)');
    return tracker.type(tracker.props);
  }
  // A page that holds hooks of its own is run on hook slots of its own, from base, so App's slots stay put.
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
  async function tab(label) {
    const button = collect(tree, (n) => n.type === 'button' && n.props.children === label)[0];
    assert.ok(button, `the ${label} tab is showing`);
    button.props.onClick();
    await flush();
  }
  async function tapGrid(value) {
    const grid = collect(trackerTree(), (n) => n.type && n.type.name === 'FibGrid')[0];
    assert.ok(grid, 'the Progression grid is showing');
    grid.props.onNumber(value);
    await flush();
  }
  // Presses a button that a page with hooks of its own draws (SpinPage's Clear History, StatsPage's Tear, SettingsPage's Restart).
  async function pressInPage(name, label, base) {
    const page = collect(tree, (n) => n.type && n.type.name === name)[0];
    assert.ok(page, `the ${name} page is showing`);
    const button = collect(pageTree(page.type, page.props, base), (n) => n.type === 'button' && n.props.children === label)[0];
    assert.ok(button, `${name} draws a "${label}" button`);
    button.props.onClick();
    await flush();
  }
  // The Abandon Progression button, the one whose label names the track's level (the Tracker page draws it under the cards).
  async function abandon() {
    const button = collect(trackerTree(), (n) => n.type === 'button' && String(n.props.children).includes('Lvl'))[0];
    assert.ok(button, 'an Abandon Progression button is showing');
    button.props.onClick();
    await flush();
  }
  // The track's × button (Close track). It stops the press from reaching the card, as the button does.
  async function closeTrack() {
    const button = collect(trackerTree(), (n) => n.type === 'button' && n.props.children === '×')[0];
    assert.ok(button, 'a Close track button is showing');
    button.props.onClick({ stopPropagation() {} });
    await flush();
  }
  // The Undo last spin button, pressed as a tap presses it: the handler itself must refuse.
  async function undo() {
    const button = collect(trackerTree(), (n) => n.type === 'button' && n.props.children === '↩ Undo')[0];
    assert.ok(button, 'the Undo button is drawn');
    button.props.onClick();
    await flush();
  }
  // The confirm dialog the App is drawing, or null. The App draws it at its foot, so it is found in the App's own tree.
  function dialog() {
    return collect(tree, (n) => n.type && n.type.name === 'ConfirmDialog')[0] || null;
  }
  // Answers the open dialog as its buttons would (true: the confirm button; false: Cancel), then settles the App.
  async function answer(ok) {
    const shown = dialog();
    assert.ok(shown, 'a confirm dialog is open');
    shown.props.onAnswer(ok);
    await flush();
  }
  const state = () => hooks[0].value.appState;
  return {
    ctx, flush, live, tab, tapGrid, pressInPage, abandon, closeTrack, undo, dialog, answer, state,
    trackerTree,
    // The hook alone, in a render of its own (a fresh runner, never rendered with App).
    renderHook() { cursor = 0; return ctx.useConfirm(); },
    restoreSession(over) {
      hooks[0].value = { ...hooks[0].value, appState: { ...hooks[0].value.appState,
        currentSession: { ...hooks[0].value.appState.currentSession, ...over } } };
      dirty = true;
    },
  };
}

// Mounts the real App in Live mode on a seeded session: its tracks and its spins.
async function mountLive(tracks, spins = SPINS) {
  const app = await mountApp();
  await app.flush();
  app.restoreSession({ tracks: plain(tracks), spins: [...spins], droughts: droughtsAfter(spins) });
  await app.flush();
  app.live();
  await app.flush();
  return app;
}

function droughtsAfter(spins) {
  const out = {};
  AMERICAN.forEach((n) => {
    const at = spins.lastIndexOf(n);
    out[n] = at < 0 ? spins.length : spins.length - 1 - at;
  });
  return out;
}

// A Progression Bet on the first dozen, at level 0, with no record.
function freshProgression() {
  return {
    id: 'prog-1', type: 'fibonacci', color: '#60a5fa', state: 'active', level: 0, pnl: 0, wins: 0, sequences: 0,
    createdAtSpin: 0, closedAtSpin: null, bets: [],
    config: { type: 'fibonacci', unit: 1, roi: 15, betMode: 'progression', dozenTargets: [0], colTargets: [], evenTargets: [], stopLoss: 200, parkRules: PARK_RULES },
  };
}

test('the dialog is the shared Modal: Cancel and the confirm button, a backdrop dismiss cancels, and the title is its name', async () => {
  const app = await mountApp();
  const answers = [];
  const el = app.ctx.ConfirmDialog({ title: 'Tear this session?', confirmLabel: 'Tear', danger: true, onAnswer: (ok) => answers.push(ok) });
  assert.equal(el.type.name, 'Modal');
  const shown = collect(el, (n) => n.type === 'div' && n.props.role === 'alertdialog')[0];
  assert.equal(shown.props['aria-label'], 'Tear this session?');
  const buttons = collect(el, (n) => n.type === 'button');
  assert.deepEqual(buttons.map((b) => b.props.children), ['Cancel', 'Tear']);
  buttons[0].props.onClick();
  buttons[1].props.onClick();
  el.props.onClose(); // the backdrop dismiss: Modal calls onClose only for a press that begins and ends on the backdrop
  assert.deepEqual(answers, [false, true, false]);
});

test('a second confirm while one is open refuses the first, and the dialog shown is the later one', async () => {
  const app = await mountApp();
  const [confirm] = app.renderHook();
  const first = confirm({ title: 'First?' });
  const second = confirm({ title: 'Second?' });
  assert.equal(await first, false, 'the earlier call is refused, not left open');
  const [, shown] = app.renderHook();
  assert.equal(shown.props.title, 'Second?', 'the dialog shown is the later call');
  shown.props.onAnswer(true);
  assert.equal(await second, true, 'the answer goes to the call the dialog was shown for');
  assert.equal(app.renderHook()[1], null, 'the dialog is gone once answered');
});

test('Tear: Cancel keeps the session, and the confirm button replaces it', async () => {
  const app = await mountLive([freshProgression()], SPINS);
  const id = app.state().currentSession.id;
  await app.tab('Stats');
  await app.pressInPage('StatsPage', 'Tear', 5000);
  assert.equal(app.dialog().props.title, 'Tear this session?');
  assert.equal(app.dialog().props.confirmLabel, 'Tear');
  await app.answer(false);
  assert.equal(app.dialog(), null, 'Cancel closes the dialog');
  assert.equal(app.state().currentSession.id, id, 'Cancel keeps the session');
  assert.equal(app.state().currentSession.spins.length, SPINS.length);
  await app.pressInPage('StatsPage', 'Tear', 5000);
  await app.answer(true);
  assert.notEqual(app.state().currentSession.id, id, 'the confirm button replaces the session');
  assert.equal(app.state().currentSession.spins.length, 0);
});

test('Close track: Cancel keeps the track open, and the confirm button closes it', async () => {
  const app = await mountLive([freshProgression()], []);
  await app.closeTrack();
  assert.equal(app.dialog().props.title, 'Close track?');
  await app.answer(false);
  assert.equal(app.state().currentSession.tracks[0].state, 'active', 'Cancel leaves the track active');
  await app.closeTrack();
  await app.answer(true);
  assert.equal(app.state().currentSession.tracks[0].state, 'closed', 'the confirm button closes the track');
});

test('Restart onboarding: Cancel keeps the setup, and the confirm button restarts it from the bankroll', async () => {
  const app = await mountLive([], []);
  await app.tab('Settings');
  await app.pressInPage('SettingsPage', 'Restart Onboarding', 7000);
  assert.equal(app.dialog().props.title, 'Restart onboarding?');
  assert.equal(app.dialog().props.body, 'Your current bankroll will be your new starting point.');
  await app.answer(false);
  assert.equal(app.state().settings.onboarded, true, 'Cancel keeps the setup');
  await app.pressInPage('SettingsPage', 'Restart Onboarding', 7000);
  await app.answer(true);
  assert.equal(app.state().settings.onboarded, false, 'the confirm button restarts the setup');
  assert.equal(app.state().settings._restartBankroll, app.state().currentSession.bankrollCurrent);
});

test('Clear History: Cancel keeps the spins, and the confirm button clears them', async () => {
  const app = await mountLive([], SPINS);
  await app.tab('Spin Log');
  await app.pressInPage('SpinPage', 'Clear History', 5000);
  assert.equal(app.dialog().props.title, 'Clear all spins from session history?');
  await app.answer(false);
  assert.equal(app.state().currentSession.spins.length, SPINS.length, 'Cancel keeps the spins');
  await app.pressInPage('SpinPage', 'Clear History', 5000);
  await app.answer(true);
  assert.equal(app.state().currentSession.spins.length, 0, 'the confirm button clears them');
});

test('Abandon progression: Cancel keeps the progression, and the confirm button records the abandon', async () => {
  const app = await mountLive([freshProgression()], []);
  await app.abandon();
  assert.equal(app.dialog().props.title, 'Abandon progression at level 0?');
  assert.equal(app.dialog().props.confirmLabel, 'Abandon');
  await app.answer(false);
  assert.equal(app.state().currentSession.tracks[0].bets.length, 0, 'Cancel records nothing');
  await app.abandon();
  await app.answer(true);
  const bets = app.state().currentSession.tracks[0].bets;
  assert.equal(bets[bets.length - 1].type, 'abandon', 'the confirm button records the abandon');
});

test('Undo last spin: Cancel leaves the spin, and the confirm button reverts it', async () => {
  const app = await mountLive([freshProgression()], []);
  await app.tapGrid(MISS);
  assert.equal(app.state().currentSession.spins.length, 1);
  await app.undo();
  assert.equal(app.dialog().props.title, 'Undo last tracked spin?');
  assert.equal(app.dialog().props.confirmLabel, 'Undo');
  await app.answer(false);
  assert.equal(app.state().currentSession.spins.length, 1, 'Cancel leaves the spin');
  await app.undo();
  await app.answer(true);
  assert.equal(app.state().currentSession.spins.length, 0, 'the confirm button reverts the spin');
});

test('Undo confirmed after the session changed while the dialog was open is refused, and the change stays', async () => {
  const app = await mountLive([freshProgression()], []);
  await app.tapGrid(MISS);
  await app.undo();
  assert.ok(app.dialog(), 'the Undo dialog is open');
  // A change that lands while the dialog waits on a person (a sync from another device, for example): a spin is added.
  app.restoreSession({ spins: [...app.state().currentSession.spins, '7'] });
  await app.flush();
  await app.answer(true);
  assert.deepEqual(app.state().currentSession.spins, [MISS, '7'], 'the Undo does not restore the snapshot over the change');
});

test('Undo confirmed after the account session took the slot while the dialog was open is refused, and the new session stays', async () => {
  const app = await mountLive([freshProgression()], []);
  await app.tapGrid(MISS);
  await app.undo();
  assert.ok(app.dialog(), 'the Undo dialog is open');
  // A sync takes the active session slot while the dialog waits on a person: a new session id, with none of the tapped spin.
  app.restoreSession({ id: 'taken-over', spins: [] });
  await app.answer(true);
  assert.equal(app.dialog(), null, 'the dialog closes once answered');
  assert.equal(app.state().currentSession.id, 'taken-over', 'the session that took the slot stays');
  assert.deepEqual(app.state().currentSession.spins, [], 'Undo did not put the replaced session back');
});
