import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function auditHostPolicy(source) {
  const required = [
    /server_name\s+roulette\.nexus-foundry\.ai;/,
    /frame-ancestors https:\/\/casino\.nexus-foundry\.ai/,
    /Access-Control-Allow-Origin[^\n]*https:\/\/casino\.nexus-foundry\.ai/,
    /location = \/module\.json/,
    /location = \/play/,
  ];
  return required.filter((pattern) => !pattern.test(source)).map((pattern) => pattern.source);
}

test('the committed module host policy is bounded to Casino and has no Google dependency', async () => {
  const source = await readFile(new URL('../deploy/roulette-nexus-foundry.conf', import.meta.url), 'utf8');
  assert.deepEqual(auditHostPolicy(source), []);
  assert.doesNotMatch(source, /Access-Control-Allow-Origin\s+['"]?\*/);
  assert.match(source, /Permissions-Policy/);
  assert.match(source, /root \/var\/www\/casino-module-roulette\/current;/);
  assert.doesNotMatch(source, /google|googleapis/i);
  assert.match(source, /connect-src 'self'/);
  assert.match(source, /frame-src 'none'/);
});

test('the one deploy script owns the module target and its public verification', async () => {
  const source = await readFile(new URL('../deploy.sh', import.meta.url), 'utf8');
  assert.match(source, /--module/);
  assert.match(source, /MODULE_ARTIFACTS=.*module\.json/);
  assert.match(source, /nginx -t/);
  assert.match(source, /roulette\.nexus-foundry\.ai\/module\.json/);
  assert.match(source, /roulette\.nexus-foundry\.ai\/play/);
  assert.match(source, /RELEASE_BRANCH="main"/);
  assert.doesNotMatch(source, /ROULETTE_BRANCH|ROULETTE_MODULE_DIR|ROULETTE_MODULE_URL|ROULETTE_MODULE_VHOST|ROULETTE_SSH_HOST|ROULETTE_REMOTE_DIR|ROULETTE_WEB_USER|ROULETTE_URL|ROULETTE_PAGES_REMOTE/);
  assert.match(source, /flock -x/);
  assert.match(source, /releases\/\$sha/);
  assert.match(source, /active="\$\(readlink "\$current"\)"/);
  assert.match(source, /\[ "\$active" = "releases\/\$sha" \]/);
  assert.match(source, /active_generation="\$\(cat "\$generation"/);
  assert.match(source, /\[ "\$active_generation" = "\$txn" \]/);
  assert.match(source, /DEPLOY_TXN=.*\$\{RANDOM\}/);
  assert.match(source, /backup="\$\{vhost\}\.bak-\$txn"/);
  assert.match(source, /rollback_module/);
  assert.match(source, /diff -qr "\$incoming" "\$release"/);
  assert.match(source, /edge preserves Casino frame ancestry/);
  assert.match(source, /edge preserves manifest CORS/);
  assert.match(source, /--all\)\s+DO_PROD=1; DO_MIRROR=1/);
  assert.doesNotMatch(source, /--all\)\s+[^\n]*DO_MODULE=1/);
});

test('the legacy staff target stages atomically and never mistakes an unreadable live copy for absence', async () => {
  const source = await readFile(new URL('../deploy.sh', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /REMOTE_PROBE'\s*\|\|\s*true/);
  assert.match(source, /refusing to classify a probe failure as first deploy/);
  assert.match(source, /roulette\.incoming-\$txn/);
  assert.match(source, /roulette\.rollback-\$txn/);
  assert.match(source, /mv "\$staged" "\$live"/);
  assert.match(source, /rollback_production/);
  assert.match(source, /PROD_BACKUP_ACTIVE=0/);
  assert.match(source, /old_moved=1/);
  assert.match(source, /rollback_recovery/);
  assert.match(source, /\[ ! -e "\$live" \].*\[ -d "\$failed" \]/);
  assert.doesNotMatch(source, /tar -xzf - -C "\\\$dir"/);
});

test('CONTROL: the host audit fails if the Casino frame-ancestor boundary disappears', async () => {
  const source = await readFile(new URL('../deploy/roulette-nexus-foundry.conf', import.meta.url), 'utf8');
  const weakened = source.replaceAll(
    'frame-ancestors https://casino.nexus-foundry.ai',
    "frame-ancestors 'none'",
  );
  assert.match(auditHostPolicy(weakened).join('\n'), /frame-ancestors/);
});
