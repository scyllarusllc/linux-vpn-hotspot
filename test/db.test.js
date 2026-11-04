import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openStore } from '../src/db.js';

const phone = (extra = {}) => ({ mac: 'aa:bb:cc:dd:ee:ff', hostname: 'phone', ip: '10.0.0.5', signal: -40, ...extra });
const point = (down, up = 0) => ({ down, up, signal: -40, link: 100 });

test('tick stores the device and its samples', () => {
  const s = openStore(':memory:');
  s.tick(5000, [{ client: phone({ txBitrate: 100 }), point: point(null) }]);
  s.tick(10000, [{ client: phone({ txBitrate: 200 }), point: point(1000) }]);
  const [d] = s.devices(0, 5000);
  assert.equal(d.hostname, 'phone');
  assert.equal(d.online, true);
  assert.equal(d.firstSeen, 5000);
  assert.equal(d.lastSeen, 10000);
  assert.equal(d.txBitrate, 200, 'latest station fields come back');
  assert.deepEqual(d.points.map((p) => [p.t, p.down]), [[5000, null], [10000, 1000]]);
});

test('a missing device goes offline with a gap, and keeps its last hostname', () => {
  const s = openStore(':memory:');
  s.tick(5000, [{ client: phone(), point: point(1000) }]);
  s.tick(10000, []);
  s.tick(15000, [{ client: phone({ hostname: null }), point: point(2000) }]);
  const [d] = s.devices(0, 5000);
  assert.equal(d.hostname, 'phone');
  assert.deepEqual(d.points.map((p) => p.down), [1000, null, 2000]);
});

test('points average into buckets', () => {
  const s = openStore(':memory:');
  for (const [t, v] of [[0, 100], [5000, 300], [10000, 500], [15000, 700]]) {
    s.tick(t, [{ client: phone(), point: point(v) }]);
  }
  const [d] = s.devices(0, 10000);
  assert.deepEqual(d.points.map((p) => [p.t, p.down]), [[0, 200], [10000, 600]]);
});

test('markAllOffline and prune', () => {
  const s = openStore(':memory:');
  s.tick(1000, [{ client: phone(), point: point(1) }]);
  s.markAllOffline(2000);
  assert.equal(s.devices(0, 1000)[0].online, false);
  assert.equal(s.devices(5000, 1000).length, 0, 'offline and not seen since 5000');
  s.prune(3000);
  assert.equal(s.devices(0, 1000).length, 0);
});

test('proxy errors are linked to the device by IP and summarised per site', () => {
  const s = openStore(':memory:');
  s.tick(1000, [{ client: phone(), point: point(1) }]);
  const err = { host: 'imap.mail.me.com', port: 993, reason: 'rejected: not allowed by proxy rules', detail: 'code=2' };
  s.recordProxyError({ t: 2000, ip: '10.0.0.5', ...err });
  s.recordProxyError({ t: 3000, ip: '10.0.0.5', ...err });
  s.recordProxyError({ t: 4000, ip: '10.0.0.99', host: 'a.com', port: 443, reason: 'timeout' });

  const r = s.proxyErrors(0);
  assert.equal(r.total, 3);
  assert.equal(r.sites, 2);
  const { detail, ...site } = err;
  assert.deepEqual(r.bySite[0], { ...site, count: 2, last: 3000, devices: 'phone' });
  assert.equal(r.bySite[1].devices, '10.0.0.99', 'unknown device falls back to its IP');
  assert.equal(r.recent[0].host, 'a.com');
  assert.equal(r.recent[1].hostname, 'phone');
  assert.equal(s.proxyErrors(3500).total, 1);

  s.setMeta('cursor', 'abc');
  assert.equal(s.getMeta('cursor'), 'abc');
  s.prune(3500);
  assert.equal(s.proxyErrors(0).total, 1);
});

test('labels and usage stats', () => {
  const s = openStore(':memory:');
  const other = { client: phone({ mac: '11:22:33:44:55:66', hostname: 'laptop' }), point: point(800, 80) };
  s.tick(5000, [{ client: phone(), point: point(8000, 800) }, other]);
  s.tick(10000, [{ client: phone(), point: point(16000, 0) }, other]);

  assert.equal(s.setLabel('aa:bb:cc:dd:ee:ff', { alias: "Alex's phone", icon: 'mobile-screen' }), true);
  assert.equal(s.setLabel('00:00:00:00:00:00', { alias: 'x' }), false, 'unknown device');
  assert.deepEqual(s.labels().get('aa:bb:cc:dd:ee:ff'), { alias: "Alex's phone", icon: 'mobile-screen' });
  assert.equal(s.devices(0, 5000).find((d) => d.mac === 'aa:bb:cc:dd:ee:ff').alias, "Alex's phone");

  const [top, second] = s.usage(0, 5);
  assert.equal(top.alias, "Alex's phone");
  assert.equal(top.down, ((8000 + 16000) * 5) / 8);
  assert.equal(top.peak, 16000);
  assert.equal(second.hostname, 'laptop');
  assert.deepEqual(s.counts(0), { devices: 2, rejected: 0 });

  s.setLabel('aa:bb:cc:dd:ee:ff', {});
  assert.equal(s.labels().size, 0, 'empty label clears');
});

