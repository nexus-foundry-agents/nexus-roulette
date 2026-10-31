import assert from 'node:assert/strict';
import test from 'node:test';

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

// A call to Casino that throws, and a link of the recording chain that throws. The bundle concatenates the source
// files into one scope, so the recording hook reads the queue's functions as globals. The hook harness is a copy of
// the one in recording-queue-abandon.test.mjs.
Object.assign(globalThis, { createSpinQueue, spinsDroppedCopy, spinsNotSavedCopy, spinsWaitingCopy });

const spin = (segment) => ({ segment, staked: 5, returned: 0, watched: false });
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function until(check, limit = 2000) {
  for (let i = 0; i < limit; i += 1) {
    if (check()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return check();
}

// The last spin is confirmed, and its confirmation clears the failure line. Waiting for that keeps Casino's reply
// from arriving after the test has restored the globals it reads.
async function settled(view) {
  assert.equal(await until(() => view().problem === null), true, 'the later spin did not clear the failure line');
}

// -- Without crypto.randomUUID (no secure context), a spin still gets its own request id and is recorded ------------

function withCrypto(t, value) {
  const real = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  t.after(() => Object.defineProperty(globalThis, 'crypto', real));
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });
}

// Each call returns different bytes. The test needs distinct values, not randomness.
function countingRandom() {
  let n = 0;
  return {
    getRandomValues(array) {
      for (let i = 0; i < array.length; i += 1) array[i] = (n += 37) & 0xff;
      return array;
    },
  };
}

// Queues two spins with the queue alone (no bridge), flushes it, and returns what Casino saw.
async function recordTwoSpins() {
  const casino = { recorded: [], sent: [], confirmed: 0 };
  const queue = createSpinQueue({
    resolveSession: async () => ({ ok: true, session: { id: 's1', status: 'running', spins: casino.recorded.length } }),
    send: async (op, payload) => {
      casino.sent.push(structuredClone(payload));
      casino.recorded.push(payload.spin.sequence);
      return { ok: true, status: 201, body: { recorded: true, session: { id: 's1', status: 'running', spins: casino.recorded.length } } };
    },
    wait: async () => {},
    pauseRequested: () => false,
    report: () => {},
    confirmed: () => { casino.confirmed += 1; },
    recordingOff: () => {},
    reread: async () => ({ ok: true, session: { id: 's1', status: 'running', spins: casino.recorded.length } }),
    ended: () => {},
    drained: () => {},
    schedule: () => () => {},
  });
  queue.enqueue(spin('17'));
  queue.enqueue(spin('8'));
  assert.equal(await queue.flush(), true, 'the queue did not drain');
  return casino;
}

function assertTwoSpinsRecorded(casino) {
  assert.deepEqual(casino.recorded, [1, 2], 'the two spins were not both recorded');
  assert.equal(casino.confirmed, 2, 'Casino did not confirm both spins');
  const ids = casino.sent.map((payload) => payload.spin.requestId);
  ids.forEach((id) => assert.match(id, UUID_SHAPE, 'a request id is not in the UUID shape'));
  assert.equal(new Set(ids).size, 2, 'two spins shared a request id');
}

test('no crypto.randomUUID: a spin gets a UUID-shaped request id from getRandomValues, and is recorded', async (t) => {
  withCrypto(t, countingRandom());
  assertTwoSpinsRecorded(await recordTwoSpins());
});

test('no crypto at all: a spin gets a UUID-shaped request id from the time and a counter, and is recorded', async (t) => {
  withCrypto(t, undefined);
  assertTwoSpinsRecorded(await recordTwoSpins());
});

// -- The bridge, the fake Casino shell, and the hook harness ----------------------------------------------------------

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

// The retry timer is kept for the test to fire (retries), and no other long timer ever fires.
function overrideTimers(t, retries = []) {
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    if (milliseconds === SPIN_RETRY_MS) {
      retries.push(() => callback(...args));
      return 0;
    }
    if (milliseconds >= 5000) return 0;
    return realSetTimeout(() => callback(...args), 0);
  };
  globalThis.clearTimeout = (handle) => { if (handle) realClearTimeout(handle); };
  t.after(restoreGlobals);
  return retries;
}

