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

// The bundle concatenates the source files into one scope, so the recording hook reads the queue's functions
// as globals. The harness provides them the same way it provides React below.
Object.assign(globalThis, { createSpinQueue, spinsDroppedCopy, spinsNotSavedCopy, spinsWaitingCopy });

// -- A fake Casino shell and a one-component hook harness ---------------------------------------
// The recording hook talks to its parent frame over postMessage and keeps state in React hooks.
// The fakes below answer exactly the contract the shell answers: origin- and source-pinned replies,
// one session, and a server that records each sequence once (a repeat answers recorded:false).

const realWindow = globalThis.window;
const realReact = globalThis.React;
const realUseState = globalThis.useState;
const realUseEffect = globalThis.useEffect;

// The bridge keeps one message listener for the process (casino-recording.mjs installs it once), so every
// fake shell delivers into this one list.
const bridgeListeners = [];

// honourPauseAfter: a spin that carries pauseAfter pauses the session when it is recorded, as Casino does.
// refuseWhilePaused: a spin sent to a paused session is refused with a 4xx, as a definitive refusal.
function installFakeCasino({ running = false, honourPauseAfter = false, refuseWhilePaused = false } = {}) {
  const shell = {};
  const server = {
    recorded: [], sent: [], failNext: 0, spinCalls: 0, pending: 0,
    status: 'running', pauses: 0, resumes: 0, stops: 0, holdReplies: false, heldReplies: [],
  };

  function deliver(data) {
    bridgeListeners.slice().forEach((listener) => listener({ origin: CASINO_SHELL_ORIGIN, source: shell, data }));
  }
  // `pending` counts answers not yet delivered, so a test can wait for the bridge to go quiet.
  function reply(message, status, body, error) {
    const ok = status >= 200 && status < 300;
    server.pending += 1;
    const answer = () => {
      server.pending -= 1;
      deliver({ kind: CASINO_BRIDGE_RESPONSE, id: message.id, ok, status, body, error });
    };
    // With holdReplies the answer waits until the test releases it, so a test can act while a send is in flight.
    if (server.holdReplies) server.heldReplies.push(answer); else setImmediate(answer);
  }
  const sessionNow = () => ({ id: 's1', status: server.status, spins: server.recorded.length });
  function serve(message) {
    const { op, payload } = message;
    if (op === 'settings') return reply(message, 200, { settings: { recordingEnabled: true } });
    if (op === 'history') {
      return reply(message, 200, { running: running && server.status !== 'stopped' ? { game: sessionNow() } : {} });
    }
    if (op === 'start') {
      server.status = 'running';
      return reply(message, 201, { session: sessionNow() });
    }
    if (op === 'spin') {
      server.spinCalls += 1;
      server.sent.push(payload);
      if (refuseWhilePaused && server.status === 'paused') {
        return reply(message, 409, { error: 'session_paused' }, 'session is paused');
      }
      if (server.failNext > 0) {
        server.failNext -= 1;
        return reply(message, 0, undefined, 'network down');
      }
      const sequence = payload.spin.sequence;
      const repeat = server.recorded.some((row) => row.sequence === sequence);
      if (!repeat) server.recorded.push({ sequence, requestId: payload.spin.requestId, segment: payload.spin.segment });
      if (!repeat && honourPauseAfter && payload.spin.pauseAfter === true) {
        server.status = 'paused';
        server.pauses += 1;
      }
      return reply(message, 201, { recorded: !repeat, session: sessionNow() });
    }
    if (op === 'pause') {
      server.pauses += 1;
      server.status = 'paused';
      return reply(message, 200, { session: sessionNow() });
    }
    if (op === 'resume') {
      server.resumes += 1;
      server.status = 'running';
      return reply(message, 200, { session: sessionNow() });
    }
    if (op === 'stop') {
      server.stops += 1;
      server.status = 'stopped';
      return reply(message, 200, { session: sessionNow() });
    }
    return reply(message, 400, undefined, 'unknown operation');
  }

  // A request is answered only when it is addressed to the shell's origin, as the bridge requires.
  shell.postMessage = (message, targetOrigin) => {
    if (message && message.kind === CASINO_BRIDGE_REQUEST && targetOrigin === CASINO_SHELL_ORIGIN) serve(message);
  };
  globalThis.window = {
    parent: shell,
    addEventListener(type, listener) { if (type === 'message') bridgeListeners.push(listener); },
  };
  return {
    server,
    hello() { deliver({ kind: CASINO_BRIDGE_HELLO, gameId: 'roulette' }); },
    releaseOne() { const answer = server.heldReplies.shift(); if (answer) answer(); },
  };
}

// Hooks run as plain functions here. useState keeps its value in a slot. useCallback and useEffect compare
// their dependencies as React does, so a callback keeps its identity and an effect runs only when its inputs
// change. `unmount` runs every effect's cleanup, which is what closing the view does.
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
  // A remount keeps the state and sets every effect up again on the next render, as React StrictMode does.
  render.remount = () => {
    effects.forEach((slot) => { if (slot) slot.deps = undefined; });
  };
  return render;
}

