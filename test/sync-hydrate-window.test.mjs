// Hydration window: a change made after mount and before the account state has loaded must survive
// hydration and be pushed. Tests drive the real useCasinoAccountSync hook through a small hooks runtime,
// because this suite runs under Node, not the browser bundle. The session.js storage functions are
// stand-ins with the same scope-gated write semantics: nothing persists until the account scope is writable.
import assert from 'node:assert/strict';
import test from 'node:test';

import { rouletteSnapshot, useCasinoAccountSync } from '../nexus-src/src/casino-sync.mjs';

const SCOPE = 'S'.repeat(32);
const APP_KEY = 'nexus-roulette-state';
const GLOBALS = [
  'React', 'useState', 'useEffect', 'window', 'localStorage', 'waitForCasinoBridge', 'askCasino',
  'beginRouletteAccountStorage', 'enableRouletteAccountStorage', 'rouletteStorageKey', 'loadApp', 'saveApp',
];

const sess = (id, { created, modified, spins = [] }) => ({
  id, created, modified, spins: [...spins], tracks: [], buyIns: [], cashOuts: [], sessionStartedAt: null,
});
// The state a device starts from before any account scope opens: factory defaults.
const freshApp = () => ({
  savedSessions: [],
  currentSession: sess('fresh-current', { created: 1000 }),
  gameSession: sess('fresh-game', { created: 1001 }),
  settings: { currency: 'USD', defaultBuyIn: 100, onboarded: false },
});
const accountSnapshot = () => rouletteSnapshot({
  savedSessions: [sess('old-saved', { created: 100, modified: 150, spins: ['3'] })],
  currentSession: sess('acct-active', { created: 1999, modified: 2000, spins: ['1', '2'] }),
  gameSession: sess('acct-game', { created: 1990, modified: 1995 }),
  settings: { currency: 'GBP', defaultBuyIn: 250, onboarded: true },
}, { modifiedAt: 2000, resetAt: 0 });
const clone = (value) => JSON.parse(JSON.stringify(value));
const last = (list) => list[list.length - 1];
const sameDeps = (a, b) => a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

// Installs the bridge, storage and hooks globals the hook reads, and returns a driver for one component instance.
function installWorld({ device = null, remote }) {
  const storage = new Map();
  const slots = [];
  const writes = [];
  const appStates = [];
  const readGate = deferred();
  let cursor = 0;
  let queued = [];
  let scope = null;
  let writable = false;
  const keyFor = (base) => (scope ? `${base}:account:${scope}` : null);

  if (device) storage.set(`${APP_KEY}:account:${SCOPE}`, JSON.stringify(device));

  const runtime = {
    useRef(initial) {
      const index = cursor; cursor += 1;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback(fn, deps) {
      const index = cursor; cursor += 1;
      const slot = slots[index];
      if (slot && sameDeps(slot.deps, deps)) return slot.fn;
      slots[index] = { deps, fn };
      return fn;
    },
    useState(initial) {
      const index = cursor; cursor += 1;
      if (!slots[index]) slots[index] = { value: initial };
      const slot = slots[index];
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
    },
    useEffect(fn, deps) {
      const index = cursor; cursor += 1;
      const slot = slots[index] || (slots[index] = {});
      if (slot.deps && sameDeps(slot.deps, deps)) return;
      slot.deps = deps;
      queued.push({ slot, fn });
    },
  };

  // Stable across renders, as a React state setter is.
  const setAppState = (next) => { appStates.push(next); };

  globalThis.React = { useRef: runtime.useRef, useCallback: runtime.useCallback };
  globalThis.useState = runtime.useState;
  globalThis.useEffect = runtime.useEffect;
  globalThis.window = { parent: {}, addEventListener() {}, removeEventListener() {} };
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
    removeItem: (key) => { storage.delete(key); },
  };
  globalThis.waitForCasinoBridge = async () => true;
  globalThis.askCasino = async (op, payload) => {
    if (op === 'readState') {
      await readGate.promise;
      return { ok: true, body: { scope: SCOPE, state: { revision: 7, data: clone(remote) } } };
    }
    if (op === 'writeState') {
      writes.push(clone(payload));
      return { ok: true, body: { scope: SCOPE, state: { revision: payload.expectedRevision + 1, data: clone(payload.data) } } };
    }
    throw new Error(`unexpected bridge operation ${op}`);
  };
  globalThis.beginRouletteAccountStorage = (value) => { scope = value; writable = false; return true; };
  globalThis.enableRouletteAccountStorage = () => { writable = !!scope; };
  globalThis.rouletteStorageKey = keyFor;
  globalThis.loadApp = () => {
    const raw = scope ? storage.get(keyFor(APP_KEY)) : undefined;
    return raw ? JSON.parse(raw) : freshApp();
  };
  globalThis.saveApp = (state) => {
    if (!scope || !writable) return false;
    storage.set(keyFor(APP_KEY), JSON.stringify(state));
    return true;
  };

  // One App render: the hook runs, then its effects run in declaration order.
  function render(appState) {
    cursor = 0;
    queued = [];
    const result = useCasinoAccountSync(appState, setAppState);
    for (const { slot, fn } of queued) {
      if (slot.cleanup) slot.cleanup();
      slot.cleanup = fn();
    }
    return result;
  }

  return {
    render,
    releaseRead: () => readGate.resolve(),
    writes,
    appStates,
    teardown() { for (const name of GLOBALS) delete globalThis[name]; },
  };
}