test('opening an older database adds the new columns', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const path = join(mkdtempSync(join(tmpdir(), 'wx-')), 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE devices (mac TEXT PRIMARY KEY, hostname TEXT, ip TEXT, first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL, online INTEGER NOT NULL DEFAULT 0, info TEXT NOT NULL DEFAULT '{}')`);
  old.exec("INSERT INTO devices VALUES ('aa:bb:cc:dd:ee:ff', 'phone', null, 1, 1, 0, '{}')");
  old.close();
  const s = openStore(path);
  assert.equal(s.setLabel('aa:bb:cc:dd:ee:ff', { alias: 'P' }), true);
  s.close();
});

test('connects and disconnects are logged with the session length', () => {
  const s = openStore(':memory:');
  s.tick(5000, [{ client: phone(), point: point(1) }]);
  s.tick(10000, [{ client: phone(), point: point(1) }]);
  s.tick(65000, []);
  s.tick(70000, [{ client: phone({ ip: '10.0.0.6' }), point: point(1) }]);
  const ev = s.events(0).map((e) => [e.t, e.kind, e.ip, e.detail, e.hostname]);
  assert.deepEqual(ev, [
    [70000, 'connect', '10.0.0.6', 'signal -40 dBm', 'phone'],
    [65000, 'disconnect', '10.0.0.5', 'online 60s', 'phone'],
    [5000, 'connect', '10.0.0.5', 'signal -40 dBm', 'phone'],
  ]);
  assert.deepEqual(s.eventCounts(0), { connect: 2, disconnect: 1 });
});

test('a restart logs a disconnect at last_seen', () => {
  const s = openStore(':memory:');
  s.tick(5000, [{ client: phone(), point: point(1) }]);
  s.tick(9000, [{ client: phone(), point: point(1) }]);
  s.markAllOffline(50000);
  const [e] = s.events(0, { kinds: ['disconnect'] });
  assert.equal(e.t, 9000);
  assert.equal(e.detail, 'online 4s, server was stopped');
});

test('the log merges admin events and proxy rejections, filtered by kind and device', () => {
  const s = openStore(':memory:');
  s.tick(1000, [{ client: phone(), point: point(1) }]);
  s.addEvent({ t: 2000, kind: 'hotspot', detail: 'Hotspot started' });
  s.recordProxyError({ t: 3000, ip: '10.0.0.5', host: 'a.com', port: 443, reason: 'timeout' });
  assert.deepEqual(s.events(0).map((e) => e.kind), ['rejected', 'hotspot', 'connect']);
  assert.equal(s.events(0, { kinds: ['rejected'] })[0].detail, 'a.com:443 — timeout');
  assert.equal(s.events(0, { kinds: ['rejected'] })[0].mac, 'aa:bb:cc:dd:ee:ff');
  assert.deepEqual(s.events(0, { mac: 'aa:bb:cc:dd:ee:ff' }).map((e) => e.kind), ['rejected', 'connect']);
  assert.deepEqual(s.events(0, { kinds: ['hotspot', 'server'] }).map((e) => e.kind), ['hotspot']);
  s.prune(2500);
  assert.deepEqual(s.events(0).map((e) => e.kind), ['rejected']);
});

test('rejectsByMac and lastConnects feed the map badges', () => {
  const s = openStore(':memory:');
  s.tick(1000, [{ client: phone(), point: point(1) }]);
  s.recordProxyError({ t: 2000, ip: '10.0.0.5', host: 'a.com', port: 443, reason: 'timeout' });
  s.recordProxyError({ t: 3000, ip: '10.0.0.5', host: 'b.com', port: 443, reason: 'timeout' });
  assert.deepEqual(s.rejectsByMac(0), { 'aa:bb:cc:dd:ee:ff': 2 });
  assert.deepEqual(s.rejectsByMac(2500), { 'aa:bb:cc:dd:ee:ff': 1 });
  assert.deepEqual(s.lastConnects(0), { 'aa:bb:cc:dd:ee:ff': 1000 });
  assert.deepEqual(s.lastConnects(1500), {});
});
