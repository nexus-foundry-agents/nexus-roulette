import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';
import ReactDOMServer from 'react-dom/server';

// F16: the exact base bet. The functions under test are the ones the bundle runs: the source files are concatenated and
// transformed the way build.js does, in one shared scope, and nothing is copied from source.
const SRC = new URL('../nexus-src/src/', import.meta.url);

const SLICE = [
  'constants.js', 'account-storage.mjs', 'engine.js', 'session.js', 'spin-apply.js',
  'streak-percentiles.js', 'percentile.js', 'roulette-bets.mjs', 'components/ui.jsx', 'components/BaseBetInput.jsx',
];

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
    React,
    localStorage: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; },
    },
    require: (name) => {
      if (name === 'react') return React;
      throw new Error(`unexpected module in test slice: ${name}`);
    },
  };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  sandbox.window = sandbox;
  sandbox.window.parent = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'bundle-slice.js' });
  return { ctx: sandbox };
}

let slice = null;
const load = () => { if (!slice) slice = loadSlice(); return slice; };

const straight = (target, baseAmount) => ({ type: 'straight', target, baseAmount });

// A progression on dozen 1: a fibonacci track whose only settings are the base and the stop loss.
const progressionCfg = (unit, stopLoss) => ({
  type: 'fibonacci', unit, roi: 15, betMode: 'progression', dozenTargets: [1], colTargets: [], evenTargets: [], stopLoss,
});

// Money a table row represents at a base, in cents, so a comparison of two bases is exact.
const moneyCents = (row, unit) => [row.totalBet, row.totalInvest, row.ret, row.profit].map((v) => Math.round(v * unit * 100));

test('parseBaseAmount reads decimals, thousands commas, and a currency symbol that is stripped', async () => {
  const { ctx } = await load();
  const ok = (text, currency = 'USD') => {
    const r = ctx.parseBaseAmount(text, currency);
    assert.equal(r.ok, true, `"${text}" should be read: ${r.reason || ''}`);
    return r.value;
  };
  assert.equal(ok('2'), 2);
  assert.equal(ok('0.25'), 0.25);
  assert.equal(ok('.5'), 0.5);
  assert.equal(ok('5.'), 5);
  assert.equal(ok('1,000'), 1000);
  assert.equal(ok('1,000.50'), 1000.5);
  assert.equal(ok('10,000'), 10000);
  assert.equal(ok('$5'), 5);
  assert.equal(ok('5 $'), 5);
  assert.equal(ok('€2.50'), 2.5, 'a symbol of another currency is stripped too');
  assert.equal(ok('£10', 'GBP'), 10);
  assert.equal(ok('$0.01'), 0.01);
});

test('parseBaseAmount refuses each bad value with its reason, and the base is not changed', async () => {
  const { ctx } = await load();
  const refuse = (text, currency, reason) => {
    const r = ctx.parseBaseAmount(text, currency || 'USD');
    assert.equal(r.ok, false, `"${text}" should be refused`);
    assert.match(r.reason, reason, `"${text}" should say why`);
  };
  refuse('0', null, /lowest base is \$0\.01/);
  refuse('0.00', null, /lowest base is \$0\.01/);
  refuse('-5', null, /Negative amounts are not allowed/);
  refuse('−5', null, /Negative amounts are not allowed/);
  refuse('1.234', null, /Up to 2 decimal places/);
  refuse('0.001', null, /Up to 2 decimal places/);
  refuse('10,000.01', null, /highest base is \$10,000/);
  refuse('10001', null, /highest base is \$10,000/);
  refuse('1,000,000', null, /highest base is \$10,000/);
  refuse('', null, /Type an amount from \$0\.01 to \$10,000/);
  refuse('$', null, /Type an amount from \$0\.01 to \$10,000/);
  refuse('abc', null, /Use digits, one decimal point and commas/);
  refuse('1e3', null, /Use digits, one decimal point and commas/);
  refuse('1.2.3', null, /Only one decimal point/);
  refuse('1,5', null, /Commas only separate thousands/);
  refuse('12,34', null, /Commas only separate thousands/);
  refuse('5.5', 'JPY', /Japanese Yen has no cents/);
  refuse('0', 'JPY', /lowest base is ¥1/);
});

