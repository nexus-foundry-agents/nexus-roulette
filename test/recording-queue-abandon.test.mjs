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

// Review round 5 tests. They live in their own file because recording-queue.test.mjs is at its line cap.
// The bundle concatenates the source files into one scope, so the recording hook reads the queue's functions
// as globals. The hook harness below is a cut-down copy of the one in recording-queue.test.mjs: it covers the Stop test only.
Object.assign(globalThis, { createSpinQueue, spinsDroppedCopy, spinsNotSavedCopy, spinsWaitingCopy });

const spin = (segment) => ({ segment, staked: 5, returned: 0, watched: false });

async function until(check, limit = 2000) {
  for (let i = 0; i < limit; i += 1) {
    if (check()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return check();
}

// -- MEDIUM: an abandoned send that Casino refused definitively does not mark its head ambiguous ------------

// Casino's answer to a spin send: a sequence it already holds is answered recorded:false, any other is recorded.
function recordAsCasino(casino, payload) {
  const sequence = payload.spin.sequence;
  const repeat = casino.recorded.some((row) => row.sequence === sequence);
  if (!repeat) casino.recorded.push({ sequence, requestId: payload.spin.requestId, segment: payload.spin.segment });
  return {
    ok: true,
    status: 201,
    body: { recorded: !repeat, session: { id: 's1', status: 'running', spins: casino.recorded.length } },
  };
}

test('ROUND-5 MEDIUM: an abandoned send Casino refused with a stale sequence is renumbered on reopen, recorded once, and never dropped as confirmed', async () => {
  // Another device already holds sequence 1. Our first send is in flight when the view closes, and Casino refuses it.
  const casino = { recorded: [{ sequence: 1, requestId: 'another-device', segment: '8' }], sent: [], held: [] };
  const confirmed = [];
  const timers = [];
  const queue = createSpinQueue({
    resolveSession: async () => ({ ok: true, session: { id: 's1', status: 'running', spins: 0 } }),
    send: (op, payload) => {
      casino.sent.push(structuredClone(payload));
      if (casino.sent.length === 1) return new Promise((resolve) => { casino.held.push(resolve); });
      return Promise.resolve(recordAsCasino(casino, payload));
    },
    wait: async () => {},
    pauseRequested: () => false,
    report: () => {},
    confirmed: (body, info) => { confirmed.push(info); },
    recordingOff: () => {},
    reread: async () => ({ ok: true, session: { id: 's1', status: 'running', spins: casino.recorded.length } }),
    ended: () => {},
    drained: () => {},
    schedule: (callback) => { timers.push(callback); return () => {}; },
  });

  queue.enqueue(spin('17'));
  const first = queue.flush();
  assert.equal(await until(() => casino.held.length === 1), true, 'the first send was not made');
  queue.dispose(); // the view closes while the send is in flight
  casino.held[0]({ ok: false, status: 409, body: { error: 'stale_sequence' }, error: 'that sequence is taken' });
  assert.equal(await first, false, 'the closed round confirmed a spin');

  queue.reopen(); // the view mounts again on the same recorder
  assert.equal(await until(() => confirmed.length > 0 || timers.length > 0), true,
    'the reopened round neither confirmed nor held the spin');
  assert.deepEqual(confirmed, [], 'Casino refusing the sequence was read as proof that the spin was already recorded');
  assert.equal(timers.length, 1, 'the refused spin was not held for a retry');

  timers[0](); // the retry timer sends the spin under the number Casino's count gives it
  assert.equal(await until(() => confirmed.length === 1), true, 'the spin was not confirmed after the retry');
  assert.deepEqual(casino.recorded.map((row) => [row.sequence, row.segment]), [[1, '8'], [2, '17']],
    'the spin was not recorded once under a free number');
  assert.deepEqual(confirmed, [{ reconciled: false, pauseCarried: false }]);
  assert.deepEqual(casino.sent.map((payload) => payload.spin.sequence), [1, 1, 2]);
  assert.equal(new Set(casino.sent.map((payload) => payload.spin.requestId)).size, 1, 'a retry used a new request id');
});

// -- LOW: a Stop whose call to Casino throws ----------------------------------------------------------------

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

// A fake Casino shell for the calls a held recording makes. With throwOnStop, the first stop call throws inside the
// bridge, before any answer is posted, so the hook's askCasino rejects.
function installFakeCasino({ throwOnStop = false } = {}) {
  const shell = {};
  const server = { recorded: [], spinCalls: 0, failNext: 0, stops: 0, throwOnStop, status: 'running' };

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
    if (op === 'settings') return reply(message, 200, { settings: { recordingEnabled: true } });
    if (op === 'history') return reply(message, 200, { running: {} });
    if (op === 'start') {
      server.status = 'running';
      return reply(message, 201, { session: sessionNow() });
    }
    if (op === 'spin') {
      server.spinCalls += 1;
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
      server.stops += 1;
      server.status = 'stopped';
      return reply(message, 200, { session: sessionNow() });
    }
    return reply(message, 400, undefined, 'unknown operation');
  }

  shell.postMessage = (message, targetOrigin) => {
    if (!message || message.kind !== CASINO_BRIDGE_REQUEST || targetOrigin !== CASINO_SHELL_ORIGIN) return;
    if (message.op === 'stop' && server.throwOnStop) {
      server.throwOnStop = false;
      throw new Error('the Casino bridge refused the stop call.');
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

// Hooks run as plain functions here, as in recording-queue.test.mjs.
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

test('ROUND-5 LOW: a Stop whose Casino call throws shows the failure, and the next discard does not repeat a refusal from it', async (t) => {
  // The ten-second retry is never run here, so the held queue stays held until the test discards it.
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    if (milliseconds === SPIN_RETRY_MS) return 0;
    if (milliseconds >= 5000) return 0;
    return realSetTimeout(() => callback(...args), 0);
  };
  globalThis.clearTimeout = (handle) => { if (handle) realClearTimeout(handle); };

  const casino = installFakeCasino({ throwOnStop: true });
  const render = installHarness();
  t.after(() => { render.unmount(); restoreGlobals(); });
  const view = () => render('game', true);

  view();
  casino.hello();
  assert.equal(await until(() => view().availability === 'on'), true, 'recording never reported on');

  // The first spin fails on all three attempts, so the queue is held.
  casino.server.failNext = 3;
  view().record(spin('17'));
  assert.equal(await until(() => casino.server.spinCalls === 3 && /^1 spin waiting/.test(view().problem)), true,
    'the spin was not held');

  view().stop(); // the first press offers the discard
  assert.equal(await until(() => /Press Stop again to discard 1 unsent spin/.test(view().problem)), true,
    'Stop did not offer the discard');

  view().stop(); // the second press starts the discard, and its Stop call to Casino throws
  view().record(spin('8')); // a spin made while the discard runs is refused and counted for the discard
  assert.equal(view().problem, '1 spin was not saved to Casino: recording is stopping.',
    'the spin made during the discard was not refused');
  assert.equal(await until(() => view().problem === 'the Casino bridge refused the stop call. 1 spin was not saved to Casino: recording is stopping.'),
    true, 'the failure of Stop was not shown');
  assert.equal(view().session.status, 'running', 'a Stop that failed changed the session');
  assert.equal(casino.server.spinCalls, 3, 'a spin made during the discard was sent');

  // A later Stop that discards states only its own refusals: the earlier refusal is not stated again.
  casino.server.failNext = 3;
  view().record(spin('3'));
  assert.equal(await until(() => casino.server.spinCalls === 6 && /^1 spin waiting/.test(view().problem)), true,
    'the next spin was not held');
  view().stop();
  assert.equal(await until(() => /Press Stop again to discard 1 unsent spin/.test(view().problem)), true,
    'the next Stop did not offer the discard');
  view().stop();
  assert.equal(await until(() => view().session && view().session.status === 'stopped'), true,
    'the next discard did not stop the recording');
  assert.equal(view().problem, '1 spin may have been saved to Casino: recording was stopped.',
    'the next discard repeated a refusal from the Stop that failed');
});
