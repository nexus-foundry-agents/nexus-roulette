import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';
import ReactDOMServer from 'react-dom/server';

// Repeated numbers in a board photo list are separate spins. The App bundle is loaded the way build.js concatenates
// it, and the real App runs: the return is read from the hash, reviewed, and added. Only browser timers, storage and
// the recording transport are replaced (the same harness shape board-photo.test.mjs uses).

const SRC = new URL('../nexus-src/src/', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));
const flushPromises = () => new Promise((resolve) => setImmediate(resolve));
const textOf = (html) => html.replace(/<[^>]+>/g, '');

// The reporter's board, most recent first (the return order), as on the photo page.
const HIS_BOARD = ['8', '31', '3', '20', '13', '27', '28', '2', '32', '23', '24', '19', '6', '20', '19', '0', '7', '19', '11', '1', '36', '8', '13', '10', '17', '22', '18', '4', '24', '2', '2', '2'];
const HIS_FRAGMENT = 'ok:' + HIS_BOARD.join(',');
const HIS_HASH = '#readboard=' + HIS_FRAGMENT;
// The same list oldest first: the order Add enters it, so the last entry is the most recent number on the board.
const HIS_SPINS = ['2', '2', '2', '24', '4', '18', '22', '17', '10', '13', '8', '36', '1', '11', '19', '7', '0', '19', '20', '6', '19', '24', '23', '32', '2', '28', '27', '13', '20', '3', '31', '8'];

const CASINO_ORIGIN = 'https://casino.nexus-foundry.ai';
const compiled = new Map();
async function bundle(react, { framed = false } = {}) {
  const build = await readFile(new URL('../nexus-src/build.js', import.meta.url), 'utf8');
  const files = [...build.match(/const FILES = \[([\s\S]*?)\];/)[1].matchAll(/^\s*\x27([^\x27]+)\x27/gm)].map((m) => m[1]);
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
  const listeners = new Set();
  const posted = [];
  const parent = { postMessage(data, origin) { posted.push({ data, origin }); } };
  let requests = 0;
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    React: react,
    setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval() {},
    addEventListener(name, listener) { if (name === 'message') listeners.add(listener); },
    removeEventListener(name, listener) { if (name === 'message') listeners.delete(listener); },
    crypto: { randomUUID: () => `request-${++requests}` },
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
  sandbox.window.parent = framed ? parent : sandbox;
  vm.createContext(sandbox);
  vm.runInContext(compiled.get(combined), sandbox, { filename: 'bundle.js' });
  // The shell's side of the Casino bridge: messages come from the pinned origin, from the frame's parent.
  const emit = (data, origin = CASINO_ORIGIN, source = parent) => { for (const l of listeners) l({ data, origin, source }); };
  sandbox.posted = posted;
  sandbox.hello = () => emit({ kind: 'nexus-casino:recording:hello', gameId: 'roulette' });
  sandbox.reply = (request, body, extra = {}) => emit({
    kind: 'nexus-casino:recording:response', id: request.data.id, op: request.data.op, ok: true, status: 200, body, ...extra,
  });
  return sandbox;
}

