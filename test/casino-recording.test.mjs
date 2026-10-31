import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CASINO_BRIDGE_HELLO,
  CASINO_BRIDGE_OPERATIONS,
  CASINO_BRIDGE_REQUEST,
  CASINO_BRIDGE_RESPONSE,
  CASINO_SHELL_ORIGIN,
  openCasinoReadBoard,
  recordingForMode,
  mergeWagerSummaries,
  summarizeManualWagers,
  summarizeTrackWagers,
} from '../nexus-src/src/casino-recording.mjs';
import {
  createSpinQueue,
  isRecordingDisabledResult,
  nextSequenceForSession,
  sendCasinoSpinAndPause,
  sendCasinoSpinUntilReconciled,
} from '../nexus-src/src/casino-spin-queue.mjs';

const covers = (type, target) => {
  if(type === 'straight') return [String(target)];
  if(type === 'split') return String(target).split('-');
  return [];
};
const payout = (type) => type === 'straight' ? 36 : type === 'split' ? 18 : 0;

test('the Roulette client speaks the shell recording contract exactly', () => {
  assert.equal(CASINO_SHELL_ORIGIN, 'https://casino.nexus-foundry.ai');
  assert.equal(CASINO_BRIDGE_HELLO, 'nexus-casino:recording:hello');
  assert.equal(CASINO_BRIDGE_REQUEST, 'nexus-casino:recording:request');
  assert.equal(CASINO_BRIDGE_RESPONSE, 'nexus-casino:recording:response');
  assert.deepEqual(CASINO_BRIDGE_OPERATIONS, [
    'settings', 'history', 'start', 'pause', 'resume', 'stop', 'spin', 'layout', 'setLayout',
    'deleteSession', 'readState', 'writeState',
  ]);
});

test('manual table wagers preserve exact stake and gross return', () => {
  const result = summarizeManualWagers([
    {type:'straight',target:'17',amount:5},
    {type:'split',target:'16-17',amount:2},
    {type:'straight',target:'8',amount:3},
  ], '17', {betCoveredNumbers:covers,betPayoutMult:payout});
  assert.deepEqual(result, {
    stakes:{'manual:straight:17':5,'manual:split:16-17':2,'manual:straight:8':3},
    staked:10,
    returned:216,
  });
});

test('active strategy wagers use the pre-spin level and all overlapping wins', () => {
  const tracks = [{
    id:'progression-a',state:'active',type:'fibonacci',level:1,
    config:{unit:2,betMode:'progression',dozenTargets:[0],colTargets:[1],evenTargets:[]},
  }];
  const result = summarizeTrackWagers(tracks,'5',{
    computeTableForTrack:()=>[{c:1},{c:3}],evenMoney:[],
    dozenOf:()=>0,columnOf:()=>1,betCoveredNumbers:covers,betPayoutMult:payout,
  });
  assert.deepEqual(result, {
    stakes:{'track:progression-a:dozen:0':6,'track:progression-a:column:1':6},
    staked:12,
    returned:36,
  });
});

test('manual and strategy settlement merge without losing duplicate zones or decimals', () => {
  assert.deepEqual(mergeWagerSummaries(
    {stakes:{red:0.25},staked:0.25,returned:0.5},
    {stakes:{red:0.5,black:0.25},staked:0.75,returned:0},
  ),{stakes:{red:0.75,black:0.25},staked:1,returned:0.5});
});

test('CONTROL: a losing pocket does not receive the winning gross return', () => {
  const result = summarizeManualWagers(
    [{type:'straight',target:'17',amount:5}],
    '8',
    {betCoveredNumbers:covers,betPayoutMult:payout},
  );
  assert.equal(result.staked,5);
  assert.equal(result.returned,0);
});

test('an ambiguous spin is retried with the same sequence until the server reconciles it', async () => {
  const sent = [];
  const payload = {sessionId:'session-1',spin:{sequence:7,segment:'17',staked:5,returned:180}};
  const replies = [
    {ok:false,status:0,error:'timed out'},
    {ok:true,status:200,body:{recorded:false,session:{id:'session-1',spins:8}}},
  ];
  const result = await sendCasinoSpinUntilReconciled(
    payload,
    async (_op, value) => { sent.push(value); return replies.shift(); },
    async () => {},
  );
  assert.equal(result.ok,true);
  assert.equal(result.reconciled,true);
  assert.deepEqual(sent,[payload,payload]);
});

