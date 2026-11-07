import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The config folder is read when the modules load, so point it at a temp folder first.
const home = await mkdtemp(join(tmpdir(), 'proxies-'));
process.env.XDG_CONFIG_HOME = home;
const { addProxies, listProxies, nameFor, recordTest, removeProxy, selectProxy, splitImport, updateProxy } = await import('../src/proxies.js');
const activeFile = join(home, 'wifi-extender', 'proxy.json');

const WG = `[Interface]
PrivateKey = ${'A'.repeat(43)}=
Address = 10.2.0.2/32
[Peer]
PublicKey = ${'B'.repeat(43)}=
Endpoint = 203.0.113.9:51820
AllowedIPs = 0.0.0.0/0`;

test('splitImport: one proxy per line, or each WireGuard config', () => {
  assert.deepEqual(splitImport('socks5://a:1\n\n# note\nhttp://b:2\n'), ['socks5://a:1', 'http://b:2']);
  assert.equal(splitImport(`${WG}\n${WG}`).length, 2);
  assert.deepEqual(splitImport('  '), []);
});

test('first proxy becomes active and is mirrored to proxy.json; the next ones are not', async () => {
  const a = await addProxies('socks5://u:secret@198.51.100.1:1080', 'Office');
  assert.equal(a.activated, true);
  assert.equal(JSON.parse(await readFile(activeFile, 'utf8')).host, '198.51.100.1');
  const b = await addProxies('http://198.51.100.2:8080\nsocks5://198.51.100.3:1080');
  assert.equal(b.activated, false);
  assert.equal(b.added.length, 2);
  const { proxies, activeId } = await listProxies();
  assert.equal(proxies.length, 3);
  assert.equal(proxies.find((p) => p.active).name, 'Office');
  assert.equal(activeId, a.added[0].id);
});

test('the list never exposes passwords or keys', async () => {
  await addProxies(WG, 'VPN');
  const json = JSON.stringify(await listProxies());
  assert.ok(!json.includes('secret'));
  assert.ok(!json.includes('AAAAAAAA'));
  assert.ok(json.includes('****'));
});

test('a bad entry adds nothing', async () => {
  const before = (await listProxies()).proxies.length;
  await assert.rejects(addProxies('socks5://198.51.100.9:1080\nnot a proxy'), /Entry 2/);
  assert.equal((await listProxies()).proxies.length, before);
});

test('selecting switches proxy.json; updating the active one rewrites it', async () => {
  const { proxies } = await listProxies();
  const other = proxies.find((p) => p.host === '198.51.100.2');
  const { previous } = await selectProxy(other.id);
  assert.ok(previous);
  assert.equal(JSON.parse(await readFile(activeFile, 'utf8')).host, '198.51.100.2');
  const r = await updateProxy(other.id, { name: 'Fast', raw: 'http://198.51.100.4:8080' });
  assert.equal(r.changed, true);
  assert.equal(JSON.parse(await readFile(activeFile, 'utf8')).host, '198.51.100.4');
  assert.equal((await updateProxy(proxies[0].id, { name: 'Renamed' })).changed, false);
});

test('test results are remembered; removing the active proxy clears proxy.json', async () => {
  const { proxies } = await listProxies();
  const active = proxies.find((p) => p.active);
  await recordTest(active.id, { ok: true, ip: '203.0.113.5', ms: 120 });
  assert.equal((await listProxies()).proxies.find((p) => p.active).lastTest.ip, '203.0.113.5');
  assert.equal((await removeProxy(active.id)).wasActive, true);
  await assert.rejects(readFile(activeFile, 'utf8'));
  assert.equal((await listProxies()).activeId, null);
});

test('nameFor', () => {
  assert.equal(nameFor({ type: 'socks5', host: 'h' }), 'SOCKS5 h');
  assert.equal(nameFor({ type: 'wireguard', host: 'h' }), 'WireGuard h');
});
