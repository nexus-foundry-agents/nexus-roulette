import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';

import {
  CASINO_BRIDGE_HELLO,
  CASINO_BRIDGE_REQUEST,
  CASINO_BRIDGE_RESPONSE,
  CASINO_SHELL_ORIGIN,
  useCasinoRecording,
} from '../nexus-src/src/casino-recording.mjs';
import {
  SPIN_RETRY_MS,
  createSpinQueue,
  spinsDroppedCopy,
  spinsNotSavedCopy,
  spinsWaitingCopy,
} from '../nexus-src/src/casino-spin-queue.mjs';

// CASINO-AUTO-RETRY-LOOP. FIX 1 is the automatic pause and resume that renders must not re-arm, and that a spin retries
// once. FIX 3 is the four Casino calls that must catch their own errors. FIX 2 (the Stop-throw line) is the ROUND-5 LOW
// test in recording-queue-abandon.test.mjs. The bundle concatenates the sources into one scope, so the recording hook
// reads the queue's functions as globals, as in the other recording tests.
Object.assign(globalThis, { createSpinQueue, spinsDroppedCopy, spinsNotSavedCopy, spinsWaitingCopy });

const PAUSE_LINE = 'Casino did not pause the session. It will try again at your next spin.';
const RESUME_LINE = 'Casino did not resume the session. It will try again at your next spin.';
const PAUSED_SPIN_LINE = '1 spin was not saved to Casino: recording is paused. Resume it before the next spin.';

const spin = (segment) => ({ segment, staked: 5, returned: 0, watched: false });
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function until(check, limit = 2000) {
  for (let i = 0; i < limit; i += 1) {
    if (check()) return true;
    await tick();
  }
  return check();
}

// Renders the hook again and again, as a page does while its timers run. An effect that is re-armed by renders would
// make a Casino call on each of them.
async function renders(view, count) {
  for (let i = 0; i < count; i += 1) {
    view();
    await tick();
  }
}

// -- FIX 1: the automatic pause and resume ---------------------------------------------------------------------------

const bridgeListeners = [];
const realWindow = globalThis.window;
const realReact = globalThis.React;
const realUseState = globalThis.useState;
const realUseEffect = globalThis.useEffect;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

function restoreGlobals() {
  globalThis.window = realWindow;
  globalThis.React = realReact;
  globalThis.useState = realUseState;
  globalThis.useEffect = realUseEffect;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

// The spin retry timer is never run here, and the other waits run at once.
function overrideTimers() {
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    if (milliseconds === SPIN_RETRY_MS || milliseconds >= 5000) return 0;
    return realSetTimeout(() => callback(...args), 0);
  };
  globalThis.clearTimeout = (handle) => { if (handle) realClearTimeout(handle); };
}

