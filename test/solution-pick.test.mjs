import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';
import ReactDOMServer from 'react-dom/server';

const SRC = new URL('../nexus-src/src/', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));
const NOW = 1700003000000;

// The files the bundle concatenates ahead of the pieces these tests use, in build.js order. No UI component is loaded:
// onboarding-apply.jsx is a plain function (completeOnboarding) and is loaded so the restart can be run.
const SLICE = [
  'constants.js', 'account-storage.mjs', 'engine.js', 'session.js', 'spin-apply.js',
  'streak-percentiles.js', 'percentile.js', 'tlv.js', 'roulette-bets.mjs', 'components/onboarding-apply.jsx',
];

// Loads source files the way build.js does: the same concatenation and transforms, in one shared global scope.
async function loadSlice(files = SLICE) {
  const sources = await Promise.all(files.map((f) => readFile(new URL(f, SRC), 'utf8')));
  const combined = files.map((f, i) => `\n// ===== ${f} =====\n${sources[i]}`).join('\n');
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

// The same slice with the two presentational pieces the render test needs: the Tap Winning Number grid and the picker.
let uiPromise = null;
const loadUi = () => {
  if (!uiPromise) uiPromise = loadSlice([...SLICE, 'components/grids.jsx', 'components/SolutionPicker.jsx', 'components/TrackPanel.jsx']);
  return uiPromise;
};

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

// -- The picker, the chase line, the default threshold and the droughts recount (F14b) --

test('App.jsx has no second copy of the in-range predicate: its in-range and candidate lists call solutionInRange', async () => {
  const srcDir = new URL('../nexus-src/src/', import.meta.url);
  const app = await readFile(new URL('App.jsx', srcDir), 'utf8');
  assert.ok(app.includes('solutionInRange(sess.droughts, wheelNums, solEntryThreshold)'), 'the live in-range list calls solutionInRange');
  assert.ok(app.includes('solutionInRange(sess.droughts, wheelNums, solDefaultEntry)'), 'the candidate list calls solutionInRange');
  const files = (await readdir(srcDir, { recursive: true })).filter((f) => /\.(js|jsx|mjs)$/.test(f) && f !== 'engine.js');
  for (const f of files) {
    const text = await readFile(new URL(f, srcDir), 'utf8');
    assert.ok(!/droughts\[[^\]]+\]\)?\s*\|\|\s*0\)\s*>=/.test(text), `${f} compares a miss count with a threshold inline`);
  }
});

test('the default entry threshold is one setting: 90 when set, 120 when unset or invalid, and a new track starts at it', async () => {
  const ctx = await load();
  assert.equal(ctx.solEntryDefault({ solEntryDefault: 90 }), 90);
  assert.equal(ctx.solEntryDefault({}), 120, 'unset reads as 120');
  assert.equal(ctx.solEntryDefault(undefined), 120, 'no settings reads as 120');
  assert.equal(ctx.solEntryDefault({ solEntryDefault: 5 }), 120, 'below the stepper minimum of 20 is not a default');
  assert.equal(ctx.solEntryDefault({ solEntryDefault: 90.5 }), 120, 'a whole number only');
  assert.equal(plain(ctx.solDefaultCfg({ solEntryDefault: 90 })).entryThreshold, 90);
  const track = plain(ctx.newTrack('solution', 0, plain(ctx.solDefaultCfg({ solEntryDefault: 90 }))));
  assert.equal(track.config.entryThreshold, 90, 'a track created with the setting at 90 has entryThreshold 90');
});

