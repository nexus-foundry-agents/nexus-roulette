import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';

// TABLE-MIN-RULE: no table minimum by default, and a base under a minimum that is set is refused with its reason.
// The bundle is concatenated the way build.js does it (the FILES list is read from build.js), compiled, and run in a vm.
// The components are driven by a small hook runner copied from session-flows.test.mjs, not imported: importing a test
// file would run its tests a second time.

const SRC = new URL('../nexus-src/src/', import.meta.url);
const compiled = new Map();

const MIN_5_MESSAGE = 'This base bet is below your table minimum of $5.00. Change the bet size, or change the table limit in Settings.';

async function bundle(react, store) {
  const build = await readFile(new URL('../nexus-src/build.js', import.meta.url), 'utf8');
  const files = [...build.match(/const FILES = \[([\s\S]*?)\];/)[1].matchAll(/^\s*'([^']+)'/gm)].map((m) => m[1]);
  const sources = await Promise.all(files.map((f) => readFile(new URL(f, SRC), 'utf8')));
  const combined = files.map((f, i) => `\n// ===== ${f} =====\n${sources[i]}`).join('\n').replace(/\r\n?/g, '\n');
  if (!compiled.has(combined)) {
    compiled.set(combined, transformSync(combined, {
      babelrc: false,
      configFile: false,
      filename: 'app.jsx',
      presets: [
        [presetReact, { runtime: 'classic' }],
        [presetEnv, { targets: { ie: 11 }, modules: 'commonjs', useBuiltIns: false }],
      ],
    }).code);
  }
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    React: react,
    setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval() {},
    addEventListener() {}, removeEventListener() {},
    localStorage: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; },
    },
    require: (name) => {
      if (name === 'react') return react;
      throw new Error(`unexpected module in the bundle: ${name}`);
    },
  };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  sandbox.window = sandbox;
  sandbox.window.parent = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(compiled.get(combined), sandbox, { filename: 'table-min-rule-bundle.js' });
  sandbox.expr = (source) => vm.runInContext(source, sandbox);
  return sandbox;
}

// A hook runner for one component: useState and useEffect, rendered by hand. The bundle is loaded with this React, so
// the component's own hook calls land here. settle() renders, runs the changed effects, and renders again while state moves.
async function mount(name, makeProps, store = {}) {
  const hooks = [];
  const effects = [];
  let cursor = 0;
  let dirty = false;
  let tree = null;
  const changed = (before, after) => !before || !after || after.some((value, i) => !Object.is(value, before[i]));
  const react = { ...React,
    useState(initial) {
      const i = cursor++;
      if (!hooks[i]) hooks[i] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = hooks[i];
      if (!slot.set) {
        slot.set = (value) => {
          const next = typeof value === 'function' ? value(slot.value) : value;
          if (!Object.is(next, slot.value)) { slot.value = next; dirty = true; }
        };
      }
      return [slot.value, slot.set];
    },
    useEffect(run, deps) {
      const i = cursor++;
      if (!hooks[i] || changed(hooks[i].deps, deps)) {
        const previous = hooks[i];
        hooks[i] = { deps, cleanup: previous && previous.cleanup };
        effects.push(() => { if (hooks[i].cleanup) hooks[i].cleanup(); hooks[i].cleanup = run(); });
      }
    },
  };
  const ctx = await bundle(react, store);
  const Component = ctx.expr(name);
  function render() { cursor = 0; dirty = false; tree = Component(makeProps(ctx)); }
  function settle() {
    for (let i = 0; i < 20; i += 1) {
      render();
      effects.splice(0).forEach((run) => run());
      if (!dirty) return;
    }
    assert.fail(`${name} kept changing state`);
  }
  settle();
  return { ctx, tree: () => tree, settle };
}

// Every element under a node (depth first) that matches. Walks props.children only, which is where these components put their markup.
function elements(node, match, out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((child) => elements(child, match, out)); return out; }
  if (match(node)) out.push(node);
  return elements(node.props && node.props.children, match, out);
}

// The text a node renders, children joined in order.
function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props && node.props.children);
}

const act = (api, fn) => { fn(); api.settle(); };
const buttonNamed = (api, label) => {
  const hit = elements(api.tree(), (n) => n.type === 'button' && textOf(n) === label);
  assert.equal(hit.length, 1, `one button reads "${label}"`);
  return hit[0];
};
const clickPreset = (api, label) => act(api, () => buttonNamed(api, label).props.onClick());
const field = (api) => elements(api.tree(), (n) => n.type === 'input')[0];
const noteEl = (api) => elements(api.tree(), (n) => n.props && n.props.style && n.props.style.minHeight === 14)[0];
const noteText = (api) => textOf(noteEl(api)).trim();
const noteVisible = (api) => noteEl(api).props.style.visibility === 'visible';
const typeAndBlur = (api, text) => {
  act(api, () => field(api).props.onChange({ target: { value: text } }));
  act(api, () => field(api).props.onBlur());
};

