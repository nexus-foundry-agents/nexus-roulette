import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the deterministic app build consumes the pinned shared UI artifact', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const build = await readFile(new URL('../nexus-src/build.js', import.meta.url), 'utf8');
  const recording = await readFile(new URL('../nexus-src/src/casino-recording.mjs', import.meta.url), 'utf8');
  const notifications = await readFile(
    new URL('../nexus-src/src/components/SimModePage.jsx', import.meta.url),
    'utf8',
  );
  const output = await readFile(new URL('../index.html', import.meta.url), 'utf8');

  assert.equal(
    manifest.dependencies['@nexus-foundry/nf-ui'],
    'file:vendor/nexus-foundry-nf-ui-0.4.0.tgz',
  );
  assert.match(build, /@nexus-foundry\/nf-ui\/src\/tokens\.css/);
  assert.match(build, /@nexus-foundry\/nf-ui\/src\/nf-ui\.css/);
  assert.match(recording, /nf-btn nf-btn--danger nf-btn--sm/);
  assert.match(notifications, /nf-btn nf-btn--primary nf-btn--lg nf-btn--block/);
  assert.match(output, /Nexus Foundry UI — control surfaces/);
  assert.match(output, /\.nf-btn--primary/);
});
