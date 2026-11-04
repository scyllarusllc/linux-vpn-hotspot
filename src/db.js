// SQLite store (Node's built-in node:sqlite, no dependency).
// devices: latest known state per MAC. samples: one row per device per tick;
// a row with all-null values marks a gap (device left, or the server restarted).
// proxy_errors: connections the upstream proxy refused or failed. events: the /log
// timeline (device connects/disconnects, hotspot and admin actions). meta: key/value
// (e.g. the journal cursor the proxy log watcher resumes from).

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS devices (
    mac        TEXT PRIMARY KEY,
    hostname   TEXT,
    ip         TEXT,
    first_seen INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    online     INTEGER NOT NULL DEFAULT 0,
    info       TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS samples (
    mac    TEXT NOT NULL,
    t      INTEGER NOT NULL,
    down   REAL,
    up     REAL,
    signal INTEGER,
    link   REAL
  );
  CREATE INDEX IF NOT EXISTS samples_mac_t ON samples (mac, t);
  CREATE TABLE IF NOT EXISTS proxy_errors (
    t      INTEGER NOT NULL,
    ip     TEXT,
    mac    TEXT,
    host   TEXT NOT NULL,
    port   INTEGER NOT NULL,
    reason TEXT NOT NULL,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS proxy_errors_t ON proxy_errors (t);
  CREATE TABLE IF NOT EXISTS events (
    t      INTEGER NOT NULL,
    kind   TEXT NOT NULL,
    mac    TEXT,
    ip     TEXT,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS events_t ON events (t);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  // Columns added after the first release; ALTER only when missing.
  const cols = new Set(db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name));
  if (!cols.has('alias')) db.exec('ALTER TABLE devices ADD COLUMN alias TEXT');
  if (!cols.has('icon')) db.exec('ALTER TABLE devices ADD COLUMN icon TEXT');

  const q = {
    upsert: db.prepare(`
      INSERT INTO devices (mac, hostname, ip, first_seen, last_seen, online, info)
      VALUES (:mac, :hostname, :ip, :t, :t, 1, :info)
      ON CONFLICT (mac) DO UPDATE SET
        hostname = COALESCE(:hostname, hostname), ip = COALESCE(:ip, ip),
        last_seen = :t, online = 1, info = :info`),
    sample: db.prepare('INSERT INTO samples (mac, t, down, up, signal, link) VALUES (?, ?, ?, ?, ?, ?)'),
    gap: db.prepare('INSERT INTO samples (mac, t) VALUES (?, ?)'),
    offline: db.prepare('UPDATE devices SET online = 0 WHERE mac = ?'),
    onlineMacs: db.prepare('SELECT mac, ip, last_seen FROM devices WHERE online = 1'),
    event: db.prepare('INSERT INTO events (t, kind, mac, ip, detail) VALUES (:t, :kind, :mac, :ip, :detail)'),
    lastConnect: db.prepare("SELECT MAX(t) AS t FROM events WHERE mac = ? AND kind = 'connect'"),
    // Events plus proxy rejections (kind 'rejected') in one timeline, newest first.
    // :kinds is a comma list ('' = all); :mac '' = every device.
    events: db.prepare(`
      SELECT x.*, d.hostname, d.alias, d.icon FROM (
        SELECT t, kind, mac, ip, detail FROM events WHERE t >= :since
        UNION ALL
        SELECT t, 'rejected', mac, ip, host || ':' || port || ' — ' || reason FROM proxy_errors WHERE t >= :since
      ) x LEFT JOIN devices d ON d.mac = x.mac
      WHERE (:kinds = '' OR instr(',' || :kinds || ',', ',' || x.kind || ',') > 0)
        AND (:mac = '' OR x.mac = :mac)
      ORDER BY x.t DESC LIMIT :limit`),
    rejectsByMac: db.prepare(`
      SELECT mac, COUNT(*) AS n FROM proxy_errors WHERE t >= ? AND mac IS NOT NULL GROUP BY mac`),
    lastConnects: db.prepare(`
      SELECT mac, MAX(t) AS t FROM events WHERE kind = 'connect' AND t >= ? GROUP BY mac`),
    eventCounts: db.prepare(`
      SELECT kind, COUNT(*) AS n FROM events WHERE t >= ? GROUP BY kind`),
    pruneEvents: db.prepare('DELETE FROM events WHERE t < ?'),
    devices: db.prepare(`
      SELECT * FROM devices WHERE online = 1 OR last_seen >= ?
      ORDER BY online DESC, last_seen DESC`),
    // Average each bucket; a bucket of only gap rows stays null so the chart line breaks.
    // node:sqlite binds JS numbers as REAL, hence the CASTs for integer division.
    points: db.prepare(`
      SELECT (t / CAST(:b AS INTEGER)) * CAST(:b AS INTEGER) AS t, AVG(down) AS down, AVG(up) AS up,
             ROUND(AVG(signal)) AS signal, AVG(link) AS link
      FROM samples WHERE mac = :mac AND t >= :since
      GROUP BY 1 ORDER BY 1`),
    macForIp: db.prepare('SELECT mac FROM devices WHERE ip = ? ORDER BY last_seen DESC LIMIT 1'),
    proxyError: db.prepare(`
      INSERT INTO proxy_errors (t, ip, mac, host, port, reason, detail)
      VALUES (:t, :ip, :mac, :host, :port, :reason, :detail)`),
    errorTotals: db.prepare(`
      SELECT COUNT(*) AS total, COUNT(DISTINCT host) AS sites, COUNT(DISTINCT mac) AS devices
      FROM proxy_errors WHERE t >= ?`),
    errorsBySite: db.prepare(`
      SELECT e.host, e.port, e.reason, COUNT(*) AS count, MAX(e.t) AS last,
             GROUP_CONCAT(DISTINCT COALESCE(d.hostname, e.ip)) AS devices
      FROM proxy_errors e LEFT JOIN devices d ON d.mac = e.mac
      WHERE e.t >= ? GROUP BY e.host, e.port, e.reason ORDER BY count DESC, last DESC LIMIT 50`),
    errorsRecent: db.prepare(`
      SELECT e.t, e.ip, e.mac, d.hostname, e.host, e.port, e.reason, e.detail
      FROM proxy_errors e LEFT JOIN devices d ON d.mac = e.mac
      WHERE e.t >= ? ORDER BY e.t DESC LIMIT 100`),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
    setLabel: db.prepare('UPDATE devices SET alias = :alias, icon = :icon WHERE mac = :mac'),
    labels: db.prepare('SELECT mac, alias, icon FROM devices WHERE alias IS NOT NULL OR icon IS NOT NULL'),
    // Each sample is the average rate over one tick, so bytes = rate * tick / 8.
    usage: db.prepare(`
      SELECT s.mac, d.hostname, d.alias, d.icon,
             SUM(s.down) * :sec / 8 AS down, SUM(s.up) * :sec / 8 AS up, MAX(s.down) AS peak
      FROM samples s LEFT JOIN devices d ON d.mac = s.mac
      WHERE s.t >= :since GROUP BY s.mac ORDER BY down DESC`),
    seenSince: db.prepare('SELECT COUNT(*) AS n FROM devices WHERE last_seen >= ?'),
    errorsSince: db.prepare('SELECT COUNT(*) AS n FROM proxy_errors WHERE t >= ?'),
    pruneErrors: db.prepare('DELETE FROM proxy_errors WHERE t < ?'),
    pruneSamples: db.prepare('DELETE FROM samples WHERE t < ?'),
    pruneDevices: db.prepare('DELETE FROM devices WHERE online = 0 AND last_seen < ?'),
  };

  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      fn();
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  // The detail says how long the session lasted, from its connect event.
  function disconnected(d, t, why) {
    const since = q.lastConnect.get(d.mac)?.t;
    const detail = [since != null && since <= t ? `online ${Math.round((t - since) / 1000)}s` : null, why].filter(Boolean).join(', ');
    q.event.run({ t, kind: 'disconnect', mac: d.mac, ip: d.ip, detail: detail || null });
  }

  return {
    // seen: [{ client, point }] for this tick; every other online device goes offline.
    tick(t, seen) {
      tx(() => {
        const macs = new Set();
        const wasOnline = new Set(q.onlineMacs.all().map((r) => r.mac));
        for (const { client: c, point: p } of seen) {
          macs.add(c.mac);
          if (!wasOnline.has(c.mac)) q.event.run({ t, kind: 'connect', mac: c.mac, ip: c.ip ?? null, detail: c.signal == null ? null : `signal ${c.signal} dBm` });
          q.upsert.run({ mac: c.mac, hostname: c.hostname ?? null, ip: c.ip ?? null, t, info: JSON.stringify(c) });
          q.sample.run(c.mac, t, p.down, p.up, p.signal, p.link);
        }
        for (const d of q.onlineMacs.all()) {
          if (macs.has(d.mac)) continue;
          q.gap.run(d.mac, t);
          q.offline.run(d.mac);
          disconnected(d, t, null);
        }
      });
    },

    // After a restart nothing is known to be online; break every line that was.
    markAllOffline(t) {
      tx(() => {
        for (const d of q.onlineMacs.all()) {
          q.gap.run(d.mac, t);
          q.offline.run(d.mac);
          // Unknown when it really left; last_seen is the best guess.
          disconnected(d, d.last_seen, 'server was stopped');
        }
      });
    },

    devices(since, bucketMs) {
      return q.devices.all(since).map((d) => ({
        ...JSON.parse(d.info),
        mac: d.mac,
        hostname: d.hostname,
        alias: d.alias,
        icon: d.icon,
        ip: d.ip,
        firstSeen: d.first_seen,
        lastSeen: d.last_seen,
        online: d.online === 1,
        points: q.points.all({ b: bucketMs, mac: d.mac, since }).map((p) => ({ ...p })),
      }));
    },

    // e = { t, ip, host, port, reason, detail }; the MAC is looked up from the IP now,
    // since DHCP may hand the IP to another device later.
    recordProxyError(e) {
      const mac = e.ip ? q.macForIp.get(e.ip)?.mac ?? null : null;
      q.proxyError.run({ ...e, ip: e.ip ?? null, mac, detail: e.detail ?? null });
    },

    proxyErrors(since) {
      const plain = (rows) => rows.map((r) => ({ ...r }));
      return {
        ...q.errorTotals.get(since),
        bySite: plain(q.errorsBySite.all(since)),
        recent: plain(q.errorsRecent.all(since)),
      };
    },

    // A friendly name and Font Awesome icon chosen by the user (null clears them).
    setLabel(mac, { alias = null, icon = null }) {
      return q.setLabel.run({ mac, alias: alias || null, icon: icon || null }).changes > 0;
    },

    labels() {
      return new Map(q.labels.all().map((r) => [r.mac, { alias: r.alias, icon: r.icon }]));
    },

    // Bytes per device since a time, most downloaded first.
    usage(since, tickSeconds) {
      return q.usage.all({ since, sec: tickSeconds }).map((r) => ({ ...r }));
    },

    counts(since) {
      return { devices: q.seenSince.get(since).n, rejected: q.errorsSince.get(since).n };
    },

    // e = { t?, kind, mac?, ip?, detail? }
    addEvent(e) {
      q.event.run({ t: e.t ?? Date.now(), kind: e.kind, mac: e.mac ?? null, ip: e.ip ?? null, detail: e.detail ?? null });
    },

    events(since, { kinds = [], mac = '', limit = 500 } = {}) {
      return q.events.all({ since, kinds: kinds.join(','), mac, limit }).map((r) => ({ ...r }));
    },

    // { mac: n } proxy rejections since a time.
    rejectsByMac(since) {
      return Object.fromEntries(q.rejectsByMac.all(since).map((r) => [r.mac, r.n]));
    },

    // { mac: t } of the latest connect since a time.
    lastConnects(since) {
      return Object.fromEntries(q.lastConnects.all(since).map((r) => [r.mac, r.t]));
    },

    eventCounts(since) {
      return Object.fromEntries(q.eventCounts.all(since).map((r) => [r.kind, r.n]));
    },

    getMeta: (key) => q.getMeta.get(key)?.value ?? null,
    setMeta: (key, value) => q.setMeta.run(key, value),

    prune(before) {
      tx(() => {
        q.pruneErrors.run(before);
        q.pruneEvents.run(before);
        q.pruneSamples.run(before);
        q.pruneDevices.run(before);
      });
    },

    close: () => db.close(),
  };
}