test('with the default at 90, a number at 91 misses is listed, offered by the picker and preselected in the setup', async () => {
  const ctx = await load();
  const wheel = ctx.getWheelNumbers('american');
  const threshold = ctx.solEntryDefault({ solEntryDefault: 90 });
  const d = { ...plain(ctx.initDroughts('american')), '33': 91 };
  assert.deepEqual(plain(ctx.solutionInRange(d, wheel, threshold)), ['33'], 'listed as in range');
  assert.equal(plain(ctx.solutionPickRow(d, 'american', threshold, '33')).inRange, true, 'the picker marks it in range');
  assert.equal(plain(ctx.solutionColdest(d, wheel, 6))[0], '33', 'the picker offers it first');
  assert.equal(ctx.solutionPreselect(d, wheel, threshold), '33', 'a setup preselects the one number in range');
  assert.deepEqual(plain(ctx.solutionInRange(d, wheel, 120)), [], 'the old hard-coded 120 is the bug: it does not list it');
});

test('the picker lists the six coldest numbers, coldest first, zeros left out, ties in wheel order', async () => {
  const ctx = await load();
  const wheel = ctx.getWheelNumbers('american');
  const d = { ...plain(ctx.initDroughts('american')), '33': 92, '17': 120, '2': 95, '10': 95, '0': 500, '00': 500 };
  assert.deepEqual(plain(ctx.solutionColdest(d, wheel, 6)), ['17', '2', '10', '33', '1', '3']);
  assert.equal(plain(ctx.solutionColdest(d, wheel, 36)).includes('0'), false, 'a zero is never offered');
  assert.equal(plain(ctx.solutionColdest(d, wheel, 36)).includes('00'), false, 'a double zero is never offered');
});

test('a picker row gives the number, its misses, whether it is in range and its single-number tier', async () => {
  const ctx = await load();
  const d = { ...plain(ctx.initDroughts('american')), '33': 92 };
  const row = plain(ctx.solutionPickRow(d, 'american', 80, '33'));
  assert.deepEqual({ number: row.number, misses: row.misses, inRange: row.inRange }, { number: '33', misses: 92, inRange: true });
  assert.equal(row.tier, ctx.percentileTier(ctx.streakPercentile('straight:33', 'american', 92)), 'the tier is the single-number percentile tier');
  assert.equal(plain(ctx.solutionPickRow(d, 'american', 120, '33')).inRange, false, 'below the threshold is not in range');
  assert.equal(plain(ctx.solutionPickRow(d, 'american', 80, '1')).tier, null, 'no misses, no tier');
});

test('the chase line names the chased number and its misses, recounts every spin, and reads "hit" after the win', async () => {
  const ctx = await load();
  const text = (s) => ctx.solutionChaseText(s.tracks[0], s.droughts, s.spins);
  let s = plain(coldThirtyThreeSession(ctx, true, solutionTrack(ctx, ['33'], 80)));
  assert.equal(text(s), 'Chasing 33 - 91 misses');
  s = plain(ctx.applySpin(s, '1', true).sess);
  assert.equal(text(s), 'Chasing 33 - 92 misses', 'recounted after a spin');
  s = plain(ctx.applySpin(s, '33', true).sess);
  assert.equal(text(s), '33 hit - pick the next number', 'the bet is resolved and the win is named');
  s.tracks[0].config.activeBets = [{ number: '17', level: 0, invest: 0 }];
  assert.match(text(s), /^Chasing 17 - \d+ misses( · below entry \(\d+\/80\))?$/, 'once a number is chosen the line names it');
});

test('the chase line says below entry with the misses and the threshold, and counts extra bets', async () => {
  const ctx = await load();
  const below = plain(coldThirtyThreeSession(ctx, true, solutionTrack(ctx, ['33'], 120)));
  assert.equal(ctx.solutionChaseText(below.tracks[0], below.droughts, below.spins), 'Chasing 33 - 91 misses · below entry (91/120)');
  // Every other number hits during the session and its bet resolves, so the second bet is added once the session is run.
  const two = plain(coldThirtyThreeSession(ctx, true, solutionTrack(ctx, ['33'], 80)));
  two.tracks[0].config.activeBets.push({ number: '17', level: 0, invest: 0 });
  assert.equal(ctx.solutionChaseText(two.tracks[0], two.droughts, two.spins), 'Chasing 33 - 91 misses (+1 more)');
  const none = plain(ctx.newTrack('solution', 0, plain(ctx.defaultSolCfg())));
  assert.equal(ctx.solutionChaseText(none, plain(ctx.initDroughts('american')), []), 'Not chasing a number');
});