test('parseBaseAmount accepts the limits 0.01 and 10,000 and nothing beyond them', async () => {
  const { ctx } = await load();
  assert.equal(ctx.parseBaseAmount('0.01', 'USD').value, 0.01);
  assert.equal(ctx.parseBaseAmount('9999.99', 'USD').value, 9999.99);
  assert.equal(ctx.parseBaseAmount('10000', 'USD').value, 10000);
  assert.equal(ctx.parseBaseAmount('10000.00', 'USD').value, 10000);
  assert.equal(ctx.parseBaseAmount('10000.01', 'USD').ok, false);
  assert.equal(ctx.parseBaseAmount('0.009', 'USD').ok, false);
  assert.equal(ctx.parseBaseAmount('1', 'JPY').value, 1);
});

// The stop loss is money, so the ladder is capped at stopLoss / base chips. A stop loss this large is never reached in the
// 500 levels a table can hold, so the two tables differ only by the base.
const NO_CAP = 1e300;

test('a progression table at base 2.00 is 2 times its 1.00 table, row for row', async () => {
  const { ctx } = await load();
  const base1 = ctx.computeTableForTrack({ type: 'fibonacci', config: progressionCfg(1, NO_CAP) });
  const base2 = ctx.computeTableForTrack({ type: 'fibonacci', config: progressionCfg(2, NO_CAP) });
  assert.ok(base1.length > 3, 'the test ladder has several levels');
  assert.equal(base2.length, base1.length);
  base1.forEach((row, i) => {
    assert.equal(base2[i].c, row.c, `level ${row.level} stakes the same chips`);
    assert.equal(base2[i].totalBet, row.totalBet);
    assert.equal(base2[i].totalInvest, row.totalInvest);
    const money1 = moneyCents(row, 1).map((v) => v * 2);
    assert.deepEqual(moneyCents(base2[i], 2), money1, `level ${row.level} money is 2 times the 1.00 money`);
  });
});

test('at a fixed stop loss a larger base caps the ladder sooner, and the shorter ladder is a prefix of the other', async () => {
  const { ctx } = await load();
  const base1 = ctx.computeTableForTrack({ type: 'fibonacci', config: progressionCfg(1, 200) });
  const base2 = ctx.computeTableForTrack({ type: 'fibonacci', config: progressionCfg(2, 200) });
  assert.ok(base2.length <= base1.length);
  base2.forEach((row, i) => assert.equal(row.c, base1[i].c, `level ${i + 1} is the same rung`));
});

test('a Solution table and a Custom Bet table at base 2.00 are 2 times their 1.00 tables', async () => {
  const { ctx } = await load();
  const sol = (unit) => ({ type: 'solution', config: { unit, roi: 10, entryThreshold: 120, stopLoss: NO_CAP, activeBets: [] } });
  const cus = (unit) => ({ type: 'custom', config: { type: 'custom', unit, roi: 15, betMode: 'progression', stopLoss: NO_CAP, positions: [straight('17', 1), straight('5', 1)] } });
  for (const make of [sol, cus]) {
    const base1 = ctx.computeTableForTrack(make(1));
    const base2 = ctx.computeTableForTrack(make(2));
    assert.ok(base1.length > 0, `${make(1).type} has levels`);
    assert.equal(base2.length, base1.length, `${make(1).type} keeps its levels`);
    base1.forEach((row, i) => assert.deepEqual(moneyCents(base2[i], 2), moneyCents(row, 1).map((v) => v * 2), `${make(1).type} level ${row.level}`));
  }
});

test('Edit Config base change keeps the level, held bets and history, and the new base applies from the next bet', async () => {
  const { ctx } = await load();
  const original = {
    id: 'p1', type: 'fibonacci', color: '#f59e0b', state: 'active', level: 3, pnl: -42, wins: 1, sequences: 0,
    bets: [{ spinIdx: 4, level: 2, outcome: 'loss', profit: -6, cat: 'loss' }],
    config: progressionCfg(1, 200),
  };
  const newCfg = { ...original.config, unit: 2 };
  assert.equal(ctx.canEditInPlace(original, newCfg), true, 'a base-only change is edited in place');

  // The save App.jsx performs for an in-place edit: re-price the P&L, then replace the config.
  const track = JSON.parse(JSON.stringify(original));
  ctx.rebaseTrackPnl(track, newCfg.unit);
  track.config = ctx.editedTrackConfig(track.config, newCfg);
  assert.equal(track.id, original.id, 'the track is not recreated');
  assert.equal(track.state, 'active', 'the track is not parked');
  assert.equal(track.level, 3, 'the level is kept');
  assert.deepEqual(track.bets, original.bets, 'the history is kept');
  assert.equal(track.config.unit, 2);
  assert.equal(track.pnl * track.config.unit, -42, 'the P&L already recorded keeps its money');

  // The next bet is placed at the new base: a loss at level 3 costs the level's chips times 2.00.
  const row = ctx.computeTableForTrack(track)[3];
  const sess = ctx.newSession();
  sess.tracks = [track];
  const { totalDelta } = ctx.applySpin(sess, '0', true);
  assert.equal(Math.round(totalDelta * 100), -Math.round(row.c * 2 * 100), 'the loss is priced at the new base');
});

