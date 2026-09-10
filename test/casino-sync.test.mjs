import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  conflictCandidate,
  legacySnapshotModifiedAt,
  mergeRouletteSnapshots,
  nextLocalSyncMeta,
  nextResetSyncMeta,
  readRouletteSnapshot,
  rouletteSnapshot,
  syncMetaFromStored,
  shouldApplySyncReceipt,
} from '../nexus-src/src/casino-sync.mjs';

const session = (id, modified, spins = []) => ({ id, created: modified - 1, modified, spins, tracks: [] });

test('two devices union saved sessions while the newer envelope owns active slots', () => {
  const local = rouletteSnapshot({
    savedSessions: [session('shared', 20, ['1']), session('local', 10)],
    currentSession: session('current-local', 30),
    gameSession: session('game-local', 10),
    settings: { currency: 'USD' },
  }, { modifiedAt: 30, resetAt: 0 });
  const remote = rouletteSnapshot({
    savedSessions: [session('shared', 40, ['2']), session('remote', 25)],
    currentSession: session('current-remote', 15),
    gameSession: session('game-remote', 50),
    settings: { currency: 'EUR' },
  }, { modifiedAt: 50, resetAt: 0 });

  const merged = mergeRouletteSnapshots(local, remote);
  assert.deepEqual(merged.appState.savedSessions.map((item) => item.id), ['local', 'remote', 'shared']);
  assert.deepEqual(merged.appState.savedSessions.find((item) => item.id === 'shared').spins, ['2']);
  assert.equal(merged.appState.currentSession.id, 'current-remote');
  assert.equal(merged.appState.gameSession.id, 'game-remote');
  assert.equal(merged.appState.settings.currency, 'EUR');
});

test('a newer hard reset replaces rather than resurrecting older cloud sessions', () => {
  const old = rouletteSnapshot({ savedSessions: [session('old', 40)] }, { modifiedAt: 40, resetAt: 0 });
  const reset = rouletteSnapshot({ savedSessions: [], settings: { onboarded: false } }, { modifiedAt: 60, resetAt: 60 });
  assert.deepEqual(mergeRouletteSnapshots(old, reset), reset);
  assert.deepEqual(mergeRouletteSnapshots(reset, old), reset);
});

test('a reset wins an edit with the same millisecond timestamp', () => {
  const edit = rouletteSnapshot({ savedSessions: [session('same-tick', 60)] }, { modifiedAt: 60, resetAt: 0 });
  const reset = rouletteSnapshot({ savedSessions: [] }, { modifiedAt: 60, resetAt: 60 });
  assert.deepEqual(mergeRouletteSnapshots(edit, reset), reset);
  assert.deepEqual(mergeRouletteSnapshots(reset, edit), reset);
});

test('a reset epoch defeats a later offline edit that has not observed the reset', () => {
  const offline = rouletteSnapshot({ savedSessions: [session('pre-reset', 90)], currentSession: session('edited-offline', 110) }, { modifiedAt: 110, resetAt: 0 });
  const reset = rouletteSnapshot({ savedSessions: [], settings: { onboarded: false } }, { modifiedAt: 100, resetAt: 100 });
  assert.deepEqual(mergeRouletteSnapshots(offline, reset), reset);
  assert.deepEqual(mergeRouletteSnapshots(reset, offline), reset);
});

test('legacy local data keeps its recorded age instead of becoming new when opened', () => {
  const oldState = {
    savedSessions: [session('old', 40)],
    currentSession: session('current', 30),
    gameSession: session('game', 20),
    settings: { onboarded: true },
  };
  const local = rouletteSnapshot(oldState, { modifiedAt: legacySnapshotModifiedAt(oldState), resetAt: 0 });
  const reset = rouletteSnapshot({ savedSessions: [], settings: { onboarded: false } }, { modifiedAt: 60, resetAt: 60 });
  assert.equal(local.modifiedAt, 40);
  assert.deepEqual(mergeRouletteSnapshots(local, reset), reset);
});

test('first legacy sync retains its age and wins over a fresh second device', () => {
  const legacy = {
    savedSessions: [session('saved-before-sync', 80)],
    currentSession: session('current-before-sync', 70),
    gameSession: session('game-before-sync', 60),
    settings: { onboarded: true, currency: 'EUR' },
  };
  const firstMeta = syncMetaFromStored(null, legacy);
  assert.equal(firstMeta.modifiedAt, 80);

  const remote = rouletteSnapshot(legacy, firstMeta);
  const fresh = {
    savedSessions: [],
    currentSession: session('fresh-current', Date.now()),
    gameSession: session('fresh-game', Date.now()),
    settings: { onboarded: false, currency: 'USD' },
  };
  const secondMeta = syncMetaFromStored(null, fresh);
  assert.equal(secondMeta.modifiedAt, 0, 'factory session timestamps are not account-state edits');
  const merged = mergeRouletteSnapshots(rouletteSnapshot(fresh, secondMeta), remote);

  assert.equal(merged.appState.settings.currency, 'EUR');
  assert.equal(merged.appState.currentSession.id, 'current-before-sync');
  assert.deepEqual(merged.appState.savedSessions.map((item) => item.id), ['saved-before-sync']);
});