test('a spin made after mount and before hydration survives hydration and is pushed', async () => {
  const world = installWorld({ remote: accountSnapshot() });
  try {
    const fresh = freshApp();
    world.render(fresh);
    await flush();

    const spun = clone(fresh);
    spun.currentSession.spins = ['7', '7'];
    spun.currentSession.modified = 5000;
    world.render(spun);
    world.releaseRead();
    await flush();

    const final = last(world.appStates);
    assert.deepEqual(final.currentSession.spins, ['7', '7'], 'both repeated spins stay, as two spins');
    assert.ok(
      final.savedSessions.some((item) => item.id === 'acct-active' && item.spins.join(',') === '1,2'),
      'the account active session is kept in saved sessions, not overwritten',
    );
    assert.equal(world.writes.length, 1, 'the merged state is pushed once');
    assert.deepEqual(world.writes[0].data.appState.currentSession.spins, ['7', '7']);

    world.render(final);
    await flush();
    assert.equal(world.writes.length, 1, 'applying the hydrated state does not push it a second time');
  } finally {
    world.teardown();
  }
});

test('a settings change made before hydration keeps the account settings it did not touch and is pushed', async () => {
  const world = installWorld({ remote: accountSnapshot() });
  try {
    const fresh = freshApp();
    world.render(fresh);
    await flush();

    const changed = clone(fresh);
    changed.settings.currency = 'EUR';
    world.render(changed);
    world.releaseRead();
    await flush();

    const final = last(world.appStates);
    assert.equal(final.settings.currency, 'EUR', 'the changed field keeps the local change');
    assert.equal(final.settings.defaultBuyIn, 250, 'an untouched account setting is not reset to a default');
    assert.equal(final.settings.onboarded, true, 'an untouched account setting is not reset to a default');
    assert.equal(world.writes.length, 1);
    assert.equal(world.writes[0].data.appState.settings.currency, 'EUR');
    assert.equal(world.writes[0].data.appState.settings.onboarded, true);
  } finally {
    world.teardown();
  }
});

test('a change made before hydration is discarded when hydration adopts an account reset it had not seen', async () => {
  const reset = rouletteSnapshot({
    savedSessions: [],
    currentSession: sess('reset-current', { created: 2900 }),
    gameSession: sess('reset-game', { created: 2900 }),
    settings: { currency: 'GBP', defaultBuyIn: 100, onboarded: false },
  }, { modifiedAt: 3000, resetAt: 3000 });
  const world = installWorld({ remote: reset });
  try {
    const fresh = freshApp();
    world.render(fresh);
    await flush();

    const spun = clone(fresh);
    spun.currentSession.spins = ['7'];
    spun.currentSession.modified = 5000;
    world.render(spun);
    world.releaseRead();
    await flush();

    const final = last(world.appStates);
    assert.equal(final.currentSession.id, 'reset-current');
    assert.deepEqual(final.currentSession.spins, [], 'a reset removes history and a pre-reset edit cannot resurrect it');
    assert.equal(world.writes.length, 0, 'the adopted reset is already the account copy, so nothing is pushed');
  } finally {
    world.teardown();
  }
});

test('hydration with no change before it pushes the merged device and account state once', async () => {
  const device = freshApp();
  device.currentSession.spins = ['5'];
  device.currentSession.modified = 3000;
  const world = installWorld({ device, remote: accountSnapshot() });
  try {
    world.render(freshApp());
    await flush();
    world.releaseRead();
    await flush();

    assert.equal(world.writes.length, 1);
    assert.deepEqual(world.writes[0].data.appState.currentSession.spins, ['5'], 'the newer device session wins the active slot');
    assert.ok(world.writes[0].data.appState.savedSessions.some((item) => item.id === 'old-saved'));
  } finally {
    world.teardown();
  }
});

// Round 2: a session change made before hydration takes the active slot whenever the account's active session holds
// work, whatever the clocks say; a displaced Game session keeps its Game mode; an edit with no session work changes no
// session; a saved-session change is merged by union.

