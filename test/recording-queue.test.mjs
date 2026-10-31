import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CASINO_BRIDGE_HELLO,
  CASINO_BRIDGE_REQUEST,
  CASINO_BRIDGE_RESPONSE,
  CASINO_SHELL_ORIGIN,
  SPIN_RETRY_MS,
  createSpinQueue,
  spinsWaitingCopy,
  useCasinoRecording,
} from '../nexus-src/src/casino-recording.mjs';

// -- A fake Casino shell and a one-component hook harness ---------------------------------------
// The recording hook talks to its parent frame over postMessage and keeps state in React hooks.
// The fakes below answer exactly the contract the shell answers: origin- and source-pinned replies,
// one session, and a server that records each sequence once (a repeat answers recorded:false).

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realWindow = globalThis.window;
const realReact = globalThis.React;
const realUseState = globalThis.useState;
const realUseEffect = globalThis.useEffect;

function installFakeCasino() {
  const shell = {};
  const listeners = [];
  const server = { recorded: [], sent: [], failNext: 0, spinCalls: 0, pending: 0 };

  function deliver(data) {
    listeners.slice().forEach((listener) => listener({ origin: CASINO_SHELL_ORIGIN, source: shell, data }));
  }
  // `pending` counts answers not yet delivered, so a test can wait for the bridge to go quiet.
  function reply(message, status, body, error) {
    const ok = status >= 200 && status < 300;
    server.pending += 1;
    setImmediate(() => {
      server.pending -= 1;
      deliver({ kind: CASINO_BRIDGE_RESPONSE, id: message.id, ok, status, body, error });
    });
  }
  function serve(message) {
    const { op, payload } = message;
    if (op === 'settings') return reply(message, 200, { settings: { recordingEnabled: true } });
    if (op === 'history') return reply(message, 200, { running: {} });
    if (op === 'start') return reply(message, 201, { session: { id: 's1', status: 'running', spins: server.recorded.length } });
    if (op === 'spin') {
      server.spinCalls += 1;
      server.sent.push(payload);
      if (server.failNext > 0) {
        server.failNext -= 1;
        return reply(message, 0, undefined, 'network down');
      }
      const sequence = payload.spin.sequence;
      const repeat = server.recorded.some((row) => row.sequence === sequence);
      if (!repeat) {
        server.recorded.push({ sequence, requestId: payload.spin.requestId, segment: payload.spin.segment });
      }
      return reply(message, 201, { recorded: !repeat, session: { id: 's1', status: 'running', spins: server.recorded.length } });
    }
    return reply(message, 400, undefined, 'unknown operation');
  }

  shell.postMessage = (message) => {
    if (message && message.kind === CASINO_BRIDGE_REQUEST) serve(message);
  };
  globalThis.window = {
    parent: shell,
    addEventListener(type, listener) { if (type === 'message') listeners.push(listener); },
  };
  return {
    server,
    hello() { deliver({ kind: CASINO_BRIDGE_HELLO, gameId: 'roulette' }); },
  };
}