test('a number chosen below the entry threshold is live at once: its bet advances on the next spin', async () => {
  const ctx = await load();
  const s = plain(ctx.newSession('american', 1000));
  s.tracks = [solutionTrack(ctx, ['9'], 120)];
  const after = plain(ctx.applySpin(s, '1', true).sess);
  assert.equal(after.tracks[0].config.activeBets[0].number, '9', 'the bet is held');
  assert.equal(after.tracks[0].config.activeBets[0].level, 1, 'and it was placed on the spin that followed the choice');
});

test('the Tap Winning Number grid: the chased number and the flash are different properties, and the last hit keeps its own colours', async () => {
  const ctx = await load();
  const TRACK = '#22d3ee';
  // solGridCellStyle(d, entry, maxLvl, held, chased, flashed, trackColor)
  const heldOnly = plain(ctx.solGridCellStyle(91, 80, 10, true, false, false, TRACK));
  const chased = plain(ctx.solGridCellStyle(91, 80, 10, true, true, false, TRACK));
  const flashed = plain(ctx.solGridCellStyle(91, 80, 10, false, false, true, TRACK));
  assert.equal(chased.bd, TRACK, 'the chased number takes the track colour as its ring');
  assert.equal(chased.chase, true, 'and shows the CHASE label');
  assert.equal(chased.bg, heldOnly.bg, 'with the held fill it has anyway, not a fill of its own');
  assert.equal(heldOnly.chase, false, 'a held bet that is not chased shows no label');
  assert.equal(flashed.bd, '#ffffff', 'the flash is a white ring');
  assert.equal(flashed.bg, '#ffffff22', 'with a light fill');
  assert.equal(flashed.chase, false, 'the flash is not the chase');
  assert.notEqual(chased.bd, flashed.bd, 'the ring differs');
  assert.notEqual(chased.bg, flashed.bg, 'the fill differs');
  const lastHit = plain(ctx.solGridCellStyle(0, 80, 10, false, false, false, TRACK));
  assert.equal(lastHit.bd, '#166534', 'a last hit (zero misses) keeps the JUST HIT ring');
});

test('tapping a number to chase keeps every held bet with its level; the tapped number becomes the chased one', async () => {
  const ctx = await load();
  let s = plain(ctx.newSession('american', 1000));
  s.tracks = [solutionTrack(ctx, ['17'], 80)];
  for (const v of ['1', '2', '3']) s = plain(ctx.applySpin(s, v, true).sess);
  assert.equal(s.tracks[0].config.activeBets[0].level, 3, '17 is held at level 3');
  const cfg = plain(ctx.chaseSolConfig(s.tracks[0].config, '33'));
  assert.deepEqual(cfg.activeBets.find((b) => b.number === '17'), { number: '17', level: 3, invest: 0 }, '17 is still held at level 3');
  assert.deepEqual(cfg.activeBets.find((b) => b.number === '33'), { number: '33', level: 0, invest: 0 }, '33 is now held, at level 0');
  assert.equal(cfg.chaseNumber, '33', '33 is the chased number');
  const track = { ...s.tracks[0], config: cfg };
  assert.deepEqual(plain(ctx.solutionChase(track, s.spins)), { state: 'chasing', number: '33', hit: null });
  assert.ok(ctx.solutionChaseText(track, s.droughts, s.spins).startsWith('Chasing 33 - '), 'the chase line names 33');
  // The next spin advances both held bets from where they stand.
  s.tracks = [{ ...s.tracks[0], config: cfg }];
  const next = plain(ctx.applySpin(s, '2', true).sess);
  assert.equal(next.tracks[0].config.activeBets.find((b) => b.number === '17').level, 4, '17 advances from level 3 to 4');
  assert.equal(next.tracks[0].config.activeBets.find((b) => b.number === '33').level, 1, '33 advances from level 0 to 1');
});