// The base-bet control as a track panel mounts it: the applied base and the minimum live in state, and a base the control
// applies is written back the way the panel's draft does it.
const progressionCfg = (unit) => ({
  type: 'fibonacci', unit, roi: 15, betMode: 'progression', dozenTargets: [1], colTargets: [], evenTargets: [], stopLoss: 200,
});
async function baseBet(state) {
  const api = await mount('BaseBetInput', () => ({
    type: 'fibonacci',
    config: progressionCfg(state.unit),
    currency: 'USD',
    tableMinBet: state.min,
    onChange(v) { state.calls.push(v); state.unit = v; api.settle(); },
  }));
  return api;
}

async function loadedSettings(settings) {
  const store = {};
  const ctx = await bundle(React, store);
  store[ctx.expr('STORAGE_KEY')] = JSON.stringify({ settings });
  return JSON.parse(ctx.expr('JSON.stringify(loadApp().settings)'));
}

test('a new user has no table minimum, and every preset applies', async () => {
  const ctx = await bundle(React, {});
  assert.equal(JSON.parse(ctx.expr('JSON.stringify(defaultSettings())')).tableMinBet, null, 'the default is none, not 10');
  for (const none of [null, undefined, 0]) {
    const state = { unit: 1, min: none, calls: [] };
    const api = await baseBet(state);
    for (const label of ['$0.25', '$0.50', '$1.00', '$2.00', '$5.00', '$10.00']) clickPreset(api, label);
    assert.deepEqual(state.calls, [0.25, 0.5, 1, 2, 5, 10], `every preset applies with the minimum at ${String(none)}`);
    assert.equal(noteVisible(api), false, 'no reason line is shown with no minimum');
  }
});

test('with a minimum of 5, base 2 is refused with the exact message and the base is unchanged; base 5 applies', async () => {
  const state = { unit: 1, min: 5, calls: [] };
  const api = await baseBet(state);
  clickPreset(api, '$2.00');
  assert.deepEqual(state.calls, [], 'the refused preset is not applied');
  assert.equal(noteText(api), MIN_5_MESSAGE);
  assert.equal(noteVisible(api), true, 'the reason shows under the field');
  assert.equal(state.unit, 1, 'the previous base stays');

  typeAndBlur(api, '2');
  assert.deepEqual(state.calls, [], 'a typed 2 is refused too');
  assert.equal(noteText(api), MIN_5_MESSAGE);
  assert.equal(state.unit, 1);

  clickPreset(api, '$5.00');
  assert.deepEqual(state.calls, [5], 'base 5 applies');
  assert.equal(state.unit, 5);
  assert.equal(noteVisible(api), false, 'the reason clears once a base is applied');
});

test('a preset below the minimum stays visible, and tapping it shows the same message', async () => {
  const state = { unit: 10, min: 5, calls: [] };
  const api = await baseBet(state);
  assert.ok(buttonNamed(api, '$0.25'), 'the preset is still rendered');
  assert.equal(noteVisible(api), false, 'the applied base 10 is not under the minimum');
  clickPreset(api, '$0.25');
  assert.deepEqual(state.calls, []);
  assert.equal(noteText(api), MIN_5_MESSAGE);
  assert.equal(state.unit, 10, 'the applied base stays at 10');
});

test('the startup wizard starts its Min Bet at No minimum, and the minimum may be left there', async () => {
  const done = [];
  const api = await mount('OnboardingScreen', () => ({ onComplete: (choices) => done.push(choices) }));
  const next = () => act(api, () => buttonNamed(api, 'Next →').props.onClick());
  next(); next(); next();
  const row = () => elements(api.tree(), (n) => n.key === 'minBet')[0];
  const stepper = () => elements(row(), (n) => n.type === 'button');
  assert.match(textOf(row()), /No minimum/, 'Min Bet starts empty');
  assert.match(textOf(api.tree()), /A base bet below a Min Bet you set is refused/, 'the wizard copy states the refusal');
  act(api, () => stepper()[0].props.onClick());
  assert.match(textOf(row()), /No minimum/, 'minus from none does nothing');
  act(api, () => stepper()[1].props.onClick());
  assert.match(textOf(row()), /\$0\.25/, 'plus from none starts at $0.25');
  act(api, () => stepper()[0].props.onClick());
  assert.match(textOf(row()), /No minimum/, 'minus from $0.25 returns the minimum to none');
  next();
  act(api, () => buttonNamed(api, "Let's Play! 🎰").props.onClick());
  assert.equal(done.length, 1);
  assert.equal(done[0].tableMinBet, null, 'a minimum left at none is passed on as null');
});