test('a Solution base change is in place too: held bets, levels and the chased number are kept', async () => {
  const { ctx } = await load();
  const track = {
    id: 's1', type: 'solution', color: '#fbbf24', state: 'active', level: 0, pnl: 10, wins: 0, sequences: 0, bets: [],
    config: { type: 'solution', unit: 1, roi: 10, entryThreshold: 120, stopLoss: 200, activeBets: [{ number: '17', level: 2, invest: 0 }], chaseNumber: '17' },
  };
  assert.equal(ctx.canEditInPlace(track, { ...track.config, unit: 0.5 }), true);
  const edit = { ...track.config, unit: 0.5 };
  ctx.rebaseTrackPnl(track, edit.unit);
  track.config = ctx.editedTrackConfig(track.config, edit);
  assert.deepEqual(track.config.activeBets, [{ number: '17', level: 2, invest: 0 }]);
  assert.equal(track.config.chaseNumber, '17');
  assert.equal(track.pnl * track.config.unit, 10, 'the Solution P&L keeps its money');
});

test('a Progression or Custom Bet edit that changes anything besides the base still parks the track', async () => {
  const { ctx } = await load();
  const prog = { id: 'p2', type: 'fibonacci', config: progressionCfg(1, 200) };
  assert.equal(ctx.canEditInPlace(prog, { ...prog.config, roi: 20 }), false, 'an ROI change parks the track, as before');
  assert.equal(ctx.canEditInPlace(prog, { ...prog.config, unit: 5, stopLoss: 300 }), false, 'a base change with a stop-loss change parks it');
  const cus = { id: 'c1', type: 'custom', config: { type: 'custom', unit: 1, roi: 15, betMode: 'flat', stopLoss: 200, positions: [straight('17', 1)] } };
  assert.equal(ctx.canEditInPlace(cus, { ...cus.config, unit: 2 }), true);
  assert.equal(ctx.canEditInPlace(cus, { ...cus.config, betMode: 'progression' }), false);
});

test('the table minimum warning never blocks: a base under the minimum is still applied, and the presets stay enabled', async () => {
  const { ctx } = await load();
  assert.equal(ctx.baseBelowTableMin(0.5, 10), true);
  assert.equal(ctx.baseBelowTableMin(10, 10), false);
  assert.equal(ctx.baseBelowTableMin(0.5, undefined), true, 'the minimum falls back to 1');
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.BaseBetInput, {
    type: 'fibonacci', config: progressionCfg(1, 200), currency: 'USD', tableMinBet: 10, onChange() {},
  }));
  assert.match(html, /Below the table minimum \(\$10\.00\)/);
  assert.doesNotMatch(html, /disabled=""/, 'no preset is disabled');
});

test('the base-bet control renders its presets, a custom field, and reserved slots that do not change with the warning', async () => {
  const { ctx } = await load();
  const render = (tableMinBet, unit) => ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.BaseBetInput, {
    type: 'fibonacci', config: progressionCfg(unit, 200), currency: 'USD', tableMinBet, onChange() {},
  }));
  const below = render(10, 1);
  const clear = render(0.5, 1);
  for (const html of [below, clear]) {
    for (const label of ['$0.25', '$0.50', '$1.00', '$2.00', '$5.00', '$10.00']) assert.match(html, new RegExp(label.replace('$', '\\$')), `preset ${label}`);
    assert.match(html, /aria-label="Custom base amount"/);
    assert.equal((html.match(/min-height:14px/g) || []).length, 2, 'the error line and the warning line each reserve their height');
    assert.doesNotMatch(html, /display:none/, 'no optional line is removed from layout (rule 82)');
    assert.match(html, /Table at this base/);
  }
  assert.match(below, /Below the table minimum \(\$10\.00\)[^<]*/);
  assert.match(below, /visibility:visible/);
  assert.match(clear, /visibility:hidden/);
});