test('CONTROL: an unexplained duplicate sequence is not mistaken for the current spin', async () => {
  const result = await sendCasinoSpinUntilReconciled(
    {sessionId:'session-1',spin:{sequence:7,segment:'8',staked:5,returned:0}},
    async () => ({ok:true,status:200,body:{recorded:false,session:{id:'session-1',spins:8}}}),
    async () => {},
  );
  assert.equal(result.ok,false);
  assert.match(result.error,/already existed/);
});

test('an ambiguous spin retry is bounded so lifecycle controls cannot wait forever', async () => {
  let attempts=0;
  const result = await sendCasinoSpinUntilReconciled(
    {sessionId:'session-1',spin:{sequence:7,segment:'8',staked:5,returned:0}},
    async () => { attempts+=1; return {ok:false,status:0,error:'timed out'}; },
    async () => {},
  );
  assert.equal(attempts,3);
  assert.equal(result.ok,false);
  assert.equal(result.ambiguous,true);
  assert.match(result.error,/queued locally/);
});

test('recording-off is a definitive refusal, not a spin that may retry after re-enable', async () => {
  let calls=0;
  const result=await sendCasinoSpinUntilReconciled(
    {sessionId:'session-1',spin:{requestId:'24310fa2-4e39-4a73-8111-8e4e7bd77715',sequence:1,segment:'8'}},
    async()=>{calls+=1;return {ok:false,status:409,body:{error:'recording_disabled'}};},
    async()=>{},
  );
  assert.equal(calls,1);
  assert.equal(isRecordingDisabledResult(result),true);
  assert.equal(isRecordingDisabledResult({ok:false,status:409,body:{error:'sequence_conflict'}}),false);
});

test('leaving a mode sends the pending spin and pause in the first request', async () => {
  const sent=[];
  const pending={sessionId:'session-1',spin:{sequence:7,segment:'8',staked:5,returned:0}};
  const result=await sendCasinoSpinAndPause(
    pending,
    async (_op,value)=>{sent.push(value);return {ok:true,status:201,body:{recorded:true}};},
    async()=>{},
  );
  assert.equal(result.ok,true);
  assert.equal(sent.length,1);
  assert.deepEqual(sent[0],{...pending,spin:{...pending.spin,pauseAfter:true}});
});

test('Game and Live paths select their own central recorder', () => {
  const game={id:'game'};
  const live={id:'live'};
  assert.equal(recordingForMode('game',game,live),game);
  assert.equal(recordingForMode('live',game,live),live);
});

test('a new central session owns a fresh sequence while a refreshed session never moves backward', () => {
  assert.equal(nextSequenceForSession('old', 51, {id:'new',spins:0}), 1);
  assert.equal(nextSequenceForSession('same', 8, {id:'same',spins:10}), 11);
  assert.equal(nextSequenceForSession('same', 12, {id:'same',spins:10}), 12);
});

test('the built app wires both play modes to recording after splitting the legacy component', async () => {
  const app = await readFile(new URL('../nexus-src/src/App.jsx', import.meta.url), 'utf8');
  const secondary = await readFile(new URL('../nexus-src/src/components/SecondaryPages.jsx', import.meta.url), 'utf8');
  const build = await readFile(new URL('../nexus-src/build.js', import.meta.url), 'utf8');
  assert.ok(app.split('\n').length < 1500, 'App.jsx crossed the source ceiling again');
  assert.match(secondary, /function StatsPage/);
  assert.match(app, /gameRecording\.record\(\{segment:String\(val\),\.\.\.casinoWager,watched:casinoWager\.staked===0\}\)/);
  assert.match(app, /liveRecording\.record\(\{segment:String\(val\),\.\.\.casinoWager,watched:casinoWager\.staked===0\}\)/);
  assert.match(app, /const recording=recordingForMode\(appMode,gameRecording,liveRecording\);/);
  assert.match(app, /watched:wager\.staked===0/);
  assert.match(app, /recording\.record\(\{segment:String\(val\),\.\.\.mergeWagerSummaries\(\),watched:true\}\)/);
  assert.ok(build.indexOf("'casino-recording.mjs'") < build.indexOf("'App.jsx'"));
  assert.ok(build.indexOf("'casino-sync.mjs'") < build.indexOf("'App.jsx'"));
});