// A fake Casino shell for the calls the recording hook makes. `refuse` names operations Casino answers with a refusal,
// `throwOn` names operations whose call throws inside the bridge before any answer. Every call is counted by operation.
function installFakeCasino({ running = true, refuse = [], throwOn = [] } = {}) {
  const shell = {};
  const server = {
    status: running ? 'running' : 'stopped',
    recorded: [],
    attempts: {},
    refuse: new Set(refuse),
    throwOn: new Set(throwOn),
  };
  const count = (op) => { server.attempts[op] = (server.attempts[op] || 0) + 1; };

  function deliver(data) {
    bridgeListeners.slice().forEach((listener) => listener({ origin: CASINO_SHELL_ORIGIN, source: shell, data }));
  }
  function reply(message, status, body, error) {
    const ok = status >= 200 && status < 300;
    setImmediate(() => deliver({ kind: CASINO_BRIDGE_RESPONSE, id: message.id, ok, status, body, error }));
  }
  const sessionNow = () => ({ id: 's1', status: server.status, spins: server.recorded.length });
  function serve(message) {
    const { op, payload } = message;
    count(op);
    if (op === 'settings') return reply(message, 200, { settings: { recordingEnabled: true } });
    if (op === 'history') {
      const live = server.status === 'running' || server.status === 'paused';
      return reply(message, 200, { running: live ? { game: sessionNow() } : {} });
    }
    if (op === 'start') {
      server.status = 'running';
      return reply(message, 201, { session: sessionNow() });
    }
    if (op === 'spin') {
      const sequence = payload.spin.sequence;
      const repeat = server.recorded.some((row) => row.sequence === sequence);
      if (!repeat) server.recorded.push({ sequence, segment: payload.spin.segment });
      return reply(message, 201, { recorded: !repeat, session: sessionNow() });
    }
    if (op === 'pause' || op === 'resume') {
      if (server.refuse.has(op)) return reply(message, 409, { error: 'casino_refused' }, 'Casino refused the ' + op + ' for the test.');
      server.status = op === 'pause' ? 'paused' : 'running';
      return reply(message, 200, { session: sessionNow() });
    }
    if (op === 'stop') {
      server.status = 'stopped';
      return reply(message, 200, { session: sessionNow() });
    }
    return reply(message, 400, undefined, 'unknown operation');
  }

  shell.postMessage = (message, targetOrigin) => {
    if (!message || message.kind !== CASINO_BRIDGE_REQUEST || targetOrigin !== CASINO_SHELL_ORIGIN) return;
    if (server.throwOn.has(message.op)) {
      count(message.op);
      throw new Error('the Casino bridge refused the ' + message.op + ' call.');
    }
    serve(message);
  };
  globalThis.window = {
    parent: shell,
    addEventListener(type, listener) { if (type === 'message') bridgeListeners.push(listener); },
  };
  return {
    server,
    hello() { deliver({ kind: CASINO_BRIDGE_HELLO, gameId: 'roulette' }); },
  };
}

// Hooks run as plain functions. useState keeps its value in a slot; useCallback and useEffect compare their
// dependencies as React does. `unmount` runs every effect's cleanup, which is what closing the view does.
function installHarness() {
  const refs = [];
  const states = [];
  const memos = [];
  const effects = [];
  let cursor = 0;
  let pending = [];
  const changed = (before, after) => !before || !after || before.length !== after.length
    || after.some((value, index) => !Object.is(value, before[index]));
  globalThis.React = {
    useRef(initial) {
      const index = cursor++;
      if (!refs[index]) refs[index] = { current: initial };
      return refs[index];
    },
    useCallback(fn, deps) {
      const index = cursor++;
      if (!memos[index] || changed(memos[index].deps, deps)) memos[index] = { fn, deps };
      return memos[index].fn;
    },
  };
  globalThis.useState = (initial) => {
    const index = cursor++;
    if (!states[index]) states[index] = { value: initial };
    const slot = states[index];
    return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
  };
  globalThis.useEffect = (effect, deps) => {
    const index = cursor++;
    if (!effects[index]) effects[index] = { deps: undefined, cleanup: null };
    const slot = effects[index];
    if (changed(slot.deps, deps)) {
      slot.deps = deps;
      pending.push(() => {
        if (slot.cleanup) slot.cleanup();
        slot.cleanup = effect() || null;
      });
    }
  };
  const render = function (mode, active) {
    cursor = 0;
    pending = [];
    const view = useCasinoRecording(mode, active);
    pending.forEach((run) => run());
    return view;
  };
  render.unmount = () => {
    effects.forEach((slot) => {
      if (slot && slot.cleanup) {
        slot.cleanup();
        slot.cleanup = null;
      }
    });
  };
  return render;
}

test('FIX 1: a refused automatic pause is not re-armed by renders, and the line says it tries again at the next spin', async (t) => {
  overrideTimers();
  const casino = installFakeCasino({ running: true, refuse: ['pause'] });
  const render = installHarness();
  t.after(() => { render.unmount(); restoreGlobals(); });
  // The view is inactive from the start, so the page's own check pauses the running session.
  const view = () => render('game', false);

  view();
  casino.hello();
  assert.equal(await until(() => casino.server.attempts.pause === 1 && view().problem === PAUSE_LINE), true,
    'the refused automatic pause did not state the line');
  await renders(view, 30);
  assert.equal(casino.server.attempts.pause, 1, 'renders re-armed a pause Casino refused');
  assert.equal(view().problem, PAUSE_LINE);
  assert.equal(view().availability, 'on', 'a refused pause made recording unavailable');
});

