import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';

// The catch-up card (F13 follow-on): one Read board photo control, shared with the Live spin tools, and one board-add
// path for both session kinds. The real source is transpiled in the order build.js concatenates it and run in a
// sandbox. The hooks are a small runner, as board-add-repeats.test.mjs uses: useBoardPhotoState and useBoardPhotoReturn
// run for real, and their effects run when flush() renders. Nothing is copied from source.

const SRC = new URL('../nexus-src/src/', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));
const count = (text, pattern) => (text.match(pattern) || []).length;
const SPINS = ['2', '2', '2', '24'];
const PHOTO_URL_AMERICAN = 'https://nexusfoundry.app/roulette/read-board?wheel=american';

let bundleCode = null;
async function compiledBundle() {
  if (bundleCode) return bundleCode;
  const build = await readFile(new URL('../nexus-src/build.js', import.meta.url), 'utf8');
  const files = [...build.match(/const FILES = \[([\s\S]*?)\];/)[1].matchAll(/^\s*'([^']+)'/gm)].map((m) => m[1]);
  const sources = await Promise.all(files.map((f) => readFile(new URL(f, SRC), 'utf8')));
  const combined = files.map((f, i) => `\n// ===== ${f} =====\n${sources[i]}`).join('\n').replace(/\r\n?/g, '\n');
  bundleCode = transformSync(combined, {
    babelrc: false,
    configFile: false,
    filename: 'app.jsx',
    presets: [
      [presetReact, { runtime: 'classic' }],
      [presetEnv, { targets: { ie: 11 }, modules: 'commonjs', useBuiltIns: false }],
    ],
  }).code;
  return bundleCode;
}

// A sandbox that runs the whole bundle with the given React. Browser and storage calls the card path never reaches are
// inert. The window is the sandbox itself, standalone (window.parent === window), so openBoardPhoto navigates in place.
async function sandbox(react, location = { hash: '', pathname: '/', search: '' }) {
  const store = {};
  const box = {
    console: { log() {}, warn() {}, error() {} },
    React: react,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    CustomEvent: class { constructor(type) { this.type = type; } },
    document: { addEventListener() {}, removeEventListener() {} },
    navigator: {},
    crypto: { randomUUID: (() => { let n = 0; return () => `id-${++n}`; })() },
    localStorage: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; },
    },
    require: (name) => {
      if (name === 'react') return react;
      throw new Error(`unexpected module in the bundle: ${name}`);
    },
    URLSearchParams,
  };
  box.module = { exports: {} };
  box.exports = box.module.exports;
  box.window = box;
  box.parent = box;
  box.location = location;
  box.history = { state: null, replaceState() {} };
  vm.createContext(box);
  vm.runInContext(await compiledBundle(), box, { filename: 'bundle.js' });
  return box;
}

// Hooks for the board path. State and refs live in slots; a setter applies at once; a callback is memoised on its deps,
// as React memoises it; an effect is queued by a render when its deps change, and run by flush(). Only the hooks the
// board path calls are here.
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, k) => Object.is(v, b[k]));
function boardRunner() {
  const slots = [];
  const queued = [];
  let cursor = 0;
  const react = { ...React,
    useState(initial) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = slots[i];
      if (!slot.set) slot.set = (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; };
      return [slot.value, slot.set];
    },
    useRef(initial) { const i = cursor++; if (!slots[i]) slots[i] = { current: initial }; return slots[i]; },
    useCallback(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, fn };
      return slots[i].fn;
    },
    useEffect(run, deps) {
      const i = cursor++;
      if (!same(slots[i] && slots[i].deps, deps)) { slots[i] = { deps }; queued.push(run); }
    },
  };
  return { react, queued, begin() { cursor = 0; } };
}

// Mounts the board path in one mode. flush() renders, runs the queued effects, and renders again until nothing is
// queued. The recorders keep what each one was given, in order.
async function mountBoard(appState, appMode, location) {
  const runner = boardRunner();
  const box = await sandbox(runner.react, location);
  const recorded = { live: [], game: [] };
  const setAppMode = () => {};
  const ui = {
    setPrevSessState() {}, setResult() {}, setLastSpinDelta() {}, setFlashNum() {},
    vibration: false,
    liveRecording: { record: (spin) => recorded.live.push(spin.segment) },
    gameRecording: { record: (spin) => recorded.game.push(spin.segment) },
  };
  function render() {
    runner.begin();
    const [app, , decision, commitBoardAdd] = box.useBoardPhotoState(() => plain(appState));
    const api = box.useBoardPhotoReturn(app.currentSession, appMode, setAppMode, 'ready', decision, commitBoardAdd, ui);
    return { app, decision, api };
  }
  return {
    box, recorded,
    flush() {
      for (let i = 0; i < 20; i += 1) {
        const out = render();
        const pending = runner.queued.splice(0);
        if (pending.length === 0) return out;
        pending.forEach((run) => run());
      }
      throw new Error('the board path did not settle');
    },
  };
}