test('a conflict merges the latest local edit and a stale receipt cannot replace it', () => {
  const queued = rouletteSnapshot({
    savedSessions: [], currentSession: session('queued', 100), settings: { currency: 'USD' },
  }, { modifiedAt: 100, resetAt: 0 });
  const remote = rouletteSnapshot({
    savedSessions: [session('remote-history', 105)], currentSession: session('remote', 105),
    settings: { currency: 'EUR' },
  }, { modifiedAt: 105, resetAt: 0 });
  const latestLocal = rouletteSnapshot({
    savedSessions: [], currentSession: session('latest-edit', 110), settings: { currency: 'GBP' },
  }, { modifiedAt: 110, resetAt: 0 });

  const retry = conflictCandidate(queued, remote, latestLocal);
  assert.equal(retry.appState.currentSession.id, 'latest-edit');
  assert.equal(retry.appState.settings.currency, 'GBP');
  assert.deepEqual(retry.appState.savedSessions.map((item) => item.id), ['remote-history']);
  assert.equal(shouldApplySyncReceipt(1, 2), false);
  assert.equal(shouldApplySyncReceipt(2, 2), true);
});

test('a real standalone change advances metadata while retaining a reset tombstone', () => {
  assert.deepEqual(nextLocalSyncMeta({ modifiedAt: 40, resetAt: 30 }, 75), {
    modifiedAt: 75,
    resetAt: 30,
  });
});

test('local edits and resets advance beyond clocks adopted from another device', () => {
  const future = { modifiedAt: 500, resetAt: 450 };
  assert.deepEqual(nextLocalSyncMeta(future, 100), { modifiedAt: 501, resetAt: 450 });
  const reset = nextResetSyncMeta(future, 100);
  assert.deepEqual(reset, { modifiedAt: 501, resetAt: 501 });
  assert.deepEqual(nextLocalSyncMeta(reset, 100), { modifiedAt: 502, resetAt: 501 });
});

test('equal-clock conflicting snapshots merge identically in either order', () => {
  const left = rouletteSnapshot({
    savedSessions: [session('same', 50, ['1'])],
    currentSession: session('left-active', 50),
    settings: { currency: 'EUR' },
  }, { modifiedAt: 50, resetAt: 0 });
  const right = rouletteSnapshot({
    savedSessions: [session('same', 50, ['2'])],
    currentSession: session('right-active', 50),
    settings: { currency: 'USD' },
  }, { modifiedAt: 50, resetAt: 0 });
  assert.equal(
    JSON.stringify(mergeRouletteSnapshots(left, right)),
    JSON.stringify(mergeRouletteSnapshots(right, left)),
  );
});

test('unsupported or malformed account state is refused', () => {
  assert.equal(readRouletteSnapshot(null), null);
  assert.equal(readRouletteSnapshot({ schema: 2, appState: {} }), null);
  assert.equal(readRouletteSnapshot({ schema: 1, appState: [] }), null);
});

test('the app wires visible local-first account sync and a reset tombstone', async () => {
  const app = await readFile(new URL('../nexus-src/src/App.jsx', import.meta.url), 'utf8');
  const modal = await readFile(new URL('../nexus-src/src/components/modals.jsx', import.meta.url), 'utf8');
  const sync = await readFile(new URL('../nexus-src/src/casino-sync.mjs', import.meta.url), 'utf8');
  const storage = await readFile(new URL('../nexus-src/src/session.js', import.meta.url), 'utf8');
  assert.match(app, /useCasinoAccountSync\(appState,setAppState\)/);
  assert.match(app, /<CasinoSyncBar sync=\{casinoSync\}\/>/);
  assert.ok(
    app.indexOf('casinoSync.status==="checking"') < app.indexOf('if(!settings.onboarded)'),
    'account hydration must gate interaction before the onboarding early return',
  );
  assert.match(modal, /markRouletteAccountReset\(\)/);
  assert.match(sync, /expectedRevision:revision\.current/);
  assert.match(sync, /result\.status!==409/);
  assert.match(sync, /Saved on this device/);
  assert.match(sync, /scopeFromResponse\(result\)/);
  assert.match(sync, /beginRouletteAccountStorage\(scope\)/);
  assert.match(sync, /const local=rouletteSnapshot\(scopedApp,meta\.current\)/);
  assert.match(sync, /applySnapshot\(local\)/);
  assert.match(sync, /return \{status,problem,deviceSaved\}/);
  assert.doesNotMatch(sync, /applySnapshot\(next\)/);
  assert.match(storage, /base\+'\:account\:'\+rouletteAccountStorageScope/);
  assert.match(storage, /if\(!key\|\|!rouletteAccountStorageWritable\)return/);
});

test('Google sign-in and Drive backup were removed from source and build inputs', async () => {
  const build = await readFile(new URL('../nexus-src/build.js', import.meta.url), 'utf8');
  const app = await readFile(new URL('../nexus-src/src/App.jsx', import.meta.url), 'utf8');
  const settings = await readFile(new URL('../nexus-src/src/components/SecondaryPages.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(build, /drive-sync|accounts\.google/i);
  assert.doesNotMatch(app, /drive|google/i);
  assert.doesNotMatch(settings, /drive|google/i);
});