test('FIX 1: an automatic pause that throws states the same line and is not re-armed by renders', async (t) => {
  overrideTimers();
  const casino = installFakeCasino({ running: true, throwOn: ['pause'] });
  const render = installHarness();
  t.after(() => { render.unmount(); restoreGlobals(); });
  const view = () => render('game', false);

  view();
  casino.hello();
  assert.equal(await until(() => casino.server.attempts.pause === 1 && view().problem === PAUSE_LINE), true,
    'the thrown automatic pause did not state the line');
  await renders(view, 30);
  assert.equal(casino.server.attempts.pause, 1, 'renders re-armed a pause that threw');
});

// A resume made on return to the mode is refused, or throws, and a spin then makes exactly one attempt before it is
// queued. The spin is refused as paused if that attempt fails, and it is recorded once the resume succeeds.
for (const failure of ['refused', 'thrown']) {
  test(`FIX 1: a ${failure} automatic resume is not re-armed by renders, and each spin makes one attempt before it is queued`, async (t) => {
    overrideTimers();
    const casino = installFakeCasino({ running: true });
    const render = installHarness();
    t.after(() => { render.unmount(); restoreGlobals(); });
    const view = (active = true) => render('game', active);
    const failing = failure === 'refused' ? casino.server.refuse : casino.server.throwOn;

    view();
    casino.hello();
    assert.equal(await until(() => view().session && view().session.status === 'running'), true,
      'the running session was not adopted');
    view(false);
    assert.equal(await until(() => casino.server.attempts.pause === 1 && view(false).session.status === 'paused'), true,
      'leaving the mode did not pause the session');

    failing.add('resume');
    view(true);
    assert.equal(await until(() => casino.server.attempts.resume === 1 && view().problem === RESUME_LINE), true,
      'the failed automatic resume did not state the line');
    await renders(() => view(true), 30);
    assert.equal(casino.server.attempts.resume, 1, 'renders re-armed a resume that failed');

    view().record(spin('17'));
    assert.equal(await until(() => casino.server.attempts.resume === 2 && view().problem === PAUSED_SPIN_LINE), true,
      'the spin did not make its one attempt, or was not refused as paused after it');
    assert.equal(casino.server.attempts.spin || 0, 0, 'a spin reached Casino while the session was paused');
    await renders(() => view(true), 30);
    assert.equal(casino.server.attempts.resume, 2, 'renders made more attempts than the one the spin makes');

    failing.delete('resume');
    view().record(spin('8'));
    assert.equal(await until(() => casino.server.recorded.length === 1 && view().session.status === 'running'), true,
      'the spin after the resume was not recorded');
    assert.equal(casino.server.attempts.resume, 3, 'the spin did not resume once more before it was queued');
    assert.deepEqual(casino.server.recorded.map((row) => row.segment), ['8']);
    assert.equal(await until(() => view().problem === null), true, 'the recorded spin left a line behind');
  });
}

test('FIX 1 control: a Resume the user presses shows Casino\'s own refusal, not the automatic line, and makes no automatic attempt', async (t) => {
  overrideTimers();
  const casino = installFakeCasino({ running: true });
  const render = installHarness();
  t.after(() => { render.unmount(); restoreGlobals(); });
  const view = (active = true) => render('game', active);

  view();
  casino.hello();
  assert.equal(await until(() => view().session && view().session.status === 'running'), true, 'the running session was not adopted');
  view(false);
  assert.equal(await until(() => casino.server.attempts.pause === 1 && view(false).session.status === 'paused'), true,
    'leaving the mode did not pause the session');

  casino.server.refuse.add('resume');
  view(true);
  assert.equal(await until(() => casino.server.attempts.resume === 1 && view().problem === RESUME_LINE), true,
    'the automatic resume did not state the line');

  view().resume(); // the user's own press
  assert.equal(await until(() => casino.server.attempts.resume === 2 && view().problem === 'Casino refused the resume for the test.'), true,
    'the user\'s Resume did not show Casino\'s refusal');
  await renders(() => view(true), 30);
  assert.equal(casino.server.attempts.resume, 2, 'the user\'s Resume was followed by automatic attempts');
});