function installHarness() {
  const slots = [];
  let cursor = 0;
  let mounted = false;
  let effects = [];
  globalThis.React = {
    useRef(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback(fn) { cursor += 1; return fn; },
  };
  globalThis.useState = (initial) => {
    const index = cursor++;
    if (!slots[index]) slots[index] = { value: initial };
    const slot = slots[index];
    return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
  };
  globalThis.useEffect = (effect) => {
    cursor += 1;
    if (!mounted) effects.push(effect);
  };
  return function render(mode, active) {
    cursor = 0;
    const view = useCasinoRecording(mode, active);
    if (!mounted) {
      mounted = true;
      effects.forEach((effect) => effect());
      effects = [];
    }
    return view;
  };
}

async function until(check, limit = 2000) {
  for (let i = 0; i < limit; i += 1) {
    if (check()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return check();
}

function restoreGlobals() {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  globalThis.window = realWindow;
  globalThis.React = realReact;
  globalThis.useState = realUseState;
  globalThis.useEffect = realUseEffect;
}

// Short waits (the 1 s and 2 s retry gaps) run at once. Long timers never fire here: the 10 s
// background retry and the 12 s bridge timeouts are not part of this harness, and a retry must only
// run when a test calls it, so an answered request cannot be settled by its own timeout.
globalThis.setTimeout = (callback, milliseconds, ...args) => {
  if (milliseconds >= 5000) return 0;
  return realSetTimeout(() => callback(...args), 0);
};
globalThis.clearTimeout = (handle) => { if (handle) realClearTimeout(handle); };

const spin = (segment) => ({ segment, staked: 5, returned: 0, watched: false });

test('a spin recorded while an earlier send is unconfirmed waits behind it and is never dropped', async (t) => {
  t.after(restoreGlobals);
  const casino = installFakeCasino();
  const render = installHarness();
  const view = () => render('game', true);

  // Mount first: the hook installs its bridge listener in its first effect, then the shell says hello.
  view();
  casino.hello();
  assert.equal(await until(() => view().availability === 'on'), true, 'recording never reported on');

  // Spin A: its send fails on all three attempts, so it stays unconfirmed.
  casino.server.failNext = 3;
  view().record(spin('17'));
  assert.equal(await until(() => casino.server.spinCalls === 3 && /^1 spin waiting/.test(view().problem)), true);

  // Spin B is recorded while A is still unconfirmed; A's send fails again on all three attempts.
  casino.server.failNext = 3;
  view().record(spin('8'));
  assert.equal(await until(() => casino.server.spinCalls === 6 && /^2 spins waiting/.test(view().problem)), true);
  const problemWhileWaiting = view().problem;

  // Casino answers again: A confirms, then B and C follow in order. The wait ends only when C's answer
  // has been delivered and the bridge is quiet, so no answer can arrive after the test has ended.
  casino.server.failNext = 0;
  view().record(spin('3'));
  await until(() => casino.server.recorded.length === 3 && casino.server.pending === 0 && view().problem === null);
  assert.equal(casino.server.pending, 0, 'an answer was still in flight when the test ended');

  assert.deepEqual(casino.server.recorded.map((row) => row.segment), ['17', '8', '3'],
    'the spin recorded while A was unconfirmed never reached the recorder');
  assert.deepEqual(casino.server.recorded.map((row) => row.sequence), [1, 2, 3]);
  const retriesOfA = casino.server.sent.filter((payload) => payload.spin.sequence === 1);
  assert.ok(retriesOfA.length >= 4, 'A was not retried after its failures');
  assert.equal(new Set(retriesOfA.map((payload) => payload.spin.requestId)).size, 1,
    'a retry of A carried a different request id');
  assert.match(problemWhileWaiting, /^2 spins waiting to send to Casino\./);
  assert.equal(view().problem, null);
});

// -- The queue on its own: ordering, retries, refusal and the background drain ------------------

// A stand-in for Casino's spin endpoint. Each spin send takes the next outcome from `script`:
// 'ok' records it, 'fail' is a send that never reached Casino, 'lost' is a send Casino recorded
// whose reply never arrived, and 'off' is a recording-disabled refusal. A repeated sequence is
// answered recorded:false, the same way Casino answers a retry it has already stored.
function casinoStub(script = []) {
  const stub = { recorded: [], sent: [], script: [...script] };
  stub.send = async (op, payload) => {
    if (op !== 'spin') throw new Error('unexpected operation ' + op);
    stub.sent.push(structuredClone(payload));
    const outcome = stub.script.length ? stub.script.shift() : 'ok';
    if (outcome === 'fail') return { ok: false, status: 0, error: 'network down' };
    if (outcome === 'off') return { ok: false, status: 409, body: { error: 'recording_disabled' } };
    const sequence = payload.spin.sequence;
    const repeat = stub.recorded.some((row) => row.sequence === sequence);
    if (!repeat) stub.recorded.push({ sequence, requestId: payload.spin.requestId, segment: payload.spin.segment });
    if (outcome === 'lost') return { ok: false, status: 0, error: 'reply lost' };
    return { ok: true, status: 201, body: { recorded: !repeat, session: { id: 's1', status: 'running', spins: stub.recorded.length } } };
  };
  return stub;
}

function queueRig({ sessionSpins = 0, script = [], resolutions = [], pauseRequested = false, preRecorded = [] } = {}) {
  const casino = casinoStub(script);
  casino.recorded.push(...preRecorded);
  const reports = [];
  const confirmed = [];
  const off = [];
  const timers = [];
  const session = { id: 's1', status: 'running', spins: sessionSpins };
  let queue = null;
  queue = createSpinQueue({
    resolveSession: async () => (resolutions.length ? resolutions.shift() : { ok: true, session }),
    send: casino.send,
    wait: async () => {},
    pauseRequested: () => pauseRequested,
    report: (text) => { reports.push(text); },
    confirmed: (body) => { confirmed.push(body); if (body && body.session) queue.observe(body.session); },
    recordingOff: (count) => { off.push(count); },
    schedule: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  });
  queue.observe(session);
  return { queue, casino, reports, confirmed, off, timers };
}

test('the problem line counts spins with the words Casino uses', () => {
  assert.equal(spinsWaitingCopy(1), '1 spin waiting to send to Casino.');
  assert.equal(spinsWaitingCopy(3), '3 spins waiting to send to Casino.');
});

test('spins are sent in spin order and numbered on from the server count', async () => {
  const rig = queueRig({ sessionSpins: 4 });
  rig.queue.enqueue(spin('17'));
  rig.queue.enqueue(spin('8'));
  rig.queue.enqueue(spin('3'));
  assert.equal(await rig.queue.flush(), true);
  assert.deepEqual(rig.casino.recorded.map((row) => row.sequence), [5, 6, 7]);
  assert.deepEqual(rig.casino.recorded.map((row) => row.segment), ['17', '8', '3']);
  assert.equal(rig.queue.waiting(), 0);
  assert.equal(rig.reports.at(-1), null);
});

test('a spin that is never confirmed keeps the earlier spins waiting, and the line says how many', async () => {
  const rig = queueRig({ script: ['fail', 'fail', 'fail', 'fail', 'fail', 'fail'] });
  rig.queue.enqueue(spin('17'));
  assert.equal(await rig.queue.flush(), false);
  assert.match(rig.reports.at(-1), /^1 spin waiting to send to Casino\. Casino still has not confirmed that spin/);
  rig.queue.enqueue(spin('8'));
  assert.equal(await rig.queue.flush(), false);
  assert.match(rig.reports.at(-1), /^2 spins waiting to send to Casino\. /);
  assert.equal(rig.queue.waiting(), 2);
  assert.equal(rig.casino.sent.length, 6, 'the earlier spin was retried on every flush, and the later one was not sent ahead of it');
  assert.deepEqual(rig.casino.recorded, []);
});

test('a background retry drains the queue in order once the earlier spin is confirmed', async () => {
  const rig = queueRig({ script: ['fail', 'fail', 'fail'] });
  rig.queue.enqueue(spin('17'));
  rig.queue.enqueue(spin('8'));
  assert.equal(await rig.queue.flush(), false);
  const retries = rig.timers.filter((timer) => !timer.cancelled);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].milliseconds, SPIN_RETRY_MS);
  retries[0].callback();
  assert.equal(await rig.queue.flush(), true);
  assert.deepEqual(rig.casino.recorded.map((row) => row.segment), ['17', '8']);
  assert.deepEqual(rig.casino.recorded.map((row) => row.sequence), [1, 2]);
  assert.equal(rig.reports.at(-1), null);
});

test('every retry of a spin resends the identical payload, so its sequence and request id never change', async () => {
  const rig = queueRig({ script: ['fail', 'ok'] });
  rig.queue.enqueue(spin('17'));
  assert.equal(await rig.queue.flush(), true);
  assert.equal(rig.casino.sent.length, 2);
  assert.deepEqual(rig.casino.sent[1], rig.casino.sent[0]);
  assert.equal(rig.casino.recorded.length, 1);
});

test('a send Casino may have recorded is reconciled by a later flush, not read as a stale sequence', async () => {
  const rig = queueRig({ script: ['lost', 'fail', 'fail', 'ok'] });
  rig.queue.enqueue(spin('17'));
  assert.equal(await rig.queue.flush(), false, 'the first flush ends unconfirmed');
  assert.equal(await rig.queue.flush(), true, 'the next flush reconciles the same sequence');
  assert.equal(rig.casino.recorded.length, 1);
  assert.equal(rig.casino.sent[3].spin.sequence, 1);
  assert.equal(rig.casino.sent[3].spin.requestId, rig.casino.sent[0].spin.requestId);
});

test('CONTROL: a duplicate sequence no send of ours made is still refused, not mistaken for our spin', async () => {
  const rig = queueRig({ preRecorded: [{ sequence: 1, requestId: 'another-device', segment: '8' }] });
  rig.queue.enqueue(spin('17'));
  assert.equal(await rig.queue.flush(), false);
  assert.match(rig.reports.at(-1), /already existed before this spin/);
  assert.equal(rig.queue.waiting(), 1);
});

test('a recording refusal discards every queued spin and says how many were not saved', async () => {
  const rig = queueRig({ script: ['off'] });
  rig.queue.enqueue(spin('17'));
  rig.queue.enqueue(spin('8'));
  assert.equal(await rig.queue.flush(), false);
  assert.deepEqual(rig.off, [2]);
  assert.equal(rig.queue.waiting(), 0);
  assert.equal(rig.casino.sent.length, 1, 'the spins behind a refusal were not sent');
});

test('a start that fails keeps the spin queued until a session opens, then sends it as sequence 1', async () => {
  const rig = queueRig({ resolutions: [{ ok: false, error: 'network down' }] });
  rig.queue.enqueue(spin('17'));
  assert.equal(await rig.queue.flush(), false);
  assert.match(rig.reports.at(-1), /^1 spin waiting to send to Casino\. network down$/);
  assert.equal(await rig.queue.flush(), true);
  assert.deepEqual(rig.casino.recorded.map((row) => row.sequence), [1]);
});

test('a start refused for recording discards the spin with the count', async () => {
  const rig = queueRig({ resolutions: [{ ok: false, off: true }] });
  rig.queue.enqueue(spin('17'));
  assert.equal(await rig.queue.flush(), false);
  assert.deepEqual(rig.off, [1]);
  assert.equal(rig.queue.waiting(), 0);
});

test('CONTROL: a confirmed spin is never sent again when a later spin follows it', async () => {
  const rig = queueRig();
  rig.queue.enqueue(spin('17'));
  assert.equal(await rig.queue.flush(), true);
  rig.queue.enqueue(spin('8'));
  assert.equal(await rig.queue.flush(), true);
  assert.deepEqual(rig.casino.sent.map((payload) => payload.spin.sequence), [1, 2]);
  assert.deepEqual(rig.casino.recorded.map((row) => row.segment), ['17', '8']);
});

test('a pause requested with a spin rides on that spin and stays on every retry of it', async () => {
  const rig = queueRig({ pauseRequested: true, script: ['fail', 'ok'] });
  rig.queue.enqueue(spin('17'));
  assert.equal(await rig.queue.flush(), true);
  assert.equal(rig.casino.sent.length, 2);
  assert.equal(rig.casino.sent[0].spin.pauseAfter, true);
  assert.deepEqual(rig.casino.sent[1], rig.casino.sent[0]);
});

test('repeats of the same number are separate spins, each with its own sequence and request id', async () => {
  const rig = queueRig({ script: ['fail', 'ok', 'ok'] });
  rig.queue.enqueue(spin('17'));
  rig.queue.enqueue(spin('17'));
  assert.equal(await rig.queue.flush(), true);
  assert.deepEqual(rig.casino.recorded.map((row) => row.segment), ['17', '17']);
  assert.deepEqual(rig.casino.recorded.map((row) => row.sequence), [1, 2]);
  assert.equal(new Set(rig.casino.recorded.map((row) => row.requestId)).size, 2);
});
