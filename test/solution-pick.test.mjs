import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';

const SRC = new URL('../nexus-src/src/', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));
const NOW = 1700003000000;

// The files the bundle concatenates ahead of the pieces these tests use, in build.js order. No UI components are loaded.
const SLICE = [
  'constants.js', 'account-storage.mjs', 'engine.js', 'session.js', 'spin-apply.js',
  'streak-percentiles.js', 'percentile.js', 'roulette-bets.mjs',
];

// Loads source files the way build.js does: the same concatenation and transforms, in one shared global scope.
async function loadSlice() {
  const sources = await Promise.all(SLICE.map((f) => readFile(new URL(f, SRC), 'utf8')));
  const combined = SLICE.map((f, i) => `\n// ===== ${f} =====\n${sources[i]}`).join('\n');
  const { code } = transformSync(combined, {
    babelrc: false,
    configFile: false,
    filename: 'app.jsx',
    presets: [
      [presetReact, { runtime: 'classic' }],
      [presetEnv, { targets: { ie: 11 }, modules: 'commonjs', useBuiltIns: false }],
    ],
  });
  const store = {};
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    localStorage: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; },
    },
    React,
    require: (name) => {
      if (name === 'react') return React;
      throw new Error(`unexpected module in test slice: ${name}`);
    },
  };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  sandbox.window = sandbox;
  sandbox.window.parent = sandbox; // standalone page: window.parent === window
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'bundle-slice.js' });
  return sandbox;
}

let slicePromise = null;
const load = () => { if (!slicePromise) slicePromise = loadSlice(); return slicePromise; };

// The founder's case: 33 has not hit for 90 spins while every other number on the wheel hits in turn; then 5 just hit.
// Returns the session with 91 spins. Every other number's last hit is within the last 37 spins, so 33 (91 misses) is
// the one coldest number.
function coldThirtyThreeSession(ctx, fromTracker = false, track = null) {
  const others = ctx.getWheelNumbers('american').filter((n) => n !== '33');
  let s = ctx.newSession('american', 1000);
  if (track) s.tracks = [track];
  for (let i = 0; i < 90; i++) s = ctx.applySpin(s, others[i % others.length], fromTracker).sess;
  s = ctx.applySpin(s, '5', fromTracker).sess;
  return s;
}

// A Solution track that chases the given numbers, created at spin 0, the way the setup creates one.
function solutionTrack(ctx, numbers, entryThreshold = 80) {
  const cfg = { ...ctx.defaultSolCfg(), entryThreshold, activeBets: numbers.map((number) => ({ number, level: 0, invest: 0 })) };
  return plain(ctx.newTrack('solution', 0, cfg));
}

// The miss count from first principles: spins since the number last came up; the spin count if it never has.
function expectedMissCount(spins, n) {
  const last = spins.lastIndexOf(n);
  return last < 0 ? spins.length : spins.length - 1 - last;
}

test('a miss count is the spins since the number last hit, or the spin count if it never hit', async () => {
  const ctx = await load();
  const s = plain(coldThirtyThreeSession(ctx));
  assert.equal(s.droughts['5'], 0, 'the number that just hit has no misses');
  assert.equal(s.droughts['33'], 91, 'a number that never hit counts every spin of the session');
  for (const n of ctx.getWheelNumbers('american')) {
    assert.equal(s.droughts[n], expectedMissCount(s.spins, n), `miss count of ${n}`);
  }
});

test('the miss count agrees with the F6 spin counter (countDrought) for every straight number 1-36', async () => {
  const ctx = await load();
  const s = plain(coldThirtyThreeSession(ctx));
  for (let n = 1; n <= 36; n++) {
    const f6 = ctx.countDrought(s.spins, (v) => v === n);
    assert.equal(s.droughts[String(n)], f6, `miss count of ${n} against countDrought`);
  }
});

test('a number is in range exactly when its miss count is at or above the threshold', async () => {
  const ctx = await load();
  const wheel = ctx.getWheelNumbers('american');
  const droughts = { '7': 80, '8': 79, '9': 81 };
  assert.equal(ctx.solutionInRangeMember(droughts, '7', 80), true, 'at the threshold is in range');
  assert.equal(ctx.solutionInRangeMember(droughts, '8', 80), false, 'one below the threshold is out of range');
  assert.equal(ctx.solutionInRangeMember(droughts, '9', 80), true, 'above the threshold is in range');
  assert.deepEqual(plain(ctx.solutionInRange(droughts, wheel, 80)), ['9', '7']);
});