// -- FIX 3: the Casino calls that catch their own errors -------------------------------------------------------------

const SRC = new URL('../nexus-src/src/', import.meta.url);
// The files the bundle concatenates ahead of the pieces these tests use, in build.js order.
const BUNDLE_FILES = [
  'constants.js', 'account-storage.mjs', 'engine.js', 'session.js', 'casino-recording.mjs', 'casino-sync.mjs', 'components/BoardPhoto.jsx',
];
const plain = (value) => JSON.parse(JSON.stringify(value));
const compiledBundles = new Map();

// The hooks the bundle's photo return and account sync call, run as plain functions: each run is one render.
function makeHooks() {
  const refs = [];
  const states = [];
  const memos = [];
  const effects = [];
  let cursor = 0;
  let pending = [];
  const changed = (before, after) => !before || !after || before.length !== after.length
    || after.some((value, index) => !Object.is(value, before[index]));
  const useRef = (initial) => {
    const index = cursor++;
    if (!refs[index]) refs[index] = { current: initial };
    return refs[index];
  };
  const useCallback = (fn, deps) => {
    const index = cursor++;
    if (!memos[index] || changed(memos[index].deps, deps)) memos[index] = { fn, deps };
    return memos[index].fn;
  };
  const useState = (initial) => {
    const index = cursor++;
    if (!states[index]) states[index] = { value: initial };
    const slot = states[index];
    return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
  };
  const useEffect = (effect, deps) => {
    const index = cursor++;
    if (!effects[index]) effects[index] = { deps: undefined };
    const slot = effects[index];
    if (changed(slot.deps, deps)) {
      slot.deps = deps;
      pending.push(() => { effect(); });
    }
  };
  const React = { useRef, useCallback, useEffect, useState };
  const run = (fn) => {
    cursor = 0;
    pending = [];
    const value = fn();
    pending.forEach((runEffect) => runEffect());
    return value;
  };
  return { React, useState, useEffect, run };
}

// A fake shell that answers the bridge requests of a bundle. `throwOn` names operations whose call throws inside the
// bridge; `answers` gives the reply for each other operation.
function fakeShell({ throwOn = [], answers = {} } = {}) {
  const shell = { deliver() {} };
  shell.postMessage = (data, origin) => {
    if (!data || data.kind !== CASINO_BRIDGE_REQUEST || origin !== CASINO_SHELL_ORIGIN) return;
    if (throwOn.includes(data.op)) throw new Error(`the Casino bridge refused the ${data.op} call.`);
    const answer = answers[data.op] ? answers[data.op](data.payload) : { ok: true, status: 200, body: undefined };
    setImmediate(() => shell.deliver({
      kind: CASINO_BRIDGE_RESPONSE, id: data.id, ok: answer.ok, status: answer.status, body: answer.body, error: answer.error,
    }));
  };
  return shell;
}

// Loads source files the way build.js does (the same concatenation and transforms) into one vm scope, framed by `shell`.
async function loadBundle(files, shell, hooks) {
  const sources = await Promise.all(files.map((file) => readFile(new URL(file, SRC), 'utf8')));
  const combined = files.map((file, i) => `\n// ===== ${file} =====\n${sources[i]}`).join('\n').replace(/\r\n?/g, '\n');
  let code = compiledBundles.get(combined);
  if (!code) {
    ({ code } = transformSync(combined, {
      babelrc: false,
      configFile: false,
      filename: 'app.jsx',
      presets: [
        [presetReact, { runtime: 'classic' }],
        [presetEnv, { targets: { ie: 11 }, modules: 'commonjs', useBuiltIns: false }],
      ],
    }));
    compiledBundles.set(combined, code);
  }
  const store = {};
  const listeners = new Set();
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    React: hooks.React,
    useState: hooks.useState,
    useEffect: hooks.useEffect,
    setTimeout, clearTimeout, setImmediate,
    addEventListener(name, listener) { if (name === 'message') listeners.add(listener); },
    removeEventListener(name, listener) { if (name === 'message') listeners.delete(listener); },
    localStorage: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; },
    },
    require: (name) => {
      if (name === 'react') return hooks.React;
      throw new Error(`unexpected module in test slice: ${name}`);
    },
  };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  sandbox.window = sandbox;
  sandbox.window.parent = shell;
  shell.deliver = (data) => {
    for (const listener of listeners) listener({ data, origin: CASINO_SHELL_ORIGIN, source: shell });
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'bundle-slice.js' });
  return { ctx: sandbox, hello: () => shell.deliver({ kind: CASINO_BRIDGE_HELLO, gameId: 'roulette' }) };
}