async function until(check, limit = 2000) {
  for (let i = 0; i < limit; i += 1) {
    if (check()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return check();
}

function restoreGlobals() {
  globalThis.window = realWindow;
  globalThis.React = realReact;
  globalThis.useState = realUseState;
  globalThis.useEffect = realUseEffect;
}

// The clock is not run in these tests. Short waits (the retry gaps of one and two seconds) run at once. The
// ten-second spin retry is held until a test fires it, so a retry round runs only when a test asks for one.
// The bridge's twelve-second timeouts never fire.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const retryTimers = new Map();
let retryTimerId = 0;
globalThis.setTimeout = (callback, milliseconds, ...args) => {
  if (milliseconds === SPIN_RETRY_MS) {
    retryTimerId += 1;
    retryTimers.set(retryTimerId, () => callback(...args));
    return retryTimerId;
  }
  if (milliseconds >= 5000) return 0;
  return realSetTimeout(() => callback(...args), 0);
};
globalThis.clearTimeout = (handle) => {
  if (!handle) return;
  if (retryTimers.delete(handle)) return;
  realClearTimeout(handle);
};
// Runs every held retry once, and returns how many there were.
function fireRetries() {
  const pendingRetries = [...retryTimers.values()];
  retryTimers.clear();
  pendingRetries.forEach((run) => run());
  return pendingRetries.length;
}

const spin = (segment) => ({ segment, staked: 5, returned: 0, watched: false });

test('a spin recorded before the shell says hello waits for it, then is sent as sequence 1', async (t) => {
  const casino = installFakeCasino();
  const render = installHarness();
  t.after(() => { render.unmount(); restoreGlobals(); });
  const view = () => render('game', true);

  view().record(spin('17'));
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(casino.server.spinCalls, 0, 'a spin was sent before the shell said hello');

  casino.hello();
  assert.equal(await until(() => casino.server.recorded.length === 1 && view().problem === null), true,
    'the spin was not recorded after hello');
  assert.deepEqual(casino.server.recorded.map((row) => [row.sequence, row.segment]), [[1, '17']]);
});

test('a spin recorded while an earlier send is unconfirmed waits behind it and is never dropped', async (t) => {
  const casino = installFakeCasino();
  const render = installHarness();
  t.after(() => { render.unmount(); restoreGlobals(); });
  const view = () => render('game', true);

  // Mount first: the hook installs its bridge listener in its first effect, then the shell says hello.
  view();
  casino.hello();
  assert.equal(await until(() => view().availability === 'on'), true, 'recording never reported on');

  // Spin A: its send fails on all three attempts, so it stays unconfirmed and its retry is armed.
  casino.server.failNext = 3;
  view().record(spin('17'));
  assert.equal(await until(() => casino.server.spinCalls === 3 && /^1 spin waiting/.test(view().problem)), true);

  // Spins B and C are recorded while A is unconfirmed. A held queue only takes them: no send is made until the retry.
  view().record(spin('8'));
  view().record(spin('3'));
  assert.equal(await until(() => /^3 spins waiting/.test(view().problem)), true);
  assert.equal(casino.server.spinCalls, 3, 'a spin recorded on a held queue started a retry round');
  const problemWhileWaiting = view().problem;

  // Casino answers again. The retry timer sends A, then B and C in order.
  casino.server.failNext = 0;
  assert.equal(fireRetries(), 1, 'the retry was not armed once');
  await until(() => casino.server.recorded.length === 3 && casino.server.pending === 0 && view().problem === null);
  assert.equal(casino.server.pending, 0, 'an answer was still in flight when the test ended');

  assert.deepEqual(casino.server.recorded.map((row) => row.segment), ['17', '8', '3'],
    'the spin recorded while A was unconfirmed never reached the recorder');
  assert.deepEqual(casino.server.recorded.map((row) => row.sequence), [1, 2, 3]);
  const retriesOfA = casino.server.sent.filter((payload) => payload.spin.sequence === 1);
  assert.ok(retriesOfA.length >= 4, 'A was not retried after its failures');
  assert.equal(new Set(retriesOfA.map((payload) => payload.spin.requestId)).size, 1,
    'a retry of A carried a different request id');
  assert.match(problemWhileWaiting, /^3 spins waiting to send to Casino\./);
  assert.equal(view().problem, null);
});

test('M1: Pause on a held queue answers at once, and the pause follows the spin once the queue drains', async (t) => {
  const casino = installFakeCasino();
  const render = installHarness();
  t.after(() => { render.unmount(); restoreGlobals(); });
  const view = () => render('game', true);

  view();
  casino.hello();
  assert.equal(await until(() => view().availability === 'on'), true, 'recording never reported on');

  casino.server.failNext = 3;
  view().record(spin('17'));
  assert.equal(await until(() => casino.server.spinCalls === 3 && /^1 spin waiting/.test(view().problem)), true);

  const before = casino.server.spinCalls;
  view().pause();
  assert.equal(await until(() => /will pause after they are confirmed/.test(view().problem)), true,
    'Pause did not answer while the spin waited');
  assert.equal(casino.server.spinCalls, before, 'Pause started a retry round of its own');
  assert.equal(casino.server.pauses, 0, 'Pause reached Casino before the queue had cleared');

  // Casino answers. The retry timer records the spin, and the pause is applied once the queue has drained.
  casino.server.failNext = 0;
  assert.equal(fireRetries(), 1, 'the retry timer was not armed');
  assert.equal(await until(() => casino.server.pauses === 1 && view().session && view().session.status === 'paused'), true,
    'the pause was not applied when the queue drained');
  assert.equal(casino.server.recorded.length, 1);
});

test('Stop on a held queue offers the discard with its count, and the second press discards and ends the recording', async (t) => {
  const casino = installFakeCasino();
  const render = installHarness();
  t.after(() => { render.unmount(); restoreGlobals(); });
  const view = () => render('game', true);

  view();
  casino.hello();
  assert.equal(await until(() => view().availability === 'on'), true, 'recording never reported on');

  casino.server.failNext = 3;
  view().record(spin('17'));
  assert.equal(await until(() => casino.server.spinCalls === 3 && /^1 spin waiting/.test(view().problem)), true);

  view().stop();
  assert.equal(await until(() => /Press Stop again to discard 1 unsent spin and end the recording\./.test(view().problem)),
    true, 'Stop did not offer the discard');
  assert.equal(casino.server.stops, 0, 'the first press ended the recording');

  view().stop();
  assert.equal(await until(() => casino.server.stops === 1), true, 'the second press did not end the recording');
  assert.equal(await until(() => view().problem === '1 spin may have been saved to Casino: discarded by Stop.'), true,
    'the discard was not stated with its count');
  assert.equal(casino.server.recorded.length, 0, 'a discarded spin reached Casino');
});

test('leaving the mode pauses the running session, and returning to it resumes that session', async (t) => {
  const casino = installFakeCasino({ running: true });
  const render = installHarness();
  t.after(() => { render.unmount(); restoreGlobals(); });
  const view = (active) => render('game', active);

  view(true);
  casino.hello();
  assert.equal(await until(() => view(true).session && view(true).session.status === 'running'), true,
    'the running session was not adopted');

  // Each check renders the hook again first, as React does after the hook's own state changes.
  const settleWith = (active, check) => until(() => { view(active); return check(); });
  view(false);
  assert.equal(await settleWith(false, () => casino.server.pauses === 1 && view(false).session.status === 'paused'), true,
    'leaving the mode did not pause the session');
  view(true);
  assert.equal(await settleWith(true, () => casino.server.resumes === 1 && view(true).session.status === 'running'), true,
    'returning to the mode did not resume the session');
});

// -- The queue on its own: ordering, retries, refusal and the background drain ------------------

// A stand-in for Casino's spin endpoint. Each spin send takes the next outcome from `script`:
// 'ok' records it, 'fail' is a send that never reached Casino, 'lost' is a send Casino recorded
// whose reply never arrived, 'off' is a recording-disabled refusal, 'gone' is a session Casino
// no longer has, and 'stopped' is a session Casino stopped. A repeated sequence is answered
// recorded:false, the same way Casino answers a retry it has already stored.
function casinoStub(script = []) {
  const stub = { recorded: [], sent: [], script: [...script] };
  stub.send = async (op, payload) => {
    if (op !== 'spin') throw new Error('unexpected operation ' + op);
    stub.sent.push(structuredClone(payload));
    const outcome = stub.script.length ? stub.script.shift() : 'ok';
    if (outcome === 'fail') return { ok: false, status: 0, error: 'network down' };
    if (outcome === 'off') return { ok: false, status: 409, body: { error: 'recording_disabled' } };
    if (outcome === 'gone') return { ok: false, status: 404, body: { error: 'session_not_found' } };
    if (outcome === 'stopped') return { ok: false, status: 409, body: { error: 'session_stopped' } };
    if (outcome === 'refuse') return { ok: false, status: 400, body: { error: 'bad_spin' } };
    const sequence = payload.spin.sequence;
    const repeat = stub.recorded.some((row) => row.sequence === sequence);
    if (!repeat) stub.recorded.push({ sequence, requestId: payload.spin.requestId, segment: payload.spin.segment });
    if (outcome === 'lost') return { ok: false, status: 0, error: 'reply lost' };
    return { ok: true, status: 201, body: { recorded: !repeat, session: { id: 's1', status: 'running', spins: stub.recorded.length } } };
  };
  return stub;
}

// `reread` answers the session check the queue makes after a definitive refusal. By default Casino
// still has the session running, with the spins it holds (including any another device recorded).
function queueRig({ sessionSpins = 0, script = [], resolutions = [], pauseRequested = false, preRecorded = [], reread = null } = {}) {
  const casino = casinoStub(script);
  casino.recorded.push(...preRecorded);
  const reports = [];
  const confirmed = [];
  const confirmedInfo = [];
  const off = [];
  const timers = [];
  const ended = [];
  const counts = { drained: 0 };
  const session = { id: 's1', status: 'running', spins: sessionSpins };
  let queue = null;
  queue = createSpinQueue({
    resolveSession: async () => (resolutions.length ? resolutions.shift() : { ok: true, session }),
    send: casino.send,
    wait: async () => {},
    pauseRequested: () => (typeof pauseRequested === 'function' ? pauseRequested() : pauseRequested),
    report: (text) => { reports.push(text); },
    confirmed: (body, info) => { confirmed.push(body); confirmedInfo.push(info); if (body && body.session) queue.observe(body.session); },
    recordingOff: (count) => { off.push(count); },
    reread: async () => (reread
      ? reread()
      : { ok: true, session: { id: 's1', status: 'running', spins: casino.recorded.length } }),
    ended: (current) => { ended.push(current); },
    drained: () => { counts.drained += 1; },
    schedule: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  });
  queue.observe(session);
  return { queue, casino, reports, confirmed, confirmedInfo, off, timers, ended, counts };
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

test('CONTROL: a duplicate sequence no send of ours made is refused, not mistaken for our spin, and the spin recovers on a new number', async () => {
  const rig = queueRig({ preRecorded: [{ sequence: 1, requestId: 'another-device', segment: '8' }] });
  rig.queue.enqueue(spin('17'));
  assert.equal(await rig.queue.flush(), false);
  assert.match(rig.reports.at(-1), /already existed before this spin/);
  assert.equal(rig.queue.waiting(), 1);
  // The session is live, so the refused spin takes the next number from Casino's count and keeps its request id.
  const retry = rig.timers.find((timer) => !timer.cancelled);
  assert.equal(retry.milliseconds, SPIN_RETRY_MS);
  retry.callback();
  assert.equal(await rig.queue.flush(), true);
  assert.deepEqual(rig.casino.recorded.map((row) => [row.sequence, row.segment]), [[1, '8'], [2, '17']]);
  assert.equal(rig.casino.sent.at(-1).spin.requestId, rig.casino.sent[0].spin.requestId);
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

// -- Round 2: a definitive refusal of the head, a sequence reused after recording was off, a held queue,
// -- a pause decided per send, and a queue closed by unmount ------------------------------------------

test('H1: a session Casino ended under the queue drops its spins and says how many were not saved', async () => {
  const rig = queueRig({ script: ['gone'], reread: async () => ({ ok: true, session: null }) });
  rig.queue.enqueue(spin('17'));
  rig.queue.enqueue(spin('8'));
  assert.equal(await rig.queue.flush(), false);
  assert.equal(rig.queue.waiting(), 0, 'the queued spins were kept and would be retried forever');
  assert.equal(rig.reports.at(-1), '2 spins were not saved to Casino: the session ended.');
  assert.deepEqual(rig.ended, [null]);
  assert.equal(rig.casino.sent.length, 1, 'the spin behind the refused one was sent');
  assert.equal(rig.timers.filter((timer) => !timer.cancelled).length, 0, 'a retry was armed for spins that no longer exist');
});

test('H1: a session Casino stopped drops its spins the same way, and the count is singular for one', async () => {
  const rig = queueRig({
    script: ['stopped'],
    reread: async () => ({ ok: true, session: { id: 's1', status: 'stopped', spins: 0 } }),
  });
  rig.queue.enqueue(spin('17'));
  assert.equal(await rig.queue.flush(), false);
  assert.equal(rig.queue.waiting(), 0);
  assert.equal(rig.reports.at(-1), '1 spin was not saved to Casino: the session ended.');
});

test('H1: a session that cannot be read again holds the spins and retries, and never drops them', async () => {
  const rig = queueRig({ script: ['gone'], reread: async () => ({ ok: false, error: 'network down' }) });
  rig.queue.enqueue(spin('17'));
  assert.equal(await rig.queue.flush(), false);
  assert.equal(rig.queue.waiting(), 1);
  assert.match(rig.reports.at(-1), /^1 spin waiting to send to Casino\. network down$/);
});

test('H2: a spin whose send may have been recorded keeps its number when recording is turned off and on again', async () => {
  // Round 1: the first send is recorded but its reply is lost, and two retries fail, so the spin stays unconfirmed.
  // Round 2: recording is off when the spin is sent again.
  const rig = queueRig({ script: ['lost', 'fail', 'fail', 'off'] });
  rig.queue.enqueue(spin('17'));
  assert.equal(await rig.queue.flush(), false, 'the lost reply leaves the spin unconfirmed');
  assert.equal(await rig.queue.flush(), false, 'recording is off on the retry');
  assert.deepEqual(rig.off, [1]);
  assert.equal(rig.queue.waiting(), 0);
  rig.queue.enqueue(spin('8'));
  assert.equal(await rig.queue.flush(), true, 'the next spin reused a number Casino already holds');
  assert.deepEqual(rig.casino.recorded.map((row) => [row.sequence, row.segment]), [[1, '17'], [2, '8']]);
});

test('M1: a held queue takes a new spin without sending or arming anything (queue level)', async () => {
  const rig = queueRig({ script: ['fail', 'fail', 'fail'] });
  rig.queue.enqueue(spin('17'));
  assert.equal(await rig.queue.flush(), false);
  const sentBefore = rig.casino.sent.length;
  const armedBefore = rig.timers.filter((timer) => !timer.cancelled).length;
  assert.equal(await rig.queue.submit(spin('8')), false);
  assert.equal(rig.casino.sent.length, sentBefore, 'a new spin started a retry round while the queue was held');
  assert.equal(rig.timers.filter((timer) => !timer.cancelled).length, armedBefore);
  assert.equal(rig.queue.waiting(), 2);
});

test('a held queue counts the spins that join it, and discard drops them all with their count', async () => {
  const rig = queueRig({ script: ['fail', 'fail', 'fail'] });
  rig.queue.enqueue(spin('17'));
  assert.equal(await rig.queue.flush(), false);
  await rig.queue.submit(spin('8'));
  assert.equal(rig.reports.at(-1), '2 spins waiting to send to Casino. Casino still has not confirmed that spin; it remains queued locally.');
  assert.equal(rig.queue.held(), true);
  const outcome = await rig.queue.discard();
  assert.equal(outcome.count, 2);
  // The head failed with status 0, which may have reached Casino, so it is counted as may have been saved.
  assert.equal(outcome.maybeSaved, 1);
  assert.equal(rig.queue.waiting(), 0);
  assert.equal(rig.queue.held(), false);
  assert.equal(rig.casino.sent.length, 3, 'discard sent a spin');
});

test('drained fires when the queue empties, and not while it is held', async () => {
  const rig = queueRig({ script: ['fail', 'fail', 'fail'] });
  rig.queue.enqueue(spin('17'));
  assert.equal(await rig.queue.flush(), false);
  assert.equal(rig.counts.drained, 0, 'the queue reported itself drained while it was held');
  rig.timers.find((timer) => !timer.cancelled).callback();
  assert.equal(await rig.queue.flush(), true);
  assert.equal(rig.counts.drained, 1);
});

test('M2: only the last queued spin carries a pause, so two spins do not both pause the session', async () => {
  const rig = queueRig({ pauseRequested: true });
  rig.queue.enqueue(spin('17'));
  rig.queue.enqueue(spin('8'));
  assert.equal(await rig.queue.flush(), true);
  assert.deepEqual(rig.casino.sent.map((payload) => payload.spin.pauseAfter === true), [false, true]);
});

test('M2: a retry after Resume does not carry the pause asked for before the first attempt', async () => {
  let intent = true;
  const rig = queueRig({ pauseRequested: () => intent, script: ['fail', 'fail', 'fail'] });
  rig.queue.enqueue(spin('17'));
  assert.equal(await rig.queue.flush(), false);
  intent = false; // the user pressed Resume while the spin was unconfirmed
  assert.equal(await rig.queue.flush(), true);
  const first = rig.casino.sent[0];
  const retry = rig.casino.sent.at(-1);
  assert.equal(retry.spin.sequence, first.spin.sequence);
  assert.equal(retry.spin.requestId, first.spin.requestId);
  assert.notEqual(retry.spin.pauseAfter, true, 'the retry carried a pause the user had cancelled');
});

test('M4: a send that answers after dispose writes no problem line and arms no retry', async () => {
  let calls = 0;
  let release = null;
  const reports = [];
  const timers = [];
  const queue = createSpinQueue({
    resolveSession: async () => ({ ok: true, session: { id: 's1', status: 'running', spins: 0 } }),
    send: () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { release = resolve; });
      return Promise.resolve({ ok: false, status: 0, error: 'network down' });
    },
    wait: async () => {},
    pauseRequested: () => false,
    report: (text) => { reports.push(text); },
    confirmed: () => { throw new Error('a confirmation was written after dispose'); },
    recordingOff: () => {},
    reread: async () => ({ ok: true, session: null }),
    ended: () => {},
    drained: () => {},
    schedule: (callback) => { timers.push(callback); return () => {}; },
  });
  queue.enqueue(spin('17'));
  const flushing = queue.flush();
  assert.equal(await until(() => calls === 1), true);
  queue.dispose();
  const reportsBefore = reports.length;
  release({ ok: false, status: 0, error: 'network down' });
  await flushing;
  assert.equal(reports.length, reportsBefore, 'a problem line was written after dispose');
  assert.equal(timers.length, 0, 'a retry was armed after dispose');
  assert.equal(await queue.flush(), false);
  assert.equal(calls, 3, 'a new round started after dispose');
});

test('M4: a send that succeeds after dispose confirms nothing and sends nothing behind it', async () => {
  let calls = 0;
  let release = null;
  let confirmations = 0;
  const reports = [];
  const queue = createSpinQueue({
    resolveSession: async () => ({ ok: true, session: { id: 's1', status: 'running', spins: 0 } }),
    send: () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { release = resolve; });
      return Promise.resolve({ ok: false, status: 0, error: 'network down' });
    },
    wait: async () => {},
    pauseRequested: () => false,
    report: (text) => { reports.push(text); },
    confirmed: () => { confirmations += 1; },
    recordingOff: () => {},
    reread: async () => ({ ok: true, session: null }),
    ended: () => {},
    drained: () => {},
    schedule: () => () => {},
  });
  queue.enqueue(spin('17'));
  queue.enqueue(spin('8'));
  const flushing = queue.flush();
  assert.equal(await until(() => calls === 1), true);
  queue.dispose();
  const reportsBefore = reports.length;
  release({ ok: true, status: 201, body: { recorded: true, session: { id: 's1', status: 'running', spins: 1 } } });
  await flushing;
  assert.equal(confirmations, 0, 'a confirmation was written after dispose');
  assert.equal(calls, 1, 'the spin behind it was sent after dispose');
  assert.equal(reports.length, reportsBefore, 'a problem line was written after dispose');
});

// -- Review round 3: the second review's defects. Each test failed on the round-2 code before its fix. ----

// A stand-in for the browser's localStorage, for the count a closed view leaves behind.
function fakeLocalStorage() {
  const items = new Map();
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => { items.set(key, String(value)); },
    removeItem: (key) => { items.delete(key); },
    get size() { return items.size; },
  };
}

