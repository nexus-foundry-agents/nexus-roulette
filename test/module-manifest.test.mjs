import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildModuleManifest, serializeModuleManifest } from '../nexus-src/module-manifest.mjs';
import {
  ROULETTE_BOARD_ROWS,
  detectRouletteGridBet,
  zeroCellBet,
} from '../nexus-src/src/roulette-bets.mjs';

function auditManifest(manifest) {
  const problems = [];
  const outcomeIds = new Set(manifest.outcomeSpace?.outcomes?.map((outcome) => outcome.id));
  const betIds = new Set();

  if (manifest.identity?.id !== 'roulette') problems.push('identity');
  if (manifest.surfaces?.play !== '/play') problems.push('surface');
  if (outcomeIds.size !== 38) problems.push('outcome count');
  for (const outcome of manifest.outcomeSpace?.outcomes ?? []) {
    if (outcome.weight !== 1) problems.push(`weight:${outcome.id}`);
  }
  for (const bet of manifest.bets ?? []) {
    if (betIds.has(bet.id)) problems.push(`duplicate bet:${bet.id}`);
    betIds.add(bet.id);
    if (!Array.isArray(bet.covers) || bet.covers.length === 0) problems.push(`empty bet:${bet.id}`);
    for (const covered of bet.covers ?? []) {
      if (!outcomeIds.has(covered)) problems.push(`unknown cover:${bet.id}:${covered}`);
    }
    if (bet.payout?.kind !== 'fixed' || !(bet.payout.toOne > 0)) {
      problems.push(`payout:${bet.id}`);
    }
  }
  return problems;
}

test('the Casino manifest describes the complete default American wheel', () => {
  const manifest = buildModuleManifest();
  assert.deepEqual(auditManifest(manifest), []);
  assert.equal(manifest.contractVersion, 1);
  assert.equal(manifest.identity.name, 'Roulette');
  assert.equal(manifest.outcomeSpace.weightBasis.kind, 'counted');
  assert.equal(manifest.bets.length, 161, 'the rendered American layout has 161 distinct controls');
  assert.deepEqual(manifest.stages, []);
  assert.equal(manifest.roundSchemaVersion, 1);

  const outside = new Map(manifest.bets.filter((bet) => bet.group === 'outside').map((bet) => [bet.id, bet]));
  assert.equal(outside.size, 12, 'six even-money, three dozens and three columns');
  assert.equal(outside.get('red').covers.includes('pocket-0'), false);
  assert.equal(outside.get('red').covers.includes('pocket-00'), false);
  assert.equal(outside.get('even').covers.includes('pocket-0'), false);
  assert.equal(outside.get('even').covers.includes('pocket-00'), false);

  const five = manifest.bets.find((bet) => bet.id === 'five-number');
  assert.deepEqual(five.covers, ['pocket-0', 'pocket-00', 'pocket-1', 'pocket-2', 'pocket-3']);
  assert.equal(five.payout.toOne, 6);

  const zeroSector = manifest.bets
    .filter((bet) => bet.covers.includes('pocket-0') || bet.covers.includes('pocket-00'))
    .map((bet) => [bet.id, bet.covers]);
  assert.deepEqual(zeroSector, [
    ['straight-0', ['pocket-0']],
    ['straight-00', ['pocket-00']],
    ['split-0-00', ['pocket-0', 'pocket-00']],
    ['split-0-3', ['pocket-0', 'pocket-3']],
    ['split-0-2', ['pocket-0', 'pocket-2']],
    ['split-00-2', ['pocket-00', 'pocket-2']],
    ['split-00-1', ['pocket-00', 'pocket-1']],
    ['trio-0-2-3', ['pocket-0', 'pocket-2', 'pocket-3']],
    ['trio-00-1-2', ['pocket-00', 'pocket-1', 'pocket-2']],
    ['trio-0-00-2', ['pocket-0', 'pocket-00', 'pocket-2']],
    ['five-number', ['pocket-0', 'pocket-00', 'pocket-1', 'pocket-2', 'pocket-3']],
  ], 'the declaration must match the zero-sector controls the application actually renders');
});

test('the committed module.json is byte-identical to fresh deterministic output', async () => {
  const committed = await readFile(new URL('../module.json', import.meta.url), 'utf8');
  assert.equal(committed, serializeModuleManifest());
});

test('every declared zero-cell bet is reachable through the rendered hit rules', () => {
  const actual = new Set([
    zeroCellBet('0', 0.25, 0.5, true),
    zeroCellBet('0', 0.75, 0.25, true),
    zeroCellBet('0', 0.75, 0.6, true),
    zeroCellBet('0', 0.25, 0.8, true),
    zeroCellBet('00', 0.25, 0.5, true),
    zeroCellBet('00', 0.75, 0.35, true),
    zeroCellBet('00', 0.75, 0.6, true),
  ].map((bet) => `${bet.type}:${bet.target}`));
  assert.deepEqual(actual, new Set([
    'straight:0', 'straight:00', 'split:0-00', 'split:0-3', 'split:0-2',
    'split:00-2', 'split:00-1',
  ]));
});

test('all 161 declared bets are selectable through the rendered table rules', () => {
  const idFor = (bet) => {
    if (bet.type === 'basket') return 'five-number';
    if (bet.type === 'street' && /(^|-)0(?:0)?(-|$)/.test(bet.target)) return `trio-${bet.target}`;
    const parts = bet.target.split('-');
    if (bet.type === 'street' || bet.type === 'corner' || bet.type === 'line') {
      return `${bet.type}-${parts[0]}-${parts.at(-1)}`;
    }
    return `${bet.type}-${bet.target}`;
  };
  const selectable = new Set();
  for (const row of ROULETTE_BOARD_ROWS) {
    for (const number of row) {
      for (const x of [0.1, 0.5, 0.9]) {
        for (const y of [0.1, 0.5, 0.9]) {
          selectable.add(idFor(detectRouletteGridBet(String(number), x, y, 1, 1)));
        }
      }
    }
  }
  for (const label of ['0', '00']) {
    for (const x of [0.25, 0.75]) {
      for (const y of [0.1, 0.35, 0.6, 0.8]) {
        selectable.add(idFor(zeroCellBet(label, x, y, true)));
      }
    }
  }
  for (let index = 1; index <= 3; index += 1) {
    selectable.add(`dozen-${index}`);
    selectable.add(`column-${index}`);
  }
  for (const outside of ['red', 'black', 'odd', 'even', 'low', 'high']) selectable.add(outside);

  const declared = new Set(buildModuleManifest().bets.map((bet) => bet.id));
  assert.equal(selectable.size, 161);
  assert.deepEqual([...selectable].sort(), [...declared].sort());
});

test('CONTROL: the manifest audit detects a bet covering an undeclared pocket', () => {
  const manifest = buildModuleManifest();
  manifest.bets[0].covers = ['pocket-not-on-the-wheel'];
  assert.match(auditManifest(manifest).join('\n'), /unknown cover/);
});

test('CONTROL: the exact zero-sector check notices a plausible but nonexistent split', () => {
  const manifest = buildModuleManifest();
  const split = manifest.bets.find((bet) => bet.id === 'split-0-3');
  split.id = 'split-0-1';
  split.covers = ['pocket-0', 'pocket-1'];
  const zeroIds = manifest.bets
    .filter((bet) => bet.covers.includes('pocket-0') || bet.covers.includes('pocket-00'))
    .map((bet) => bet.id);
  assert.equal(zeroIds.includes('split-0-3'), false);
  assert.equal(zeroIds.includes('split-0-1'), true);
});
