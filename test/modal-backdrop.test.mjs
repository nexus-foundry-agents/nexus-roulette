import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { transformSync } from '@babel/core';
import presetReact from '@babel/preset-react';

// Evaluates the real Modal from ui.jsx (transpiled from source, not copied) against a minimal
// React stand-in.
async function loadModal() {
  const source = await readFile(new URL('../nexus-src/src/components/ui.jsx', import.meta.url), 'utf8');
  const { code } = transformSync(source, {
    babelrc: false,
    configFile: false,
    filename: 'ui.jsx',
    presets: [[presetReact, { runtime: 'classic' }]],
  });
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useRef: (current) => ({ current }),
  };
  return new Function('React', `${code}\nreturn Modal;`)(React);
}

function harness(modal) {
  const state = { closes: 0 };
  const onClose = () => { state.closes += 1; };
  const tree = modal({ onClose, children: null });
  const dialog = { name: 'element inside the dialog' };
  // Each event carries the backdrop as currentTarget, as React delivers it, and the element the
  // pointer was over as target.
  const at = (target, button = 0) => ({ target, currentTarget: tree, button });
  const down = (target, button = 0) => tree.props.onPointerDown(at(target, button));
  const up = (target, button = 0) => tree.props.onPointerUp(at(target, button));
  const cancel = () => tree.props.onPointerCancel(at(tree));
  const click = (target, button = 0) => tree.props.onClick(at(target, button));
  // A full press as a browser delivers it: pointerdown and pointerup where the pointer went down
  // and came up, then a click for the primary button on the nearest common ancestor of the two.
  // When both ends are inside the dialog that ancestor is inside it, and the dialog's click handler
  // stops propagation, so the backdrop never receives the click.
  function press(downAt, upAt) {
    down(downAt);
    up(upAt);
    if (downAt === tree || upAt === tree) click(tree);
  }
  return { tree, dialog, state, onClose, down, up, cancel, click, press };
}

test('the backdrop tracks the press and dismisses from its click', async () => {
  const { tree } = harness(await loadModal());
  assert.equal(typeof tree.props.onPointerDown, 'function');
  assert.equal(typeof tree.props.onPointerUp, 'function');
  assert.equal(typeof tree.props.onPointerCancel, 'function');
  assert.equal(typeof tree.props.onClick, 'function');
});

test('a press and click on the backdrop closes the dialog once', async () => {
  const h = harness(await loadModal());
  h.press(h.tree, h.tree);
  assert.equal(h.state.closes, 1);
});

test('a press inside the dialog whose click arrives on the backdrop does not close it', async () => {
  const h = harness(await loadModal());
  h.down(h.dialog);
  h.up(h.tree);
  h.click(h.tree); // the common-ancestor click for a drag from inside to the backdrop
  assert.equal(h.state.closes, 0);
});

test('a press on the backdrop released inside the dialog does not close it', async () => {
  const h = harness(await loadModal());
  h.down(h.tree);
  h.up(h.dialog);
  h.click(h.tree); // the common-ancestor click for a drag from the backdrop into the dialog
  assert.equal(h.state.closes, 0);
});

test('closing happens on click, never on pointerup alone', async () => {
  const h = harness(await loadModal());
  h.down(h.tree);
  h.up(h.tree); // no click follows
  assert.equal(h.state.closes, 0);
});

test('a press that starts and ends inside the dialog does not close it', async () => {
  const h = harness(await loadModal());
  h.press(h.dialog, h.dialog);
  assert.equal(h.state.closes, 0);
});

test('a non-primary button press on the backdrop does not close it', async () => {
  const h = harness(await loadModal());
  h.down(h.tree, 2);
  h.up(h.tree, 2);
  h.click(h.tree, 2); // browsers do not send a click for this button; if one arrived, the flag still refuses it
  assert.equal(h.state.closes, 0);
});

test('a cancelled press does not close on a later click', async () => {
  const h = harness(await loadModal());
  h.down(h.tree);
  h.cancel();
  h.click(h.tree);
  assert.equal(h.state.closes, 0);
});

test('each click clears the press record', async () => {
  const h = harness(await loadModal());
  h.press(h.tree, h.tree);
  assert.equal(h.state.closes, 1);
  h.click(h.tree); // a click with no press before it
  assert.equal(h.state.closes, 1);
});

test('CONTROL: the naive backdrop check closes on a drag from inside, so that case can fail', async () => {
  const h = harness(await loadModal());
  // The banned pattern from the frontend UI conventions, put in place of the real onClick. The
  // predicate differs from the shipped handler (no press or release flags), which is what makes
  // this arm a control and not just a relabelled copy.
  h.tree.props.onClick = (e) => { if (e.target === e.currentTarget) h.onClose(); };
  h.down(h.dialog);
  h.up(h.tree);
  h.click(h.tree);
  assert.equal(h.state.closes, 1);
});
