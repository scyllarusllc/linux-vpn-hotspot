import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// A setup from before the list existed: only proxy.json.
const home = await mkdtemp(join(tmpdir(), 'proxies-old-'));
process.env.XDG_CONFIG_HOME = home;
await mkdir(join(home, 'wifi-extender'));
await writeFile(join(home, 'wifi-extender', 'proxy.json'), JSON.stringify({ type: 'socks5', host: '198.51.100.7', port: 1080 }));
const { listProxies, selectProxy } = await import('../src/proxies.js');

test('the single proxy from before shows up as the active one, with a stable id', async () => {
  const a = await listProxies();
  const b = await listProxies();
  assert.equal(a.proxies.length, 1);
  assert.equal(a.proxies[0].active, true);
  assert.equal(a.proxies[0].id, b.proxies[0].id);
  await selectProxy(a.proxies[0].id);
  assert.equal((await listProxies()).activeId, 'imported');
});