// The settings wait, the auto-pause on leaving a mode and the pause intent are behaviour checks against the
// hook in test/recording-queue.test.mjs. This one checks the queue's numbering and its refusal to send early.
test('a spin is numbered on a new session from one, and is never sent before its session exists', async () => {
  const sent = [];
  const resolutions = [{ ok: false, error: 'network down' }, { ok: true, session: { id: 'fresh', status: 'running', spins: 0 } }];
  const queue = createSpinQueue({
    resolveSession: async () => resolutions.shift(),
    send: async (_op, payload) => {
      sent.push(payload);
      return { ok: true, status: 201, body: { recorded: true, session: { id: 'fresh', status: 'running', spins: 1 } } };
    },
    wait: async () => {},
    pauseRequested: () => false,
    report: () => {},
    confirmed: () => {},
    recordingOff: () => {},
    reread: async () => ({ ok: true, session: null }),
    ended: () => {},
    drained: () => {},
    schedule: () => () => {},
  });
  queue.enqueue({ segment: '17', staked: 5, returned: 0, watched: false });
  assert.equal(await queue.flush(), false);
  assert.equal(sent.length, 0, 'a spin was sent before its session existed');
  assert.equal(await queue.flush(), true);
  assert.deepEqual(sent.map((payload) => [payload.sessionId, payload.spin.sequence]), [['fresh', 1]]);
});

test('the bridge answers only the Casino shell, and every request is addressed to its origin', async (t) => {
  const posted = [];
  const shell = { postMessage: (message, targetOrigin) => { posted.push({ message, targetOrigin }); } };
  const listeners = [];
  globalThis.window = {
    parent: shell,
    addEventListener(type, listener) { if (type === 'message') listeners.push(listener); },
  };
  t.after(() => { delete globalThis.window; });
  const deliver = (event) => listeners.slice().forEach((listener) => listener(event));
  const hello = { kind: CASINO_BRIDGE_HELLO, gameId: 'roulette' };

  // A hello from another origin, or from another window, does not make the bridge ready.
  deliver({ origin: 'https://example.invalid', source: shell, data: hello });
  deliver({ origin: CASINO_SHELL_ORIGIN, source: { postMessage() {} }, data: hello });
  assert.equal((await openCasinoReadBoard('american')).error, 'not-framed');
  assert.equal(posted.length, 0, 'a request went out before a genuine hello');

  deliver({ origin: CASINO_SHELL_ORIGIN, source: shell, data: hello });
  const answer = openCasinoReadBoard('european');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].targetOrigin, CASINO_SHELL_ORIGIN, 'the request was not addressed to the shell origin');

  // An answer from another origin is ignored. The genuine answer settles the request.
  const { id } = posted[0].message;
  deliver({ origin: 'https://example.invalid', source: shell, data: { kind: CASINO_BRIDGE_RESPONSE, id, ok: true, status: 200, body: {} } });
  deliver({ origin: CASINO_SHELL_ORIGIN, source: shell, data: { kind: CASINO_BRIDGE_RESPONSE, id, ok: true, status: 200, body: { genuine: true } } });
  assert.deepEqual(await answer, { ok: true, status: 200, body: { genuine: true }, error: null });
});

test('embedded notification permission routes to a top-level Roulette surface', async () => {
  const source = await readFile(new URL('../nexus-src/src/components/SimModePage.jsx', import.meta.url), 'utf8');
  const app = await readFile(new URL('../nexus-src/src/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /window\.parent!==window/);
  assert.match(source, /window\.open\(window\.location\.origin\+'\/\?enableNotifications=1'/);
  assert.match(source, /Open app to enable completion notifications/);
  assert.match(source, /function NotificationEnablePage/);
  assert.match(source, /Notification\.requestPermission\(\)/);
  assert.match(app, /<NotificationEnablePage\/>/);
});