// Unhandled promise rejections raised while the test runs. Each one is a Casino call that nothing caught.
function watchUnhandled(t) {
  const seen = [];
  const listener = (reason) => { seen.push(String(reason && reason.message ? reason.message : reason)); };
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));
  return seen;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await tick();
}

test('FIX 3: a photo open whose Casino call throws shows the existing unavailable status and leaves nothing unhandled', async (t) => {
  const unhandled = watchUnhandled(t);
  const shell = fakeShell({ throwOn: ['openReadBoard'] });
  const { ctx, hello } = await loadBundle(BUNDLE_FILES, shell, makeHooks());
  ctx.installCasinoBridge();
  hello();
  const statuses = [];
  await ctx.openBoardPhoto({ assign() { assert.fail('the frame navigated'); } }, 'american', (result) => statuses.push(plain(result)));
  await settle();
  assert.deepEqual(statuses, [{ kind: 'status', status: 'unavailable' }]);
  assert.deepEqual(unhandled, []);
});

test('FIX 3: a photo return read that throws shows the existing unavailable status and leaves nothing unhandled', async (t) => {
  const unhandled = watchUnhandled(t);
  const shell = fakeShell({ throwOn: ['readBoardResult'] });
  const hooks = makeHooks();
  const { ctx, hello } = await loadBundle(BUNDLE_FILES, shell, hooks);
  ctx.installCasinoBridge();
  const shown = [];
  hooks.run(() => ctx.useCasinoBoardReturn('american', () => {}, (result) => shown.push(plain(result)), 'synced', 's1'));
  hello();
  assert.equal(await until(() => shown.length === 1), true, 'the failed read showed nothing');
  await settle();
  assert.deepEqual(shown, [{ kind: 'status', status: 'unavailable' }]);
  assert.deepEqual(unhandled, []);
});

test('FIX 3: an account read that throws is "Not saved", is never left on checking, and leaves nothing unhandled', async (t) => {
  const unhandled = watchUnhandled(t);
  const shell = fakeShell({ throwOn: ['readState'] });
  const hooks = makeHooks();
  const { ctx, hello } = await loadBundle(BUNDLE_FILES, shell, hooks);
  const appState = {};
  const setAppState = () => {};
  const sync = () => hooks.run(() => ctx.useCasinoAccountSync(appState, setAppState));
  assert.equal(sync().status, 'checking', 'the page did not start on checking');
  hello();
  assert.equal(await until(() => sync().status !== 'checking'), true, 'the account state was left on checking');
  await settle();
  assert.equal(sync().status, 'unavailable');
  assert.equal(sync().problem, 'Not saved: Casino account storage is unavailable.');
  assert.deepEqual(unhandled, []);
});

test('FIX 3: an account write that throws is "Casino account sync is unavailable", is never left on syncing, and leaves nothing unhandled', async (t) => {
  const unhandled = watchUnhandled(t);
  const shell = fakeShell({
    throwOn: ['writeState'],
    answers: { readState: () => ({ ok: true, status: 200, body: { scope: 'A'.repeat(32), state: null } }) },
  });
  const hooks = makeHooks();
  const { ctx, hello } = await loadBundle(BUNDLE_FILES, shell, hooks);
  const appState = {};
  const setAppState = () => {};
  const sync = () => hooks.run(() => ctx.useCasinoAccountSync(appState, setAppState));
  sync();
  hello();
  assert.equal(await until(() => sync().status === 'unavailable'), true, 'the failed write did not show unavailable');
  await settle();
  assert.equal(sync().status, 'unavailable', 'the state was left on syncing');
  assert.equal(sync().problem, 'Casino account sync is unavailable.');
  assert.deepEqual(unhandled, []);
});