// A queue whose sends wait for the test to answer them one at a time, so a test can act while a send is in flight.
function deferredQueue() {
  const sends = [];
  const reports = [];
  const confirmed = [];
  const timers = [];
  const queue = createSpinQueue({
    resolveSession: async () => ({ ok: true, session: { id: 's1', status: 'running', spins: 0 } }),
    send: (op, payload) => new Promise((resolve) => { sends.push({ op, payload, resolve }); }),
    wait: async () => {},
    pauseRequested: () => false,
    report: (text) => { reports.push(text); },
    confirmed: (body) => { confirmed.push(body); },
    recordingOff: () => {},
    reread: async () => ({ ok: true, session: { id: 's1', status: 'running', spins: 0 } }),
    ended: () => {},
    drained: () => {},
    schedule: (callback) => { timers.push(callback); return () => {}; },
  });
  return {
    queue, sends, reports, confirmed, timers,
    answer(result) { sends.shift().resolve(result); },
  };
}

test('HIGH 1: a first Stop on a held queue only offers the discard, so the retry that follows sends no pause', async (t) => {
  const casino = installFakeCasino({ honourPauseAfter: true });
  const render = installHarness();
  t.after(() => { render.unmount(); restoreGlobals(); });
  const view = () => render('game', true);

  view();
  casino.hello();
  assert.equal(await until(() => view().availability === 'on'), true, 'recording never reported on');

  casino.server.failNext = 3;
  view().record(spin('17'));
  assert.equal(await until(() => casino.server.spinCalls === 3 && /^1 spin waiting/.test(view().problem)), true);

  view().stop(); // the first press: the offer only
  assert.equal(await until(() => /Press Stop again to discard 1 unsent spin/.test(view().problem)), true);

  // The user walks away. The held spin is retried on the timer and must go out as a plain spin.
  casino.server.failNext = 0;
  assert.equal(fireRetries(), 1, 'the retry was not armed');
  assert.equal(await until(() => casino.server.recorded.length === 1 && view().problem === null), true,
    'the held spin was not recorded after the retry');
  assert.equal(casino.server.stops, 0, 'the first press ended the recording');
  assert.ok(casino.server.sent.every((payload) => payload.spin.pauseAfter !== true),
    'a retry carried a pause that nobody confirmed');
  assert.equal(casino.server.pauses, 0, 'Casino paused the session after a first Stop press');
  assert.equal(view().session.status, 'running');
});