test('a second tap adds its number and keeps the first; tapping a held number chases it without changing its level', async () => {
  const ctx = await load();
  const base = { activeBets: [{ number: '17', level: 3, invest: 0 }, { number: '33', level: 0, invest: 0 }], chaseNumber: '33' };
  const two = plain(ctx.chaseSolConfig(base, '9'));
  assert.deepEqual(two.activeBets.map((b) => [b.number, b.level]), [['17', 3], ['33', 0], ['9', 0]], 'all three held, levels kept');
  assert.equal(two.chaseNumber, '9');
  const back = plain(ctx.chaseSolConfig(two, '17'));
  assert.deepEqual(back.activeBets.map((b) => [b.number, b.level]), [['17', 3], ['33', 0], ['9', 0]], 'tapping a held bet adds nothing and keeps its level');
  assert.equal(back.chaseNumber, '17');
});

test('the Active Bets × removes only the bet it names; removing the chased bet clears the chase; adding a bet keeps it', async () => {
  const ctx = await load();
  const base = { activeBets: [{ number: '17', level: 3, invest: 0 }, { number: '33', level: 0, invest: 0 }], chaseNumber: '33' };
  const dropOther = plain(ctx.toggleSolBetConfig(base, '17'));
  assert.deepEqual(dropOther.activeBets.map((b) => b.number), ['33'], 'only 17 is removed');
  assert.equal(dropOther.chaseNumber, '33', 'the chase stays on 33');
  const dropChased = plain(ctx.toggleSolBetConfig(base, '33'));
  assert.equal(dropChased.chaseNumber, null, 'removing the chased bet clears the chase');
  const track = { config: dropChased, bets: [] };
  assert.equal(ctx.solutionChaseText(track, {}, []), 'Not chasing a number');
  const added = plain(ctx.toggleSolBetConfig(base, '5'));
  assert.deepEqual(added.activeBets.map((b) => [b.number, b.level]), [['17', 3], ['33', 0], ['5', 0]], 'the added bet starts at level 0');
  assert.equal(added.chaseNumber, '33', 'adding a bet leaves the chase where it was');
});

test('after the chased number hits, the bets still held keep their levels and the track reads "pick the next number"', async () => {
  const ctx = await load();
  let s = plain(ctx.newSession('american', 1000));
  s.tracks = [solutionTrack(ctx, ['17'], 80)];
  for (const v of ['1', '2', '3']) s = plain(ctx.applySpin(s, v, true).sess);
  s.tracks[0].config = plain(ctx.chaseSolConfig(s.tracks[0].config, '33'));
  const hit = plain(ctx.applySpin(s, '33', true).sess);
  const held = hit.tracks[0].config.activeBets;
  assert.deepEqual(held.map((b) => b.number), ['17'], '33 resolves and leaves the list; 17 stays');
  assert.equal(held[0].level, 4, '17 kept its level and advanced by the spin');
  assert.equal(hit.tracks[0].config.chaseNumber, '33', 'the chase still names the number that hit');
  assert.deepEqual(plain(ctx.solutionChase(hit.tracks[0], hit.spins)), { state: 'hit', number: null, hit: '33' });
  assert.equal(ctx.solutionChaseText(hit.tracks[0], hit.droughts, hit.spins), '33 hit - pick the next number');
});

