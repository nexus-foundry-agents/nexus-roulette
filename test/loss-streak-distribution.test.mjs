import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';
import ReactDOMServer from 'react-dom/server';

const SRC = new URL('../nexus-src/src/', import.meta.url);
const SLICE = ['constants.js', 'account-storage.mjs', 'engine.js', 'simulation.js', 'components/StreakDistribution.jsx'];

async function load() {
  const sources = await Promise.all(SLICE.map((f) => readFile(new URL(f, SRC), 'utf8')));
  const { code } = transformSync(sources.join('\n'), {
    babelrc: false, configFile: false, filename: 'slice.jsx',
    presets: [[presetReact, { runtime: 'classic' }], [presetEnv, { targets: { ie: 11 }, modules: 'commonjs', useBuiltIns: false }]],
  });
  const sandbox = { React, console, Math, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    require: (name) => { if (name === 'react') return React; throw new Error(name); } };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code + '\n;this.__x={simRunSession,simNewResults,computeSimStats,computeTableForTrack,flushStreak,flushRawLoss,rawTargetOutcomes,streakDist,StreakDistribution,getWheelNumbers};', sandbox);
  return sandbox.__x;
}

test('streakDist lists every length 1..max with count, share, at-least and spin share', async () => {
  const { streakDist } = await load();
  const rows = JSON.parse(JSON.stringify(streakDist([1, 1, 2, 5])));
  assert.equal(rows.length, 5, 'one row per length up to the longest streak, no cap');
  assert.deepEqual(rows.map((r) => r.count), [2, 1, 0, 0, 1]);
  assert.equal(rows[0].pct, 50);
  assert.equal(rows[0].atLeastPct, 100);
  assert.equal(rows[4].atLeastPct, 25);
  assert.ok(Math.abs(rows[4].spinPct - (5 / 9) * 100) < 1e-9);
  assert.ok(Math.abs(rows.reduce((a, r) => a + r.pct, 0) - 100) < 1e-9);
});

test('a red bet produces a geometric loss-streak distribution and no streak spans a session', async () => {
  const x = await load();
  const strategies = [{ type: 'fibonacci', config: { evenTargets: ['red'], betMode: 'flat', unit: 1 } }];
  const tables = strategies.map((s) => x.computeTableForTrack(s));
  const wheel = x.getWheelNumbers('european');
  const results = x.simNewResults(1);
  const spins = 50, sessions = 4000;
  for (let i = 0; i < sessions; i++) x.simRunSession(strategies, tables, wheel, spins, results, null, null);
  const r = results[0];
  assert.equal(r.currentStreak.len, 0, 'the open streak is closed at session end');
  assert.ok(Math.max(...r.lossStreaks, ...r.winStreaks) <= spins, 'no streak longer than one session');
  const lossSpins = r.lossStreaks.reduce((a, b) => a + b, 0) + r.winStreaks.reduce((a, b) => a + b, 0);
  assert.equal(lossSpins, spins * sessions, 'every spin sits in exactly one streak');
  r.sessions = Array.from({ length: sessions }, () => ({ pnl: 0 }));
  const stats = x.computeSimStats(r);
  const dist = stats.lossStreakDist;
  assert.equal(dist.length, stats.longestLossStreak);
  // P(loss) on red, European = 19/37; within-session runs ≈ geometric: P(len=1) ≈ 18/37 ≈ 48.6%.
  assert.ok(Math.abs(dist[0].pct - 48.6) < 2.5, `len-1 share ${dist[0].pct}`);
  assert.ok(dist[1].pct < dist[0].pct && dist[2].pct < dist[1].pct);
});

test('the table renders every row and both kinds share one component', async () => {
  const x = await load();
  const rows = x.streakDist([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14]);
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(x.StreakDistribution, { kind: 'loss', rows }));
  assert.match(html, /Loss Streak Distribution/);
  assert.equal((html.match(/data-streak-dist/g) || []).length, 1);
  assert.match(html, />14</, 'the longest length is shown, beyond the old ten-row cap');
  const page = await readFile(new URL('components/SimModePage.jsx', SRC), 'utf8');
  assert.ok(page.includes('<StreakDistribution kind="loss"') && page.includes('<StreakDistribution kind="win"'));
  assert.ok(!page.includes('StreakDist.slice('), 'no truncated copy of the distribution remains');
});

test('raw loss streaks count every miss run on the targets from spin 1, ignoring the drought entry', async () => {
  const x = await load();
  const wheel = x.getWheelNumbers('european');
  const spins = 50, sessions = 3000;
  const gated = [{ type: 'fibonacci', config: { evenTargets: ['red'], betMode: 'flat', unit: 1, parkRules: { droughtThreshold: 3 } } }];
  const tables = gated.map((st) => x.computeTableForTrack(st));
  const results = x.simNewResults(1);
  for (let i = 0; i < sessions; i++) x.simRunSession(gated, tables, wheel, spins, results, null, null);
  const r = results[0];
  const rawSpins = r.rawLossStreaks.reduce((a, b) => a + b, 0);
  const betSpins = r.lossStreaks.reduce((a, b) => a + b, 0) + r.winStreaks.reduce((a, b) => a + b, 0);
  assert.ok(betSpins < spins * sessions, 'the drought entry keeps the strategy off some spins');
  assert.ok(r.rawLossStreaks.length > r.lossStreaks.length, 'raw counts runs the gated strategy never bet');
  assert.ok(Math.max(...r.rawLossStreaks) <= spins, 'no raw run crosses a session');
  assert.deepEqual(JSON.parse(JSON.stringify(r.rawOpen)), {}, 'open runs are closed at session end');
  r.sessions = Array.from({ length: sessions }, () => ({ pnl: 0 }));
  const dist = x.computeSimStats(r).rawLossStreakDist;
  // Miss runs on red: P(len=1) = P(hit) = 18/37 ≈ 48.6%.
  assert.ok(Math.abs(dist[0].pct - 48.6) < 2.5, `raw len-1 share ${dist[0].pct}`);
  assert.ok(rawSpins > betSpins * 0.3);
});

test('raw targets: solution follows every number, auto-chase every dozen and column, zero misses all', async () => {
  const x = await load();
  const wheel = x.getWheelNumbers('european');
  assert.equal(x.rawTargetOutcomes({ type: 'solution', config: {} }, '7', wheel).length, wheel.length);
  const chase = x.rawTargetOutcomes({ type: 'fibonacci', config: { autoChase: true } }, '0', wheel);
  assert.equal(chase.length, 6);
  assert.ok(chase.every((o) => !o.hit), 'zero misses every dozen and column');
  const page = await readFile(new URL('components/SimModePage.jsx', SRC), 'utf8');
  assert.ok(page.includes('<StreakDistribution kind="raw"'));
});