test('HIGH 1: a confirmed Stop leaves no pause behind for the next session', async (t) => {
  const casino = installFakeCasino({ honourPauseAfter: true });
  const render = installHarness();
  t.after(() => { render.unmount(); restoreGlobals(); });
  const view = () => render('game', true);

  view();
  casino.hello();
  assert.equal(await until(() => view().availability === 'on'), true, 'recording never reported on');

  casino.server.failNext = 3;
  view().record(spin('17'));
  assert.equal(await until(() => casino.server.spinCalls === 3 && /^1 spin waiting/.test(view().problem)), true);
  view().stop();
  assert.equal(await until(() => /Press Stop again/.test(view().problem)), true);
  view().stop();
  assert.equal(await until(() => view().session && view().session.status === 'stopped'), true,
    'the second press did not end the recording');

  // The next spin starts a new session. Nothing carried over from the stopped one may pause it.
  casino.server.failNext = 0;
  view().record(spin('8'));
  assert.equal(await until(() => casino.server.recorded.length === 1 && view().problem === null), true,
    'the spin after the stop was not recorded');
  assert.equal(casino.server.pauses, 0, 'the spin after a confirmed Stop paused the new session');
  assert.ok(casino.server.sent.every((payload) => payload.spin.pauseAfter !== true),
    'a spin after a confirmed Stop carried a pause');
  assert.equal(view().session.status, 'running');
});