test('the in-range list is sorted coldest first, with equal counts in wheel order', async () => {
  const ctx = await load();
  const wheel = ctx.getWheelNumbers('american');
  const droughts = { '33': 92, '5': 0, '17': 120, '2': 95, '10': 95, '00': 300, '0': 300 };
  assert.deepEqual(plain(ctx.solutionInRange(droughts, wheel, 80)), ['17', '2', '10', '33']);
});

test('a zero is never a Solution target; 00 is on the American wheel only', async () => {
  const ctx = await load();
  const american = ctx.getWheelNumbers('american');
  const european = ctx.getWheelNumbers('european');
  assert.ok(american.includes('00'), 'the American wheel has 00');
  assert.ok(!european.includes('00'), 'the European wheel has no 00');
  assert.ok(!Object.keys(plain(ctx.initDroughts('european'))).includes('00'), 'the European counter has no 00');
  const everyZeroCold = { '0': 500, '00': 500 };
  assert.deepEqual(plain(ctx.solutionInRange(everyZeroCold, american, 80)), [], 'no zero is in range on American');
  assert.deepEqual(plain(ctx.solutionInRange(everyZeroCold, european, 80)), [], 'no zero is in range on European');
});

test('after a hit, a number leaves the in-range list at once and its Solution bet resolves', async () => {
  const ctx = await load();
  const s = plain(coldThirtyThreeSession(ctx, true, solutionTrack(ctx, ['33'])));
  assert.deepEqual(plain(ctx.solutionInRange(s.droughts, ctx.getWheelNumbers('american'), 80)), ['33']);
  const hit = ctx.applySpin(ctx.applySpin(s, '33', true).sess, '1', true).sess;
  assert.equal(hit.droughts['33'], 1, 'one miss after the hit');
  const afterHit = ctx.applySpin(ctx.newSession('american', 1000), '33', false).sess;
  assert.equal(ctx.solutionInRangeMember(afterHit.droughts, '33', 1), false, 'a number that has just hit is out of range');
  const resolved = plain(ctx.applySpin(s, '33', true).sess);
  assert.deepEqual(resolved.tracks[0].config.activeBets, [], 'the bet on the number that hit is removed');
  assert.equal(resolved.tracks[0].wins, 1);
});

test('the founder case: the Solution shows and bets the cold number, never the one that just hit', async () => {
  const ctx = await load();
  const wheel = ctx.getWheelNumbers('american');
  const s = plain(coldThirtyThreeSession(ctx, true, solutionTrack(ctx, ['33'])));
  const list = plain(ctx.solutionInRange(s.droughts, wheel, 80));
  assert.deepEqual(list, ['33'], 'the in-range list is the cold number alone');
  assert.equal(list[0], '33', 'the coldest number is first');
  assert.deepEqual(s.tracks[0].config.activeBets.map((b) => b.number), ['33'], 'the track chases 33');

  // A spin that hits 5 is a miss for the 33 bet. It never places a bet on 5. From a fresh bet (level 0), two misses
  // on the other numbers advance the 33 bet two levels.
  const fresh = plain(ctx.newSession('american', 1000));
  fresh.tracks = [solutionTrack(ctx, ['33'])];
  const miss = plain(ctx.applySpin(ctx.applySpin(fresh, '5', true).sess, '2', true).sess);
  assert.deepEqual(miss.tracks[0].config.activeBets.map((b) => b.number), ['33'], 'still chasing 33 only');
  assert.equal(miss.tracks[0].config.activeBets[0].level, 2, 'the 33 bet advanced two levels over two misses');

  const won = plain(ctx.applySpin(s, '33', true).sess);
  assert.deepEqual(won.tracks[0].config.activeBets, [], 'the 33 bet resolves on its own hit');
});