test('the Solution save takes its held bets and chased number from the live track, and the threshold from the panel', async () => {
  const ctx = await load();
  let s = plain(ctx.newSession('american', 1000));
  s.tracks = [solutionTrack(ctx, ['17'], 120)];
  s.tracks[0].config = plain(ctx.chaseSolConfig(s.tracks[0].config, '33'));
  const stale = plain(s.tracks[0].config); // the panel copies the config when it opens
  s = plain(ctx.applySpin(s, '33', true).sess); // 33 comes up while the panel is open
  const merged = plain(ctx.editedTrackConfig(s.tracks[0].config, { ...stale, entryThreshold: 90 }));
  assert.equal(merged.entryThreshold, 90, 'the threshold is the edited one');
  assert.deepEqual(merged.activeBets, s.tracks[0].config.activeBets, 'the live bets are kept: 33 is not brought back');
  assert.equal(merged.activeBets.some((b) => b.number === '33'), false, '33 stays resolved');
  assert.equal(merged.chaseNumber, '33', 'the chased number is the live one');
});

test('a threshold change takes effect from the next spin and never changes how a bet settles', async () => {
  const ctx = await load();
  const t120 = solutionTrack(ctx, ['33'], 120);
  t120.config.chaseNumber = '33';
  const s = plain(coldThirtyThreeSession(ctx, true, t120));
  const before = ctx.solutionChaseText(s.tracks[0], s.droughts, s.spins);
  assert.ok(before.endsWith('below entry (91/120)'), 'at 120, 33 is below entry');
  assert.deepEqual(plain(ctx.solutionInRange(s.droughts, ctx.getWheelNumbers('american'), 120)), []);
  const edited = { ...s.tracks[0], config: plain(ctx.editedTrackConfig(s.tracks[0].config, { ...s.tracks[0].config, entryThreshold: 90 })) };
  const s90 = { ...s, tracks: [edited] };
  assert.deepEqual(plain(ctx.solutionInRange(s.droughts, ctx.getWheelNumbers('american'), 90)), ['33'], 'at 90, 33 is in range at once');
  assert.equal(ctx.solutionChaseText(edited, s90.droughts, s90.spins).includes('below entry'), false);
  // The spin after the change settles the same bets whatever the threshold is.
  const next120 = plain(ctx.applySpin(s, '1', true).sess);
  const next90 = plain(ctx.applySpin(s90, '1', true).sess);
  assert.deepEqual(next90.tracks[0].config.activeBets, next120.tracks[0].config.activeBets, 'the same bets and levels');
  assert.equal(next90.tracks[0].pnl, next120.tracks[0].pnl, 'the same money');
  assert.equal(next90.tracks[0].wins, next120.tracks[0].wins, 'the same wins');
});

test('the entry threshold steps by 5 and never goes below 20; one stepper serves the setup and Edit Config', async () => {
  const ctx = await load();
  assert.equal(ctx.nextEntryThreshold(120, -5), 115);
  assert.equal(ctx.nextEntryThreshold(120, 5), 125);
  assert.equal(ctx.nextEntryThreshold(22, -5), 20, 'the floor is 20');
  assert.equal(ctx.nextEntryThreshold(20, -5), 20);
  const ui = await loadUi();
  const html = ReactDOMServer.renderToStaticMarkup(ui.React.createElement(ui.EntryThresholdStepper, { value: 90, onChange: () => {} }));
  assert.ok(html.includes('>90<'), 'the stepper shows the value');
  const srcDir = new URL('../nexus-src/src/', import.meta.url);
  const track = await readFile(new URL('components/TrackPanel.jsx', srcDir), 'utf8');
  assert.equal(track.split('<EntryThresholdStepper').length - 1, 2, 'the setup and Edit Config both mount the stepper');
  assert.equal(track.split('function EntryThresholdStepper(').length - 1, 1, 'the stepper is defined once');
  assert.ok(track.includes('<EntryThresholdStepper value={cfg.entryThreshold} onChange={setEntry}/>'), 'the setup saves its change as the default');
  assert.ok(track.includes('<EntryThresholdStepper value={cfg.entryThreshold} onChange={v=>upCfg("entryThreshold",v)}/>'), 'Edit Config changes the track');
  assert.ok(!track.includes('Math.max(20'), 'no stepper keeps its own floor');
  const app = await readFile(new URL('App.jsx', srcDir), 'utf8');
  assert.ok(app.includes('const edited=sol?editedTrackConfig(t.config,newCfg):newCfg;'), 'a Solution save reads its held bets from the live track (TRACK-EDIT-PARK)');
});