// The fixtures come from the bundle's own factories: a Live session and a Game session, each with one fibonacci track on
// the first dozen (the track the spin-correction tests use).
async function fixtures() {
  const box = await sandbox(React);
  const session = (id, mode) => {
    const s = plain(box.newSession('american', 500));
    s.id = id;
    s.mode = mode;
    s.tracks = [plain(box.newTrack('fibonacci', 0, { ...plain(box.defaultFibCfg()), dozenTargets: [0], colTargets: [], stopLoss: 150 }))];
    return s;
  };
  return { box, live: session('live-1', 'live'), game: session('game-1', 'game') };
}

// The reference: the same spins settled one at a time through the shared settlement, as a tapped spin is settled.
function settle(box, session, spins) {
  return spins.reduce((s, val) => plain(box.applySpin(s, val, true).sess), plain(session));
}

// Hooks for the sheet's first render: each useState takes the value the test gives it, in the order SessionsPage declares
// them (view, target, filters, draft, bulk, note). Effects do not run. Every other hook is the real one.
function sheetHooks(initial) {
  let index = 0;
  return { ...React,
    useState(init) {
      const i = index++;
      const value = i < initial.length && initial[i] !== undefined ? initial[i] : init;
      return [value, () => {}];
    },
    useRef(init) { return { current: init }; },
    useEffect() {},
  };
}

// Every element of one type in a React element tree, walking children. Fragments and wrappers are followed.
function elementsOf(type, node, found = []) {
  if (Array.isArray(node)) { node.forEach((n) => elementsOf(type, n, found)); return found; }
  if (!node || typeof node !== 'object') return found;
  if (node.type === type) found.push(node);
  return elementsOf(type, node.props && node.props.children, found);
}