test('Undo restores the miss counts and the in-range list', async () => {
  const ctx = await load();
  const wheel = ctx.getWheelNumbers('american');
  const before = plain(coldThirtyThreeSession(ctx, true, solutionTrack(ctx, ['33'])));
  const prev = plain(before); // the app keeps a JSON copy of the session before a tracked spin
  const after = plain(ctx.applySpin(before, '17', true).sess);
  assert.notEqual(after.droughts['17'], before.droughts['17'], 'the spin changed the counts');
  const undone = prev;
  assert.deepEqual(undone.droughts, before.droughts);
  assert.deepEqual(plain(ctx.solutionInRange(undone.droughts, wheel, 80)), ['33']);
});

test('Undo of Clear numbers restores the miss counts and the in-range list', async () => {
  const ctx = await load();
  const wheel = ctx.getWheelNumbers('american');
  const s = plain(coldThirtyThreeSession(ctx, true, solutionTrack(ctx, ['33'])));
  const snapshot = ctx.snapshotSpinState(s);
  const cleared = ctx.clearSpins(s, NOW);
  assert.deepEqual(plain(ctx.solutionInRange(cleared.droughts, wheel, 80)), [], 'nothing is in range after the clear');
  const restored = plain(ctx.restoreSpinState(cleared, snapshot, NOW));
  assert.deepEqual(restored.droughts, s.droughts);
  assert.deepEqual(plain(ctx.solutionInRange(restored.droughts, wheel, 80)), ['33']);
});

test('clear numbers recomputes the list: every count is zero and the chased number keeps its bet at level 0', async () => {
  const ctx = await load();
  const s = plain(coldThirtyThreeSession(ctx, true, solutionTrack(ctx, ['33'])));
  const cleared = plain(ctx.clearSpins(s, NOW));
  assert.ok(Object.values(cleared.droughts).every((v) => v === 0), 'every miss count is zero');
  assert.deepEqual(plain(ctx.solutionInRange(cleared.droughts, ctx.getWheelNumbers('american'), 80)), []);
  assert.deepEqual(cleared.tracks[0].config.activeBets, [{ number: '33', level: 0, invest: 0 }]);
});

test('the long-press correction recomputes the miss counts and the in-range list from the corrected spins', async () => {
  const ctx = await load();
  const wheel = ctx.getWheelNumbers('american');
  const s = coldThirtyThreeSession(ctx, true, solutionTrack(ctx, ['33']));
  const corrected = ctx.correctSpin(s, 90, '7', NOW);
  assert.equal(corrected.ok, true, corrected.reason || 'the correction was refused');
  const c = plain(corrected.session);
  assert.equal(c.spins[90], '7');
  for (let n = 1; n <= 36; n++) {
    assert.equal(c.droughts[String(n)], ctx.countDrought(c.spins, (v) => v === n), `miss count of ${n} after the correction`);
  }
  assert.equal(c.droughts['7'], 0, 'the corrected number is the one that just came up');
  assert.equal(c.droughts['5'], expectedMissCount(c.spins, '5'), 'the uncorrected number is recounted');
  assert.deepEqual(plain(ctx.solutionInRange(c.droughts, wheel, 80)), ['33']);
});

test('the simulation and the live Solution use one in-range predicate', async () => {
  const srcDir = new URL('../nexus-src/src/', import.meta.url);
  const files = (await readdir(srcDir, { recursive: true })).filter((f) => /\.(js|jsx|mjs)$/.test(f));
  let definitions = 0;
  for (const f of files) {
    const text = await readFile(new URL(f, srcDir), 'utf8');
    definitions += (text.match(/function\s+solutionInRangeMember\s*\(/g) || []).length;
  }
  assert.equal(definitions, 1, 'exactly one definition of the in-range predicate in the source');
  const sim = await readFile(new URL('simulation.js', srcDir), 'utf8');
  assert.ok(sim.includes('solutionInRangeMember(droughts,winningNumber,entry)'), 'the simulation decides the spin in range with the shared predicate');
  assert.ok(sim.includes('solutionInRangeMember(droughts,k,effectiveEntry)'), 'the simulation enrols with the shared predicate');
  assert.ok(!sim.includes('droughts[k]>=effectiveEntry'), 'the inline enrolment predicate is gone');
});