test('the preview is the track table at the applied base, and names what it waits for when there is no table yet', async () => {
  const { ctx } = await load();
  const noTarget = ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.BaseBetInput, {
    type: 'fibonacci', config: { type: 'fibonacci', unit: 1, betMode: 'progression', dozenTargets: [], colTargets: [], evenTargets: [], stopLoss: 200 },
    currency: 'USD', tableMinBet: 1, onChange() {},
  }));
  assert.match(noTarget, /Pick a target to see the levels\./);
  const withRows = ReactDOMServer.renderToStaticMarkup(React.createElement(ctx.BaseBetInput, {
    type: 'fibonacci', config: progressionCfg(2, 200), currency: 'USD', tableMinBet: 1, onChange() {},
  }));
  const first = ctx.computeTableForTrack({ type: 'fibonacci', config: progressionCfg(2, 200) })[0];
  assert.match(withRows, new RegExp('\\$' + (first.totalBet * 2).toFixed(2).replace('.', '\\.')), 'level 1 bet per spin is shown at base 2.00');
});

test('money at a fractional base is rounded to cents for display, and a large base still formats', async () => {
  const { ctx } = await load();
  assert.equal(ctx.formatChips(3, 0.1, 'USD'), '$0.30');
  assert.equal(ctx.formatChips(7, 0.25, 'USD'), '$1.75');
  assert.equal(ctx.formatChips(1, 10000, 'USD'), '$10.0k');
  assert.equal(ctx.formatChips(7, 10000, 'USD'), '$70.0k');
});

test('class search: no code compares the base to the old fixed list, and only the base control reads the presets', async () => {
  const files = (await readdir(SRC, { recursive: true }))
    .filter((f) => /\.(js|jsx|mjs)$/.test(f));
  const all = new Map(); // keys use forward slashes on every platform
  for (const f of files) all.set(f.replace(/\\/g, '/'), await readFile(new URL(f.replace(/\\/g, '/'), SRC), 'utf8'));
  const problems = [];
  for (const [file, src] of all) {
    const norm = file.replace(/\\/g, '/');
    if (/\bunit\s*(===?|!==?)\s*[0-9]/.test(src)) problems.push(`${norm}: unit compared to a literal`);
    if (/\.unit\s*(===?|!==?)\s*[0-9]/.test(src)) problems.push(`${norm}: .unit compared to a literal`);
    if (/UNITS\s*\.\s*(includes|indexOf|find|findIndex|some|every|filter)\b/.test(src)) problems.push(`${norm}: UNITS used as a membership list`);
    if (/\[\s*0\.25\s*,\s*0\.50?\s*,\s*1\.00?\s*\]/.test(src)) problems.push(`${norm}: the old three-value list is still written out`);
    if (!/^(constants\.js|components\/BaseBetInput\.jsx)$/.test(norm) && /\bUNITS\b/.test(src)) problems.push(`${norm}: reads the preset list`);
  }
  assert.deepEqual(problems, []);
  const trackPanel = all.get('components/TrackPanel.jsx');
  assert.equal((trackPanel.match(/<BaseBetInput\b/g) || []).length, 2, 'setup and Edit Config both mount the one control (rule 80)');
});

test('wiring: build.js registers the control before TrackPanel, and App.jsx saves through the shared helpers', async () => {
  const build = await readFile(new URL('../nexus-src/build.js', import.meta.url), 'utf8');
  const app = await readFile(new URL('../nexus-src/src/App.jsx', import.meta.url), 'utf8');
  assert.ok(build.indexOf("'components/BaseBetInput.jsx'") > -1, 'registered in FILES');
  assert.ok(build.indexOf("'components/BaseBetInput.jsx'") < build.indexOf("'components/TrackPanel.jsx'"), 'before its first reader');
  assert.match(app, /const inPlace = canEditInPlace\(t,newCfg\);\s*if\(inPlace\) rebaseTrackPnl\(t,newCfg\.unit\);/, 'the rebase runs before the save');
  assert.ok(app.includes('if(t.type==="solution") { t.config=editedTrackConfig(t.config,newCfg); return; }'), 'the Solution save is unchanged');
  assert.ok(app.includes('if(inPlace) { t.config=editedTrackConfig(t.config,newCfg); return; }'), 'a base-only Progression or Custom save is in place');
});
