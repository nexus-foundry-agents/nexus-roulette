import assert from 'node:assert/strict';
import test from 'node:test';

import { writeRouletteStorage } from '../nexus-src/src/account-storage.mjs';

test('device-saved is supported only by an observed successful storage write', () => {
  const writes=[];
  assert.equal(writeRouletteStorage({setItem:(key,value)=>writes.push([key,value])},'roulette',{spins:[1]}),true);
  assert.deepEqual(writes,[['roulette','{"spins":[1]}']]);
});

test('a storage refusal returns false and reaches the visible failure path', () => {
  let observed=null;
  const quota=new Error('quota refused');
  assert.equal(writeRouletteStorage({setItem:()=>{throw quota;}},'roulette',{},(error)=>{observed=error;}),false);
  assert.equal(observed,quota);
  assert.equal(writeRouletteStorage({setItem:()=>{}},null,{}),false);
});