test('MEDIUM 1: a Stop during a send waits for it, and a spin Casino recorded is not counted as discarded', async () => {
  const rig = deferredQueue();
  rig.queue.enqueue(spin('17'));
  const first = rig.queue.flush();
  // Three failed attempts hold the head and arm the retry timer.
  for (let i = 0; i < 3; i += 1) {
    assert.equal(await until(() => rig.sends.length === 1), true, 'an attempt was not sent');
    rig.answer({ ok: false, status: 0, error: 'network down' });
  }
  assert.equal(await first, false);
  assert.equal(rig.timers.length, 1, 'the retry was not armed once');

  // The retry round starts, and Stop is pressed while its send is in flight. Casino records the spin.
  rig.timers[0]();
  assert.equal(await until(() => rig.sends.length === 1), true, 'the retry did not send');
  const stopping = rig.queue.discard();
  rig.answer({ ok: true, status: 201, body: { recorded: true, session: { id: 's1', status: 'running', spins: 1 } } });
  const outcome = await stopping;

  assert.equal(rig.confirmed.length, 1, 'the in-flight success was ignored');
  assert.ok(!rig.reports.some((text) => /not saved/.test(text)), 'a saved spin was stated as not saved');
  assert.equal(rig.sends.length, 0, 'a spin was sent after the Stop');
  assert.deepEqual(outcome, { count: 0, maybeSaved: 0 }, 'a spin Casino recorded was counted as discarded');
});