test('a wheel change and an onboarding restart keep the spin history and recount the droughts from it', async () => {
  const ctx = await load();
  const spins = ['5', '0', '33', '7', '7'];
  // The counts of the kept spins on the European wheel, the way applySpin keeps them.
  let eu = plain(ctx.newSession('european', 1000));
  for (const v of spins) eu = plain(ctx.applySpin(eu, v, false).sess);
  assert.deepEqual(plain(ctx.droughtsFromSpins(spins, 'european')), eu.droughts, 'the recount equals the incremental counts');
  // The counts of the kept spins on the American wheel, zeros included.
  let am = plain(ctx.newSession('american', 1000));
  for (const v of spins) am = plain(ctx.applySpin(am, v, false).sess);
  assert.deepEqual(plain(ctx.droughtsFromSpins(spins, 'american')), am.droughts, 'zeros are counted back to their own last spin');
  // A kept 00 is a miss for every straight number, even on a European wheel that has no 00.
  assert.equal(ctx.droughtsFromSpins(['00', '5'], 'european')['1'], 2, 'a number that never came up counts every spin, the 00 included');
  assert.equal(ctx.droughtsFromSpins(['5', '00'], 'european')['5'], 1);
  // The onboarding restart keeps the spins and recounts (completeOnboarding, onboarding-apply.jsx).
  const sess = plain(ctx.newSession('american', 1000));
  let withSpins = sess;
  for (const v of spins) withSpins = plain(ctx.applySpin(withSpins, v, false).sess);
  const app = { settings: { _restartBankroll: 1000 }, currentSession: withSpins };
  ctx.completeOnboarding((fn) => fn(app), { roulette: 'european', bankroll: 1000, defaultBuyIn: 100, currency: 'USD', tableMinBet: 1, tableMaxBet: 500, tableMaxTotal: 5000 });
  assert.equal(app.currentSession.roulette, 'european');
  assert.deepEqual(app.currentSession.spins, spins, 'the spin history is kept');
  assert.equal(app.currentSession.droughts['5'], 4, 'the 5 is four spins back, not zero');
  assert.equal(app.currentSession.droughts['7'], 0);
  assert.equal(app.currentSession.droughts['0'], 3, 'the zero is three spins back');
  // The Roulette Type row recounts too (SecondaryPages.jsx).
  const sp = await readFile(new URL('components/SecondaryPages.jsx', SRC), 'utf8');
  assert.ok(sp.includes('s.droughts=droughtsFromSpins(s.spins,v)'), 'the Roulette Type row recounts from the kept spins');
  assert.ok(!sp.includes('s.droughts=initDroughts(v)'), 'the reset to zero is gone');
});