// A small hook runner for the real App: state, refs, memo and effects, rendered and flushed by hand.
async function mountApp({ hash = '', wheel = 'american', framed = false, fragment = 'none' } = {}) {
  const hooks = [];
  const effects = [];
  const recordings = [];
  const saves = [];
  let cursor = 0, dirty = true, tree;
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
  const ctx = await bundle(react, { framed });
  const initial = plain(ctx.loadApp());
  initial.settings.onboarded = true;
  initial.settings.vibration = false;
  initial.currentSession = plain(ctx.newSession(wheel, 500));
  initial.currentSession.id = 'photo-session';
  ctx.loadApp = () => plain(initial);
  ctx.saveApp = (state) => { saves.push(plain(state)); return true; };
  // Standalone: the recording is replaced by a recorder that keeps each spin. Framed: the real recording runs and
  // its requests are answered by settle() below.
  if (!framed) ctx.useCasinoRecording = (mode) => ({ record: (spin) => { recordings.push({ mode, ...plain(spin) }); } });
  ctx.navigator = {};
  ctx.document = { addEventListener() {}, removeEventListener() {} };
  ctx.location = { hash, pathname: '/roulette/', search: '' };
  ctx.history = { state: null, replaceState() { ctx.location.hash = ''; } };
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
    assert.fail('App did not settle');
  }
  function find(type, node) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) { for (const child of node) { const found = find(type, child); if (found) return found; } return null; }
    if (node.type === type || (typeof type === 'string' && typeof node.type === 'function' && node.type.name === type)) return node;
    return find(type, node.props && node.props.children);
  }
  // Framed: the shell answers each Casino request the way the real shell does, and the App is settled once no
  // request is left unanswered and nothing is pending to render or run.
  let answered = 0, revision = 0, acked = 0;
  const session = (spins) => ({ id: 'rec-1', status: 'running', spins, activeMs: 0, mode: 'live' });
  function bodyFor(request) {
    switch (request.op) {
      case 'settings': return { settings: { recordingEnabled: true } };
      case 'history': return { running: {} };
      case 'start': return { session: session(0) };
      case 'spin': return { recorded: true, session: session(request.payload.spin.sequence) };
      case 'readBoardResult': return { fragment };
      case 'readState': return { scope: 'a'.repeat(32), state: null };
      case 'writeState': revision += 1; return { state: { revision, data: request.payload.data } };
      default: return { session: session(0) };
    }
  }
  function serve() {
    let count = 0;
    for (; answered < ctx.posted.length; answered += 1, count += 1) {
      const request = ctx.posted[answered];
      if (request.data.op === 'spin') acked += 1;
      ctx.reply(request, bodyFor(request.data));
    }
    return count;
  }
  async function settle() {
    for (let i = 0; i < 500; i++) {
      const served = serve();
      if (dirty) render();
      for (const effect of effects.splice(0)) effect();
      await flushPromises();
      if (!served && !dirty && effects.length === 0) return;
    }
    assert.fail('the framed App did not settle');
  }
  function live() {
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node.type === 'button' && String(node.props.children).includes('Live')) node.props.onClick();
      else walk(node.props && node.props.children);
    };
    walk(tree);
  }
  const review = () => find(ctx.BoardPhotoReview, tree);
  return {
    ctx, flush, settle, live, review, recordings, saves, acked: () => acked,
    // The strip is drawn by the tracker page, which is a plain function of its props (board-photo.test.mjs does the same).
    strip: () => { const tracker = find('TrackerPage', tree); return tracker && find(ctx.RecentNumbersStrip, tracker.type(tracker.props)); },
    state: () => hooks[0].value.appState,
    restore(session) {
      // Changes the session's spins in place, as a restored or edited session would; the id and wheel stay the same.
      hooks[0].value = { ...hooks[0].value, appState: { ...hooks[0].value.appState,
        currentSession: { ...hooks[0].value.appState.currentSession, ...session } } };
      dirty = true;
    },
    pressAdd(numbers) {
      const element = review();
      assert.ok(element, 'the review is visible');
      element.props.onAdd(numbers || element.props.numbers);
    },
  };
}

// Reads the board photo as the App does, reviews it, and presses Add. Returns the mounted app (the caller unmounts).
async function addFromHash(hash, before) {
  const app = await mountApp({ hash });
  await app.flush();
  if (before) app.restore(before);
  await app.flush();
  app.live();
  await app.flush();
  assert.ok(app.review(), 'live mode shows the review of the read numbers');
  app.pressAdd();
  await app.flush();
  return app;
}

test("the reporter's photo: Add enters 2,2,2 first and keeps all 32 spins in order", async () => {
  const app = await addFromHash(HIS_HASH);
  assert.deepEqual(plain(app.state().currentSession.spins), HIS_SPINS, 'session spins, oldest first');
  assert.deepEqual(app.recordings.map((spin) => spin.segment), HIS_SPINS, 'each spin is recorded, repeats included');
  assert.deepEqual(app.saves.at(-1).currentSession.spins, HIS_SPINS, 'the saved session keeps every spin');
});