test('MEDIUM 1: a Stop that finds an ambiguous head counts it as may have been saved, and sends nothing behind it', async () => {
  const rig = deferredQueue();
  rig.queue.enqueue(spin('17'));
  rig.queue.enqueue(spin('8'));
  const first = rig.queue.flush();
  for (let i = 0; i < 3; i += 1) {
    assert.equal(await until(() => rig.sends.length === 1), true, 'an attempt was not sent');
    rig.answer({ ok: false, status: 0, error: 'timed out' });
  }
  assert.equal(await first, false);

  rig.timers[0]();
  assert.equal(await until(() => rig.sends.length === 1), true, 'the retry did not send');
  const stopping = rig.queue.discard();
  // The in-flight send has its first attempt pending. Its three attempts all time out, and nothing may follow them.
  for (let i = 0; i < 3; i += 1) {
    assert.equal(await until(() => rig.sends.length === 1), true, 'an attempt was not sent');
    rig.answer({ ok: false, status: 0, error: 'timed out' });
  }
  const outcome = await stopping;

  assert.deepEqual(outcome, { count: 2, maybeSaved: 1 }, 'the ambiguous head was not counted as may have been saved');
  assert.equal(rig.sends.length, 0, 'a spin was sent behind the discarded head');
});

test('MEDIUM 2: a head sent ambiguously keeps its sequence and request id when a later attempt is refused', async () => {
  // Attempt 1 is recorded but its reply is lost. Attempt 2 is refused with a 400, which is a definitive refusal.
  const rig = queueRig({ script: ['lost', 'refuse'] });
  rig.queue.enqueue(spin('17'));
  assert.equal(await rig.queue.flush(), false);
  rig.timers.find((timer) => !timer.cancelled).callback();
  assert.equal(await rig.queue.flush(), true);
  assert.deepEqual(rig.casino.recorded.map((row) => [row.sequence, row.segment]), [[1, '17']],
    'the spin was recorded twice under two numbers');
  assert.equal(new Set(rig.casino.sent.map((payload) => payload.spin.sequence)).size, 1, 'a retry used a new sequence');
  assert.equal(new Set(rig.casino.sent.map((payload) => payload.spin.requestId)).size, 1, 'a retry used a new request id');
});

test('MEDIUM 3: a paused session holds the head without renumbering it, and the line says so', async () => {
  let status = 'paused';
  const rig = queueRig({
    script: ['refuse', 'refuse', 'refuse'],
    reread: async () => ({ ok: true, session: { id: 's1', status, spins: 0 } }),
  });
  rig.queue.enqueue(spin('17'));
  rig.queue.enqueue(spin('8'));
  assert.equal(await rig.queue.flush(), false);
  assert.equal(rig.reports.at(-1), 'Casino recording is paused. Resume it to send 2 waiting spins.');
  assert.equal(await rig.queue.flush(), false);
  assert.equal(await rig.queue.flush(), false);
  assert.equal(rig.queue.waiting(), 2, 'a paused hold dropped a spin');
  assert.ok(!rig.reports.some((text) => /not saved/.test(text)), 'a paused hold stated a spin as not saved');

  status = 'running';
  assert.equal(await rig.queue.flush(), true);
  assert.deepEqual(rig.casino.recorded.map((row) => [row.sequence, row.segment]), [[1, '17'], [2, '8']]);
  const first = rig.casino.sent[0].spin.requestId;
  assert.ok(rig.casino.sent.filter((payload) => payload.spin.requestId === first).every((payload) => payload.spin.sequence === 1),
    'the paused hold renumbered the head');
});

test('MEDIUM 3: a live session that refuses the head three times drops that spin only, says so, and sends the spins behind it', async () => {
  const rig = queueRig({ script: ['refuse', 'refuse', 'refuse'] });
  rig.queue.enqueue(spin('17'));
  rig.queue.enqueue(spin('8'));
  assert.equal(await rig.queue.flush(), false, 'refusal 1 should hold the queue');
  assert.equal(await rig.queue.flush(), false, 'refusal 2 should hold the queue');
  assert.equal(await rig.queue.flush(), true, 'refusal 3 should drop the head and send the spin behind it');
  assert.deepEqual(rig.casino.recorded.map((row) => [row.sequence, row.segment]), [[1, '8']]);
  assert.equal(rig.queue.waiting(), 0);
  assert.equal(rig.reports.at(-1), '1 spin could not be saved to Casino: Casino did not record that spin (400).');
});