// A fake Casino shell. throwOn[op] counts the calls of that operation that throw inside the bridge before any answer
// is posted, so the hook's askCasino rejects. unreadable lists the operations whose answer cannot be read: the body
// throws when its session is read. Casino's own state is left as it was for an unreadable answer.
function installFakeCasino({ throwOn = {}, unreadable = [] } = {}) {
  const shell = {};
  const server = { recorded: [], spinCalls: 0, spinPayloads: [], failNext: 0, status: 'running' };
  const throwsLeft = { ...throwOn };
  const unreadableOps = new Set(unreadable);

  function deliver(data) {
    bridgeListeners.slice().forEach((listener) => listener({ origin: CASINO_SHELL_ORIGIN, source: shell, data }));
  }
  function reply(message, status, body, error) {
    const ok = status >= 200 && status < 300;
    setImmediate(() => deliver({ kind: CASINO_BRIDGE_RESPONSE, id: message.id, ok, status, body, error }));
  }
  const sessionNow = () => ({ id: 's1', status: server.status, spins: server.recorded.length });
  function unreadableBody() {
    return Object.defineProperty({}, 'session', {
      enumerable: true,
      get() { throw new Error('the Casino answer could not be read.'); },
    });
  }
  function serve(message) {
    const { op, payload } = message;
    if (unreadableOps.has(op)) return reply(message, 200, unreadableBody());
    if (op === 'settings') return reply(message, 200, { settings: { recordingEnabled: true } });
    if (op === 'history') return reply(message, 200, { running: {} });
    if (op === 'start') {
      server.status = 'running';
      return reply(message, 201, { session: sessionNow() });
    }
    if (op === 'pause') {
      server.status = 'paused';
      return reply(message, 200, { session: sessionNow() });
    }
    if (op === 'spin') {
      server.spinCalls += 1;
      server.spinPayloads.push(structuredClone(payload));
      if (server.failNext > 0) {
        server.failNext -= 1;
        return reply(message, 0, undefined, 'network down');
      }
      const sequence = payload.spin.sequence;
      const repeat = server.recorded.some((row) => row.sequence === sequence);
      if (!repeat) server.recorded.push({ sequence, segment: payload.spin.segment });
      return reply(message, 201, { recorded: !repeat, session: sessionNow() });
    }
    if (op === 'stop') {
      server.status = 'stopped';
      return reply(message, 200, { session: sessionNow() });
    }
    return reply(message, 400, undefined, 'unknown operation');
  }

  shell.postMessage = (message, targetOrigin) => {
    if (!message || message.kind !== CASINO_BRIDGE_REQUEST || targetOrigin !== CASINO_SHELL_ORIGIN) return;
    if (throwsLeft[message.op] > 0) {
      throwsLeft[message.op] -= 1;
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

// Hooks run as plain functions here, as in recording-queue-abandon.test.mjs.
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

// -- A Stop whose Casino call throws restores the pause owner it replaced -------------------------------------------

test('a Stop whose Casino call throws restores the pause owner, so the next spin carries no pause', async (t) => {
  overrideTimers(t);
  const casino = installFakeCasino({ throwOn: { stop: 1 } });
  const render = installHarness();
  t.after(() => render.unmount());
  const view = () => render('game', true);

  view();
  casino.hello();
  assert.equal(await until(() => view().availability === 'on'), true, 'recording never reported on');

  // The first spin fails on all three attempts, so the queue is held, and the discard then drops it.
  casino.server.failNext = 3;
  view().record(spin('17'));
  assert.equal(await until(() => casino.server.spinCalls === 3 && /^1 spin waiting/.test(view().problem)), true,
    'the spin was not held');
  view().stop();
  assert.equal(await until(() => /Press Stop again to discard 1 unsent spin/.test(view().problem)), true,
    'Stop did not offer the discard');
  view().stop(); // the Stop call to Casino throws
  assert.equal(await until(() => view().problem === '1 spin may have been saved to Casino: discarded by Stop. Stop did not reach Casino: the Casino bridge refused the stop call.'), true,
    'the failure of Stop was not shown');
  assert.equal(view().session.status, 'running', 'a Stop that failed changed the session');

  view().record(spin('3'));
  assert.equal(await until(() => casino.server.recorded.length === 1), true, 'the next spin was not recorded');
  assert.equal(casino.server.spinPayloads.at(-1).spin.pauseAfter, undefined, 'the next spin carried a pause');
  await settled(view);
});

// -- A throw in a session check, in a Stop or a Pause, and in a start, leaves the chain alive -----------------------

test('a session check that throws states the failure, and a later spin is recorded', async (t) => {
  overrideTimers(t);
  const casino = installFakeCasino({ throwOn: { settings: 1 } });
  const render = installHarness();
  t.after(() => render.unmount());
  const view = () => render('game', true);

  view(); // the first check, made on mount, throws
  casino.hello();
  assert.equal(await until(() => view().problem === 'the Casino bridge refused the settings call.'), true,
    'the failed check was not stated');
  assert.equal(view().availability, 'unavailable', 'a check that could not establish the state did not say so');

  view().record(spin('17'));
  assert.equal(await until(() => casino.server.recorded.length === 1), true, 'the later spin was not recorded');
  assert.equal(view().availability, 'on');
  await settled(view);
});

test('a Stop on a recording whose Casino call throws states the failure, and a later spin is recorded', async (t) => {
  overrideTimers(t);
  const casino = installFakeCasino({ throwOn: { stop: 1 } });
  const render = installHarness();
  t.after(() => render.unmount());
  const view = () => render('game', true);

  view();
  casino.hello();
  assert.equal(await until(() => view().availability === 'on'), true, 'recording never reported on');
  view().record(spin('17'));
  assert.equal(await until(() => casino.server.recorded.length === 1), true, 'the first spin was not recorded');

  view().stop(); // not held, so the Stop runs through the chain, and its call throws
  assert.equal(await until(() => view().problem === 'the Casino bridge refused the stop call.'), true,
    'the failure of Stop was not shown');

  view().record(spin('8'));
  assert.equal(await until(() => casino.server.recorded.length === 2), true, 'the later spin was not recorded');
  assert.equal(view().session.status, 'running');
  await settled(view);
});

test('a Pause whose Casino call throws clears the pause owner: the failure is stated and the next spin carries no pause', async (t) => {
  overrideTimers(t);
  const casino = installFakeCasino({ throwOn: { pause: 1 } });
  const render = installHarness();
  t.after(() => render.unmount());
  const view = () => render('game', true);

  view();
  casino.hello();
  assert.equal(await until(() => view().availability === 'on'), true, 'recording never reported on');
  view().record(spin('17'));
  assert.equal(await until(() => casino.server.recorded.length === 1), true, 'the first spin was not recorded');

  view().pause(); // the Pause call to Casino throws
  assert.equal(await until(() => view().problem === 'the Casino bridge refused the pause call.'), true,
    'the failure of Pause was not shown');

  view().record(spin('8'));
  assert.equal(await until(() => casino.server.recorded.length === 2), true, 'the later spin was not recorded');
  assert.equal(casino.server.spinPayloads.at(-1).spin.pauseAfter, undefined, 'the later spin carried a pause');
  assert.equal(view().session.status, 'running', 'a Pause that failed changed the session');
  await settled(view);
});

test('a start that throws holds the spin with the failure stated, and the retry records it', async (t) => {
  const retries = overrideTimers(t);
  const casino = installFakeCasino({ throwOn: { start: 1 } });
  const render = installHarness();
  t.after(() => render.unmount());
  const view = () => render('game', true);

  view();
  casino.hello();
  assert.equal(await until(() => view().availability === 'on'), true, 'recording never reported on');
  view().record(spin('17'));
  assert.equal(await until(() => view().problem === '1 spin waiting to send to Casino. the Casino bridge refused the start call.'),
    true, 'the failed start was not stated');
  assert.equal(casino.server.recorded.length, 0, 'a spin was recorded before its session started');

  assert.equal(await until(() => retries.length === 1), true, 'the held spin was not scheduled for a retry');
  retries[0]();
  assert.equal(await until(() => casino.server.recorded.length === 1), true, 'the retried spin was not recorded');
  await settled(view);
});

// -- A link of the recording chain that throws does not stop the next one ------------------------------------------

test('a link of the recording chain that throws does not stop the next spin', async (t) => {
  overrideTimers(t);
  const casino = installFakeCasino({ unreadable: ['stop'] });
  const render = installHarness();
  t.after(() => render.unmount());
  const view = () => render('game', true);

  view();
  casino.hello();
  assert.equal(await until(() => view().availability === 'on'), true, 'recording never reported on');
  view().record(spin('17'));
  assert.equal(await until(() => casino.server.recorded.length === 1), true, 'the first spin was not recorded');

  view().stop(); // the Stop link reads Casino's answer, which cannot be read, so the link throws
  assert.equal(await until(() => view().problem === 'the Casino answer could not be read.'), true,
    'the failure in the link was not stated');

  view().record(spin('8'));
  assert.equal(await until(() => casino.server.recorded.length === 2), true,
    'a link that threw stopped the next spin from being recorded');
  await settled(view);
});