test('a Game session change made before hydration keeps the displaced account Game session in Game mode', async () => {
  const remote = rouletteSnapshot({
    savedSessions: [],
    currentSession: sess('acct-live', { created: 1500, modified: 1600 }),
    gameSession: sess('acct-game', { created: 1990, modified: 1995, spins: ['9'] }),
    settings: { currency: 'GBP', defaultBuyIn: 250, onboarded: true },
  }, { modifiedAt: 2000, resetAt: 0 });
  const world = installWorld({ remote });
  try {
    const fresh = freshApp();
    world.render(fresh);
    await flush();

    const played = clone(fresh);
    played.gameSession.spins = ['4'];
    played.gameSession.modified = 5000;
    world.render(played);
    world.releaseRead();
    await flush();

    const final = last(world.appStates);
    assert.equal(final.gameSession.id, 'fresh-game', 'the Game change takes the Game slot');
    assert.deepEqual(final.gameSession.spins, ['4']);
    assert.equal(final.currentSession.id, 'acct-live', 'a Game change does not touch the Live session');
    const displaced = final.savedSessions.find((item) => item.id === 'acct-game');
    assert.ok(displaced, 'the displaced account Game session is kept');
    assert.equal(displaced.mode, 'game', 'and keeps its Game mode, so it does not resume as a Live session');
    assert.equal(world.writes.length, 1, 'the merged state is pushed once');
  } finally {
    world.teardown();
  }
});

test('a change made before hydration takes the active slot when the account session is stamped later', async () => {
  const remote = rouletteSnapshot({
    savedSessions: [],
    currentSession: sess('acct-active', { created: 8000, modified: 9000, spins: ['1', '2'] }),
    gameSession: sess('acct-game', { created: 1990, modified: 1995 }),
    settings: { currency: 'GBP', defaultBuyIn: 250, onboarded: true },
  }, { modifiedAt: 9000, resetAt: 0 });
  const world = installWorld({ remote });
  try {
    const fresh = freshApp();
    world.render(fresh);
    await flush();

    const spun = clone(fresh);
    spun.currentSession.spins = ['7'];
    spun.currentSession.modified = 5000;
    world.render(spun);
    world.releaseRead();
    await flush();

    const final = last(world.appStates);
    assert.equal(final.currentSession.id, 'fresh-current', 'the change takes the active slot whatever the account stamp says');
    assert.deepEqual(final.currentSession.spins, ['7']);
    const displaced = final.savedSessions.find((item) => item.id === 'acct-active');
    assert.deepEqual(displaced && displaced.spins, ['1', '2'], 'the displaced account session is kept with its spins');
  } finally {
    world.teardown();
  }
});

test('a label on the empty factory session with a newer stamp does not take the active slot', async () => {
  const world = installWorld({ remote: accountSnapshot() });
  try {
    const fresh = freshApp();
    world.render(fresh);
    await flush();

    const labelled = clone(fresh);
    labelled.currentSession.label = 'Renamed';
    labelled.currentSession.modified = 5000;
    world.render(labelled);
    world.releaseRead();
    await flush();

    const final = last(world.appStates);
    assert.equal(final.currentSession.id, 'acct-active', 'an edit with no session work does not move the active slot');
    assert.deepEqual(final.currentSession.spins, ['1', '2']);
    assert.deepEqual(final.savedSessions.map((item) => item.id), ['old-saved'], 'no empty session is written into saved sessions');
  } finally {
    world.teardown();
  }
});

test('a label on the empty factory session with an older stamp writes no empty session into saved sessions', async () => {
  const world = installWorld({ remote: accountSnapshot() });
  try {
    const fresh = freshApp();
    world.render(fresh);
    await flush();

    const labelled = clone(fresh);
    labelled.currentSession.label = 'Renamed';
    world.render(labelled);
    world.releaseRead();
    await flush();

    const final = last(world.appStates);
    assert.equal(final.currentSession.id, 'acct-active');
    assert.deepEqual(final.savedSessions.map((item) => item.id), ['old-saved'], 'the empty factory session is not saved');
  } finally {
    world.teardown();
  }
});

test('a saved-session change made before hydration is merged into the account saved sessions and pushed', async () => {
  const world = installWorld({ remote: accountSnapshot() });
  try {
    const fresh = freshApp();
    world.render(fresh);
    await flush();

    const saved = clone(fresh);
    saved.savedSessions = [sess('device-saved', { created: 300, modified: 310, spins: ['8'] })];
    world.render(saved);
    world.releaseRead();
    await flush();

    const final = last(world.appStates);
    assert.deepEqual(final.savedSessions.map((item) => item.id), ['old-saved', 'device-saved'], 'both saved lists are kept, in creation order');
    assert.equal(final.currentSession.id, 'acct-active', 'a saved-session change does not move the active session');
    assert.equal(world.writes.length, 1);
    assert.deepEqual(world.writes[0].data.appState.savedSessions.map((item) => item.id), ['old-saved', 'device-saved']);
  } finally {
    world.teardown();
  }
});
