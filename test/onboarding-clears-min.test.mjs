import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from '@babel/core';
import presetEnv from '@babel/preset-env';
import presetReact from '@babel/preset-react';
import React from 'react';

// ONBOARDING-CLEARS-MIN: Restart Onboarding applies the wizard's Min Bet as given. "No minimum" stores none, and a number
// stores that number. completeOnboarding() in onboarding-apply.jsx used to write the minimum only when it was truthy, so a
// restart that left Min Bet at No minimum kept the old minimum.
// The bundle is concatenated the way build.js does it (the FILES list is read from build.js), compiled and run in a vm, as in
// table-min-rule.test.mjs. The wizard is driven by the same small hook runner, copied rather than imported: importing a test
// file would run its tests a second time.

const SRC = new URL('../nexus-src/src/', import.meta.url);
const plain = (value) => JSON.parse(JSON.stringify(value));
let compiled = null;

async function bundle(react, store) {
  const build = await readFile(new URL('../nexus-src/build.js', import.meta.url), 'utf8');
  const files = [...build.match(/const FILES = \[([\s\S]*?)\];/)[1].matchAll(/^\s*'([^']+)'/gm)].map((m) => m[1]);
  if (!compiled) {
    const sources = await Promise.all(files.map((f) => readFile(new URL(f, SRC), 'utf8')));
    const combined = files.map((f, i) => `\n// ===== ${f} =====\n${sources[i]}`).join('\n').replace(/\r\n?/g, '\n');
    compiled = transformSync(combined, {
      babelrc: false,
      configFile: false,
      filename: 'app.jsx',
      presets: [
        [presetReact, { runtime: 'classic' }],
        [presetEnv, { targets: { ie: 11 }, modules: 'commonjs', useBuiltIns: false }],
      ],
    }).code;
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
  vm.runInContext(compiled, sandbox, { filename: 'onboarding-clears-min-bundle.js' });
  sandbox.expr = (source) => vm.runInContext(source, sandbox);
  return sandbox;
}

// A hook runner for one component: useState and useEffect, rendered by hand. settle() renders, runs the changed effects, and
// renders again while state moves.
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

// Every element under a node (depth first) that matches, and the text a node renders.
function elements(node, match, out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((child) => elements(child, match, out)); return out; }
  if (match(node)) out.push(node);
  return elements(node.props && node.props.children, match, out);
}
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

// What Settings > Restart Onboarding leaves in the app state (onboarded off, the bankroll kept as the restart bankroll), with the
// stored limits given. Then completeOnboarding runs with the wizard's answers, as App hands them over.
function restart(ctx, stored, answers) {
  const settings = { ...plain(ctx.defaultSettings()), onboarded: false, _restartBankroll: 1000, ...stored };
  const app = { settings, currentSession: plain(ctx.newSession('american', 1000)) };
  ctx.completeOnboarding((fn) => fn(app), { roulette: 'american', bankroll: 1000, defaultBuyIn: 100, currency: 'USD', ...answers });
  return app.settings;
}

test('a restart from a minimum of 10, with the wizard left at No minimum, stores none', async () => {
  const done = [];
  const api = await mount('OnboardingScreen', () => ({ initialBankroll: 1000, onComplete: (choices) => done.push(choices) }));
  const next = () => act(api, () => buttonNamed(api, 'Next →').props.onClick());
  next(); next(); next();
  assert.match(textOf(api.tree()), /No minimum/, 'the Table Limits step opens with Min Bet at No minimum');
  next();
  act(api, () => buttonNamed(api, "Let's Play! 🎰").props.onClick());
  assert.equal(done.length, 1, 'the wizard completes once');
  assert.equal(done[0].tableMinBet, null, 'the wizard hands over none');

  const settings = restart(api.ctx, { tableMinBet: 10 }, done[0]);
  assert.equal(settings.tableMinBet, null, 'the restart stores none, so the stored 10 is cleared');
  assert.equal(settings.onboarded, true);
});

test('the restart stores the answer for the minimum: none to none, 10 to none, none to 5, 5 to 5', async () => {
  const ctx = await bundle(React, {});
  assert.equal(restart(ctx, { tableMinBet: null }, { tableMinBet: null }).tableMinBet, null, 'none to none');
  assert.equal(restart(ctx, { tableMinBet: 10 }, { tableMinBet: null }).tableMinBet, null, '10 to none');
  assert.equal(restart(ctx, { tableMinBet: null }, { tableMinBet: 5 }).tableMinBet, 5, 'none to 5');
  assert.equal(restart(ctx, { tableMinBet: 5 }, { tableMinBet: 5 }).tableMinBet, 5, '5 to 5');
  assert.equal(restart(ctx, { tableMinBet: 10 }, {}).tableMinBet, 10, 'a minimum that is not answered keeps the stored one');
});

test('Max Bet and Max Total are stored as the wizard gives them, and kept when not answered', async () => {
  const ctx = await bundle(React, {});
  const stored = { tableMaxBet: 2000, tableMaxTotal: 20000 };
  const given = restart(ctx, stored, { tableMinBet: null, tableMaxBet: 500, tableMaxTotal: 5000 });
  assert.equal(given.tableMaxBet, 500, 'Max Bet is stored as given');
  assert.equal(given.tableMaxTotal, 5000, 'Max Total is stored as given');
  const unanswered = restart(ctx, stored, { tableMinBet: null });
  assert.equal(unanswered.tableMaxBet, 2000, 'an unanswered Max Bet keeps the stored one');
  assert.equal(unanswered.tableMaxTotal, 20000, 'an unanswered Max Total keeps the stored one');
});

test('no truthy guard remains on the wizard answers in onboarding-apply.jsx, and the minimum goes through tableMinimum()', async () => {
  const source = await readFile(new URL('components/onboarding-apply.jsx', SRC), 'utf8');
  const guarded = source.split('\n').filter((line) => /if\(\s*(tableMinBet|tableMaxBet|tableMaxTotal)\s*\)/.test(line));
  assert.deepEqual(guarded, [], 'every wizard answer is applied as given, not skipped for being falsy');
  assert.match(source, /tableMinimum\(tableMinBet\)/, 'the minimum is read through the one helper in session.js');
});