test('the card defines no photo control of its own; the spin tools and the card mount one shared component', async () => {
  const read = (p) => readFile(new URL(p, SRC), 'utf8');
  const sheet = await read('components/SessionsPage.jsx');
  const tools = await read('components/SpinTools.jsx');
  const app = await read('App.jsx');
  const boardReturn = await read('board-return.mjs');
  assert.doesNotMatch(sheet, /Read board photo|openBoardPhoto|onClick=\{readPhoto\}/, 'the sheet has no photo label, opener or handler');
  assert.match(sheet, /\{resumedLive && <ReadBoardPhotoButton onReadPhoto=\{readPhoto\} full\/>\}/);
  assert.equal(count(tools, /function ReadBoardPhotoButton\(/g), 1, 'one definition of the shared control');
  assert.match(tools, /<ReadBoardPhotoButton onReadPhoto=\{onReadPhoto\}/, 'the spin tools mount it');
  assert.match(app, /onReadPhoto=\{readBoardPhoto\}/, 'the spin tools get the one handler');
  assert.match(app, /readPhoto=\{readBoardPhoto\}/, 'the card gets the same handler');
  assert.doesNotMatch(app, /openBoardPhoto\(/, 'App builds no photo handler of its own');
  assert.equal(count(boardReturn, /const readBoardPhoto = \(\) => openBoardPhoto\(/g), 1, 'the hook builds the handler once');
  assert.ok(app.split('\n').length - 1 < 900, 'App.jsx stays under the 900-line test cap');
});

test('rendered: the Live card and the Live spin tools each mount the shared control with the handler given, and a Game card mounts none', async () => {
  const { live, game } = await fixtures();
  const handler = () => {};
  const props = (target) => ({
    saved: [target], sess: target, cur: { symbol: '$', dec: 2 }, initialResumeId: null,
    onResume() {}, onRename() {}, onAddNumbers() {}, readPhoto: handler, onClose() {},
  });
  // The card is open on its catch-up view for the target, with a bulk entry, so the photo control is on screen for a Live target.
  const openCard = async (target) => {
    const box = await sandbox(sheetHooks(['catchup', target, undefined, undefined, '2 2 2 24', undefined]));
    return { box, tree: box.SessionsPage(props(target)) };
  };
  const liveCard = await openCard(live);
  const cardButtons = elementsOf(liveCard.box.ReadBoardPhotoButton, liveCard.tree);
  assert.equal(cardButtons.length, 1, 'the Live card mounts the shared control once');
  assert.equal(cardButtons[0].props.onReadPhoto, handler, 'with the handler the card was given');

  const tools = liveCard.box.SpinTools({
    spinCount: 0, confirmOpen: false, undoVisible: false,
    onAsk() {}, onCancel() {}, onConfirm() {}, onUndo() {}, onReadPhoto: handler,
  });
  const toolButtons = elementsOf(liveCard.box.ReadBoardPhotoButton, tools);
  assert.equal(toolButtons.length, 1, 'the Live spin tools mount the same control once');
  assert.equal(toolButtons[0].props.onReadPhoto, handler, 'with the same handler');

  const gameCard = await openCard(game);
  assert.equal(elementsOf(gameCard.box.ReadBoardPhotoButton, gameCard.tree).length, 0, 'a Game card offers no photo control');
});

test('the one photo handler opens the reader for the session wheel, in this tab', async () => {
  const { live } = await fixtures();
  const location = { hash: '', pathname: '/', search: '', assigned: [], assign(url) { this.assigned.push(url); } };
  const app = await mountBoard({ currentSession: live, gameSession: null, savedSessions: [] }, 'live', location);
  app.flush().api.readBoardPhoto();
  assert.deepEqual(location.assigned, [PHOTO_URL_AMERICAN]);
});

test('a Game-mode catch-up of "2 2 2 24" enters four spins in order and settles the Game tracks', async () => {
  const { box, live, game } = await fixtures();
  const app = await mountBoard({ currentSession: live, gameSession: game, savedSessions: [] }, 'game');
  app.flush().api.setBoardAdd(SPINS, game);
  const done = app.flush();
  assert.equal(done.decision.accepted, true, 'the Game session accepts the add');
  assert.equal(done.decision.kind, 'game', 'the add names the Game session');
  assert.deepEqual(plain(done.app.gameSession.spins), SPINS, 'four spins, oldest first, repeats kept');
  const expected = settle(box, game, SPINS);
  assert.deepEqual(plain(done.app.gameSession.tracks), plain(expected.tracks), 'each spin settles the Game track, as a tapped spin does');
  assert.notDeepEqual(plain(done.app.gameSession.tracks), plain(game.tracks), 'the Game track has changed');
  assert.deepEqual(app.recorded.game, SPINS, 'each add is recorded to the Game recorder, in order');
  assert.deepEqual(app.recorded.live, [], 'nothing is recorded to the Live recorder');
  assert.deepEqual(plain(done.app.currentSession), plain(live), 'the Live session is untouched');
});

test('a Live catch-up is unchanged: the numbers enter the Live session and its recorder, and the Game session is untouched', async () => {
  const { box, live, game } = await fixtures();
  const app = await mountBoard({ currentSession: live, gameSession: game, savedSessions: [] }, 'live');
  app.flush().api.setBoardAdd(SPINS, live);
  const done = app.flush();
  assert.equal(done.decision.accepted, true, 'the Live session accepts the add');
  assert.equal(done.decision.kind, 'live');
  assert.deepEqual(plain(done.app.currentSession.spins), SPINS, 'four spins, oldest first, repeats kept');
  assert.deepEqual(plain(done.app.currentSession.tracks), plain(settle(box, live, SPINS).tracks), 'the Live track settles each spin, as before');
  assert.deepEqual(app.recorded.live, SPINS, 'each add is recorded to the Live recorder, in order');
  assert.deepEqual(app.recorded.game, [], 'nothing is recorded to the Game recorder');
  assert.deepEqual(plain(done.app.gameSession), plain(game), 'the Game session is untouched');
});

test('an add is refused unless it names the session held in its mode: nothing is entered or recorded', async () => {
  const { live, game } = await fixtures();
  // A Game target the state does not hold: its id is not the Game session's id.
  const held = await mountBoard({ currentSession: live, gameSession: game, savedSessions: [] }, 'game');
  held.flush().api.setBoardAdd(SPINS, { ...game, id: 'not-held' });
  const refused = held.flush();
  assert.notEqual(refused.decision && refused.decision.accepted, true, 'a session the state does not hold is refused');
  assert.deepEqual(plain(refused.app.gameSession), plain(game), 'the Game session is unchanged');
  assert.deepEqual(held.recorded.game, [], 'nothing is recorded');

  // A Game add while the app is in Live mode waits for its own mode: it is refused, and the Game session is unchanged.
  const wrongMode = await mountBoard({ currentSession: live, gameSession: game, savedSessions: [] }, 'live');
  wrongMode.flush().api.setBoardAdd(SPINS, game);
  const waiting = wrongMode.flush();
  assert.notEqual(waiting.decision && waiting.decision.accepted, true, 'a Game add is not written from Live mode');
  assert.deepEqual(plain(waiting.app.gameSession), plain(game), 'the Game session is unchanged');
  assert.deepEqual(wrongMode.recorded.game, [], 'nothing is recorded to the Game recorder');
});