test('MEDIUM 3: a dropped head that may have been saved is stated as may have been saved, and the spin behind it takes a free number', async () => {
  const rig = queueRig({ script: ['lost', 'refuse', 'refuse', 'refuse'] });
  rig.queue.enqueue(spin('17'));
  rig.queue.enqueue(spin('8'));
  assert.equal(await rig.queue.flush(), false);
  assert.equal(await rig.queue.flush(), false);
  assert.equal(await rig.queue.flush(), true);
  assert.equal(rig.reports.at(-1), '1 spin may have been saved to Casino: Casino did not record that spin (400).');
  assert.deepEqual(rig.casino.recorded.map((row) => [row.sequence, row.segment]), [[1, '17'], [2, '8']],
    'the spin behind the dropped head reused a number the dropped head may hold');
});

test('MEDIUM 5: a reconciled spin reports that it carried a pause, so the hook can still apply it', async () => {
  const rig = queueRig({ pauseRequested: true, script: ['lost', 'ok'] });
  rig.queue.enqueue(spin('17'));
  assert.equal(await rig.queue.flush(), true);
  assert.equal(rig.confirmedInfo.length, 1);
  assert.deepEqual(rig.confirmedInfo[0], { reconciled: true, pauseCarried: true });
});

test('LOW: a spin made while recording is paused says it was not saved, with its count', async (t) => {
  const casino = installFakeCasino({ running: true });
  const render = installHarness();
  t.after(() => { render.unmount(); restoreGlobals(); });
  const view = () => render('game', true);

  view();
  casino.hello();
  assert.equal(await until(() => view().session && view().session.status === 'running'), true,
    'the running session was not adopted');
  view().pause();
  assert.equal(await until(() => casino.server.pauses === 1 && view().session.status === 'paused'), true,
    'the session did not pause');

  view().record(spin('17'));
  assert.equal(await until(() => view().problem === '1 spin was not saved to Casino: recording is paused. Resume it before the next spin.'),
    true, 'the refused spin was not stated with its count');
  assert.equal(casino.server.recorded.length, 0, 'a spin reached Casino while it was paused');
});

test('MEDIUM 4: a remount reopens the recorder, and the spins it sends after the remount are recorded', async (t) => {
  const casino = installFakeCasino();
  const render = installHarness();
  t.after(() => { render.unmount(); restoreGlobals(); });
  const view = () => render('game', true);

  view();
  casino.hello();
  assert.equal(await until(() => view().availability === 'on'), true, 'recording never reported on');

  // StrictMode tears the effects down and sets them up again on the same state.
  render.unmount();
  render.remount();
  view().record(spin('17'));
  assert.equal(await until(() => casino.server.recorded.length === 1), true, 'the recorder was dead after a remount');
  assert.deepEqual(casino.server.recorded.map((row) => row.segment), ['17']);
});