test('a repeat in the middle of the list (19, 19) is two spins, in board order reversed', async () => {
  const app = await addFromHash('#readboard=ok:5,19,19,7');
  assert.deepEqual(plain(app.state().currentSession.spins), ['7', '19', '19', '5']);
  assert.deepEqual(app.recordings.map((spin) => spin.segment), ['7', '19', '19', '5']);
});

test('a repeat that matches the session last spin is still added (session ends in 2, oldest entered is 2)', async () => {
  const app = await addFromHash('#readboard=ok:4,2', { spins: ['9', '2'] });
  assert.deepEqual(plain(app.state().currentSession.spins), ['9', '2', '2', '4']);
  assert.deepEqual(app.recordings.map((spin) => spin.segment), ['2', '4'], 'only the two added spins are recorded');
});

test('framed: the real recording sends each added spin once, oldest first, and Casino acknowledges all 32', async () => {
  const app = await mountApp({ framed: true, fragment: HIS_FRAGMENT });
  await app.settle();
  app.ctx.hello();
  await app.settle();
  assert.ok(app.review(), 'the framed return opens the live review');
  app.pressAdd();
  await app.settle();
  assert.deepEqual(plain(app.state().currentSession.spins), HIS_SPINS, 'the session holds every spin');
  const sent = app.ctx.posted.filter((p) => p.data.op === 'spin').map((p) => p.data.payload.spin);
  assert.deepEqual(sent.map((s) => s.segment), HIS_SPINS, 'each spin is sent, repeats included, oldest first');
  assert.deepEqual(sent.map((s) => s.sequence), HIS_SPINS.map((_, i) => i + 1), 'one-based sequence with no gaps');
  assert.equal(new Set(sent.map((s) => s.requestId)).size, HIS_SPINS.length, 'one request id per spin');
  assert.equal(app.acked(), HIS_SPINS.length, 'Casino acknowledged every spin');
});

// What the reporter sees on the live page after Add: the recent-numbers strip, rendered from the App's own props. The
// strip draws its first page of forty chips, and the board holds 32, so every number the add entered is drawn at once.
test("after the reporter's Add, the recent-numbers strip's first page shows all 32 numbers the add entered", async () => {
  const app = await addFromHash(HIS_HASH);
  const strip = app.strip();
  assert.ok(strip, 'the live page mounts the recent-numbers strip');
  const real = await bundle(React);
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(real.RecentNumbersStrip, strip.props));
  const chips = [...html.matchAll(/width:28px;height:28px;[^"]*">([^<]*)<\/div>/g)].map((m) => m[1]);
  assert.deepEqual(chips, HIS_BOARD, 'every number the add entered is on the first page of the strip, both leading 2s included');
  // The strip's own <style> rule (the hidden webkit scrollbar) is not a number, so it is taken out before the text is read.
  assert.equal(textOf(html.replace(/<style>[\s\S]*?<\/style>/, '')), chips.join(''));
});

test('the account sync merge keeps every repeated spin, whichever snapshot is newer', async () => {
  const ctx = await bundle(React);
  const full = { currentSession: { spins: HIS_SPINS }, savedSessions: [] };
  const shorter = { currentSession: { spins: HIS_SPINS.slice(3) }, savedSessions: [] };
  const local = ctx.rouletteSnapshot(full, { modifiedAt: 7, resetAt: 0 });
  const remote = ctx.rouletteSnapshot(shorter, { modifiedAt: 6, resetAt: 0 });
  assert.deepEqual(plain(ctx.mergeRouletteSnapshots(local, remote).appState.currentSession.spins), HIS_SPINS, 'the full list is the newer snapshot on the left');
  assert.deepEqual(plain(ctx.mergeRouletteSnapshots(remote, local).appState.currentSession.spins), HIS_SPINS, 'the full list is the newer snapshot on the right');
});