test('Settings clears the minimum back to none, and says No minimum', async () => {
  const state = {
    settings: {
      currency: 'USD', defaultBuyIn: 100, vibration: true, showDroughtCounts: true, headStartUnseen: false,
      counterShows: 'spins', percentileOutlines: true, tableMinBet: 0.25, tableMaxBet: 500, tableMaxTotal: 10000,
    },
  };
  const api = await mount('SettingsPage', (ctx) => ({
    settings: state.settings, currency: 'USD', cur: ctx.expr('getCurrency("USD")'), sess: { roulette: 'american' },
    updApp(fn) { const wrap = { settings: JSON.parse(JSON.stringify(state.settings)) }; fn(wrap); state.settings = wrap.settings; api.settle(); },
    updSettings() {}, updSess() {}, setCurrencyOpen() {}, setChangelogOpen() {}, importJSON() {}, setHardResetOpen() {},
  }));
  const row = () => elements(api.tree(), (n) => n.key === 'tableMinBet')[0];
  const stepper = () => elements(row(), (n) => n.type === 'button');
  assert.match(textOf(row()), /\$0\.25/, 'the stored $0.25 shows');
  act(api, () => stepper()[0].props.onClick());
  assert.equal(state.settings.tableMinBet, null, 'minus from $0.25 clears the minimum to none');
  assert.match(textOf(row()), /No minimum/);
  assert.equal(state.settings.tableMaxBet, 500, 'the other limits are untouched');
  act(api, () => stepper()[0].props.onClick());
  assert.equal(state.settings.tableMinBet, null, 'minus from none does nothing');
  act(api, () => stepper()[1].props.onClick());
  assert.equal(state.settings.tableMinBet, 0.25, 'plus from none starts at $0.25');
});

test('the migration keeps a stored minimum, and gives none for a missing one (not an invented 10)', async () => {
  const base = { currency: 'USD', defaultBuyIn: 100, onboarded: true };
  assert.equal((await loadedSettings(base)).tableMinBet, null, 'missing is none');
  assert.equal((await loadedSettings({ ...base, tableMinBet: 25 })).tableMinBet, 25, 'a stored 25 is untouched');
  assert.equal((await loadedSettings({ ...base, tableMinBet: 0.5 })).tableMinBet, 0.5, 'a stored 0.5 is untouched');
  assert.equal((await loadedSettings({ ...base, tableMinBet: null })).tableMinBet, null, 'a stored none stays none');
  assert.equal((await loadedSettings(base)).tableMaxBet, 500, 'the other limits still migrate as they did');
});

test('the minimum is read as none for null, undefined and 0, and as the amount otherwise', async () => {
  const ctx = await bundle(React, {});
  assert.equal(ctx.expr('tableMinimum(null)'), null);
  assert.equal(ctx.expr('tableMinimum(undefined)'), null);
  assert.equal(ctx.expr('tableMinimum(0)'), null);
  assert.equal(ctx.expr('tableMinimum(5)'), 5);
  assert.equal(ctx.expr('baseBelowTableMin(0.25, null)'), false, 'nothing is under no minimum');
  assert.equal(ctx.expr('baseBelowTableMin(2, 5)'), true);
  assert.equal(ctx.expr('baseBelowTableMin(5, 5)'), false, 'a base equal to the minimum is allowed');
});

test('no tableMinBet fallback remains in the source, and the F16 note and the invented 10 are gone', async () => {
  const files = (await readdir(SRC, { recursive: true })).map((p) => p.replace(/\\/g, '/')).filter((p) => /\.(js|jsx|mjs)$/.test(p));
  const sources = await Promise.all(files.map((f) => readFile(new URL(f, SRC), 'utf8')));
  assert.ok(sources.length >= 20, `the scan covers the source (${sources.length} files)`);
  const reads = [];
  const fallbacks = [];
  files.forEach((f, i) => sources[i].split('\n').forEach((line, n) => {
    if (line.includes('tableMinBet')) reads.push(`${f}:${n + 1}`);
    if (/tableMinBet\s*\|\|/.test(line)) fallbacks.push(`${f}:${n + 1}`);
  }));
  assert.ok(reads.length > 0, 'the scan finds the tableMinBet reads it is checking');
  assert.deepEqual(fallbacks, [], 'no tableMinBet|| fallback');
  assert.equal(sources.some((s) => /Below the table minimum/.test(s)), false, 'the F16 note is gone');
  assert.equal(sources.some((s) => /tableMinBet:\s*10\b/.test(s)), false, 'no default of 10 remains');
});