test('LOW: spins still queued when the view closes are counted, and the next mount of that mode says so', async (t) => {
  const storage = fakeLocalStorage();
  globalThis.localStorage = storage;
  t.after(() => { delete globalThis.localStorage; });
  const casino = installFakeCasino();
  const first = installHarness();
  t.after(() => { first.unmount(); restoreGlobals(); });
  const view = () => first('game', true);

  view();
  casino.hello();
  assert.equal(await until(() => view().availability === 'on'), true, 'recording never reported on');
  casino.server.failNext = 3;
  view().record(spin('17'));
  assert.equal(await until(() => casino.server.spinCalls === 3 && /^1 spin waiting/.test(view().problem)), true);

  // The view closes with the spin still queued. The next mount is a new recorder with no memory of the queue.
  first.unmount();
  const next = installHarness();
  const nextView = () => next('game', true);
  nextView();
  assert.equal(await until(() => nextView().problem === '1 spin was not sent to Casino before the page closed.'), true,
    'the next mount did not say how many spins were not sent');

  // The count is shown once. A later mount says nothing.
  const later = installHarness();
  for (let i = 0; i < 20; i += 1) {
    later('game', true);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(later('game', true).problem, null, 'the count was shown on a second mount');
});

test('a Resume on a queue held behind a paused session resumes Casino first, then sends the held spin', async (t) => {
  const casino = installFakeCasino({ running: true, refuseWhilePaused: true });
  const render = installHarness();
  t.after(() => { render.unmount(); restoreGlobals(); });
  const view = () => render('game', true);

  view();
  casino.hello();
  assert.equal(await until(() => view().session && view().session.status === 'running'), true,
    'the running session was not adopted');

  // Another device pauses the session. The next spin is refused as paused, and the queue holds it.
  casino.server.status = 'paused';
  view().record(spin('17'));
  assert.equal(await until(() => view().problem === 'Casino recording is paused. Resume it to send 1 waiting spin.'), true,
    'the held spin did not say the recording is paused');
  assert.equal(casino.server.recorded.length, 0, 'a spin reached Casino while it was paused');

  // Resume must reach Casino first. Flushing the held spin before the resume would be refused again, and nothing would resume.
  view().resume();
  assert.equal(await until(() => casino.server.recorded.length === 1 && view().problem === null), true,
    'Resume did not send the held spin');
  assert.equal(casino.server.resumes, 1, 'Resume did not reach Casino');
  assert.equal(view().session.status, 'running');
  // Let the last answers and their follow-up work finish before the test ends.
  assert.equal(await until(() => casino.server.pending === 0), true, 'an answer was still in flight when the test ended');
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
});

// -- Review round 4: the third review's defects. Each test fails on the round-3 code before its fix. -------

// With answers held, the test releases the next one as soon as it is sent.
async function releaseNext(casino) {
  assert.equal(await until(() => casino.server.heldReplies.length === 1), true, 'an answer was not held');
  casino.releaseOne();
}

// A running recording whose head spin is unconfirmed: each of its three attempts is released by the test.
async function heldRecording(t) {
  const casino = installFakeCasino({ running: true });
  const render = installHarness();
  t.after(() => { render.unmount(); restoreGlobals(); });
  const view = () => render('game', true);
  view();
  casino.hello();
  assert.equal(await until(() => view().session && view().session.status === 'running'), true, 'the running session was not adopted');
  casino.server.holdReplies = true;
  casino.server.failNext = 3;
  view().record(spin('17'));
  for (let i = 0; i < 3; i += 1) await releaseNext(casino);
  assert.equal(await until(() => /^1 spin waiting/.test(view().problem)), true, 'the head was not held');
  return { casino, view };
}

test('FLUSH-DROP 1: a send in flight at dispose that Casino records is resent on reopen under the same sequence, recorded once', async () => {
  const server = { recorded: [], sent: [], replies: [] };
  const confirmed = [];
  const retries = [];
  const queue = createSpinQueue({
    resolveSession: async () => ({ ok: true, session: { id: 's1', status: 'running', spins: 0 } }),
    send: (op, payload) => {
      const repeat = server.recorded.includes(payload.spin.sequence);
      if (!repeat) server.recorded.push(payload.spin.sequence);
      server.sent.push(structuredClone(payload));
      return new Promise((resolve) => server.replies.push(() => resolve({ ok: true, status: 201, body: { recorded: !repeat, session: { id: 's1', status: 'running', spins: server.recorded.length } } })));
    },
    wait: async () => {}, pauseRequested: () => false, report: () => {}, recordingOff: () => {},
    confirmed: (body, info) => { confirmed.push(info); },
    reread: async () => ({ ok: true, session: { id: 's1', status: 'running', spins: server.recorded.length } }),
    ended: () => {}, drained: () => {}, schedule: (callback) => { retries.push(callback); return () => {}; },
  });
  const answer = () => server.replies.shift()();
  queue.enqueue(spin('17'));
  const flushing = queue.flush();
  assert.equal(await until(() => server.replies.length === 1), true, 'the first send was not made');
  queue.dispose(); // the view closes while the send is in flight
  answer(); // Casino records the spin, and its answer arrives after the close
  assert.equal(await flushing, false, 'the closed round confirmed a spin');
  queue.reopen(); // the view mounts again on the same recorder
  assert.equal(await until(() => server.replies.length === 1), true, 'reopen did not resend the spin');
  answer();
  await until(() => confirmed.length === 1 || retries.length > 0);
  retries.splice(0).forEach((retry) => retry()); // a queue that held the spin would retry it now, under a new number
  await until(() => confirmed.length === 1 || server.replies.length > 0);
  if (server.replies.length) answer();
  assert.equal(await until(() => confirmed.length === 1), true, 'the spin was not confirmed after reopen');
  assert.deepEqual(server.recorded, [1], 'the spin was recorded under more than one sequence');
  assert.equal(new Set(server.sent.map((payload) => payload.spin.sequence)).size, 1, 'the spin was renumbered');
  assert.deepEqual(confirmed, [{ reconciled: true, pauseCarried: false }]);
});

test('FLUSH-DROP 2: a second Stop during the discard wait says that it is discarding', async (t) => {
  const { casino, view } = await heldRecording(t);
  view().stop(); // the first press offers the discard
  assert.equal(await until(() => /Press Stop again/.test(view().problem)), true);
  casino.server.failNext = 0;
  assert.equal(fireRetries(), 1, 'the retry was not armed once');
  assert.equal(await until(() => casino.server.heldReplies.length === 1), true, 'the retry did not send');
  view().stop(); // the second press waits for the send in flight
  assert.equal(view().problem, 'Discarding unsent spins…', 'the second Stop did not say that it is discarding');
  await releaseNext(casino); // Casino records the spin, and the discard goes on to stop the recording
  await releaseNext(casino);
  assert.equal(await until(() => view().session && view().session.status === 'stopped'), true, 'the recording did not stop');
  assert.equal(casino.server.recorded.length, 1);
});

test('FLUSH-DROP 3: Resume and Pause during the discard wait are refused with no message and never reach Casino', async (t) => {
  const { casino, view } = await heldRecording(t);
  // Resume flushes the held spin: its three attempts are sent, and each answer is held until released.
  casino.server.failNext = 3;
  view().resume();
  assert.equal(await until(() => casino.server.heldReplies.length === 1), true, 'Resume did not flush');
  view().stop(); // the first press offers the discard
  view().stop(); // the second press starts the discard, which waits for the flush
  view().pause(); // a Pause while the discard waits, with the held spin still queued, is refused the same way
  assert.equal(view().problem, 'Discarding unsent spins…', 'Pause during the discard wait wrote a line of its own');
  assert.equal(casino.server.pauses, 0, 'Pause reached Casino during the discard');
  for (let i = 0; i < 3; i += 1) await releaseNext(casino);
  assert.equal(await until(() => casino.server.heldReplies.length === 1), true, 'the discard did not reach Casino');
  assert.equal(view().problem, 'Discarding unsent spins…', 'Resume during the discard wait wrote a line of its own');
  assert.equal(casino.server.resumes, 0, 'Resume reached Casino during the discard');
  await releaseNext(casino);
  assert.equal(await until(() => view().problem === '1 spin may have been saved to Casino: discarded by Stop.'), true,
    'the discard was not stated with its count');
});

test('FLUSH-DROP 4: a spin made during the discard is refused as stopping, and is neither counted nor sent', async (t) => {
  const { casino, view } = await heldRecording(t);
  view().stop(); // the first press offers the discard
  assert.equal(await until(() => /Press Stop again/.test(view().problem)), true);
  casino.server.failNext = 0;
  assert.equal(fireRetries(), 1, 'the retry was not armed once');
  assert.equal(await until(() => casino.server.heldReplies.length === 1), true, 'the retry did not send');
  view().record(spin('8')); // made before the second press, but its turn in the queue comes after the discard has begun
  view().stop(); // the second press: the discard waits for the send in flight
  view().record(spin('3')); // a spin made during the discard
  assert.equal(view().problem, '1 spin was not saved to Casino: recording is stopping.', 'the spin made during the discard was not refused');
  await releaseNext(casino); // the send in flight is recorded
  await releaseNext(casino); // the stop
  assert.equal(await until(() => view().problem === '2 spins were not saved to Casino: recording is stopping.'), true,
    'the refusals did not stay on screen after the discard');
  assert.deepEqual(casino.server.recorded.map((row) => row.segment), ['17'], 'a refused spin reached Casino');
});