test('rendered: the picker marks the chosen and in-range numbers, and the grid shows the chase as a ring and a label apart from the flash', async () => {
  const ctx = await loadUi();
  const h = ctx.React.createElement;
  const d = { ...plain(ctx.initDroughts('american')), '33': 92, '17': 40 };
  const picker = ReactDOMServer.renderToStaticMarkup(h(ctx.SolutionPicker, {
    droughts: d, wheel: 'american', threshold: 80, count: 6, chosen: '33', color: '#22d3ee', onChoose: () => {},
  }));
  assert.equal((picker.match(/<button/g) || []).length, 6, 'six coldest numbers');
  assert.equal((picker.match(/visibility:visible">in range/g) || []).length, 1, 'one number is shown in range; the other labels keep their space, hidden');
  assert.equal((picker.match(/aria-pressed="true"/g) || []).length, 1, 'the chosen number is marked');
  assert.match(picker, /92 misses/, 'the miss count is shown');

  // 33 is held and chased; 17 is held and not chased; 5 has just been tapped (flashed).
  const grid = ReactDOMServer.renderToStaticMarkup(h(ctx.SolGrid, {
    onNumber: () => {}, droughts: d, entry: 80, maxLvl: 10, activeBets: [{ number: '33', level: 0 }, { number: '17', level: 0 }],
    wheelNums: ctx.getWheelNumbers('american'), trackOverlays: [], flashNum: '5', chasedNumber: '33', chaseColor: '#22d3ee',
  }));
  assert.equal((grid.match(/>CHASE</g) || []).length, 36, 'every number reserves its CHASE line, so no cell changes size');
  assert.equal((grid.match(/visibility:visible">CHASE</g) || []).length, 1, 'only the chased number shows the label');
  assert.equal((grid.match(/border:2px solid #22d3ee/g) || []).length, 1, 'the chased number has the track-colour ring');
  assert.equal((grid.match(/border:2px solid #ffffff/g) || []).length, 1, 'the flashed number has the white flash ring');
  assert.equal((grid.match(/background:#ffffff22/g) || []).length, 1, 'and the flash fill, which the chase does not have');
  assert.equal((grid.match(/background:#0d2a0d/g) || []).length, 2, 'both held bets keep the held fill, chased or not');
  assert.equal((grid.match(/>L1</g) || []).length, 2, 'every held bet keeps its level badge');
});

test('the picker is one component mounted by the setup, the Solution panel and the candidate card; nothing else picks', async () => {
  const srcDir = new URL('../nexus-src/src/', import.meta.url);
  const app = await readFile(new URL('App.jsx', srcDir), 'utf8');
  const track = await readFile(new URL('components/TrackPanel.jsx', srcDir), 'utf8');
  const build = await readFile(new URL('../nexus-src/build.js', import.meta.url), 'utf8');
  assert.equal(app.split('<SolutionPicker').length - 1, 2, 'App.jsx mounts it for the candidate card and the Solution panel');
  assert.equal(track.split('<SolutionPicker').length - 1, 1, 'TrackPanel.jsx mounts it in the track setup');
  assert.ok(build.includes("'components/SolutionPicker.jsx'"), 'the picker is in the build');
  const files = (await readdir(srcDir, { recursive: true })).filter((f) => /\.(js|jsx|mjs)$/.test(f));
  const callers = [];
  for (const f of files) {
    if ((await readFile(new URL(f, srcDir), 'utf8')).includes('solutionColdest(')) callers.push(f.replace(/\\/g, '/'));
  }
  assert.deepEqual(callers.sort(), ['components/SolutionPicker.jsx', 'engine.js'], 'only the picker calls the cold list');
});

test('the setup stepper saves its value as the default, and the new-track defaults read it', async () => {
  const srcDir = new URL('../nexus-src/src/', import.meta.url);
  const app = await readFile(new URL('App.jsx', srcDir), 'utf8');
  const track = await readFile(new URL('components/TrackPanel.jsx', srcDir), 'utf8');
  assert.ok(track.includes('if(onEntryDefault) onEntryDefault(v);'), 'the stepper saves the value');
  assert.ok(!track.includes('upCfg("entryThreshold",Math.max(20'), 'the stepper no longer sets the threshold without saving it');
  assert.ok(app.includes('onEntryDefault={setSolEntryDefault}'), 'the setup is handed the saver');
  assert.ok(app.includes('solDefaultCfg(settings)'), 'new Solution tracks start from the setting');
  assert.ok(!app.includes('DEFAULT_SOL_ENTRY = 120'), 'the hard-coded default is gone from App.jsx');
  assert.ok(!app.includes('? primaryTrack.config.entryThreshold : 120'), 'the no-track fallback reads the setting');
});
