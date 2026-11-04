// Follows sing-box's journal and records connections the upstream proxy
// refused or failed into SQLite, linked to the hotspot client that made them.
// sing-box logs "inbound connection from <ip>" and the later failure under the
// same connection id, so ids are remembered for a few minutes to join the two.
// The journal cursor is saved, so after a restart it resumes without gaps or repeats.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseSingBoxLine } from './parse.js';
import { UNIT } from './proxy.js';

const CURSOR_KEY = 'proxylog.cursor';
const ID_TTL_MS = 10 * 60_000;

// onSite(ip, host, t) is called for each connection a client makes through the proxy.
export function startProxyLog(store, { onSite = () => {} } = {}) {
  const clients = new Map(); // connection id -> { ip, t }
  let cursor = store.getMeta(CURSOR_KEY);
  let savedCursor = cursor;

  setInterval(() => {
    if (cursor !== savedCursor) {
      store.setMeta(CURSOR_KEY, cursor);
      savedCursor = cursor;
    }
    const cutoff = Date.now() - ID_TTL_MS;
    for (const [id, c] of clients) if (c.t < cutoff) clients.delete(id);
  }, 5000).unref();

  function handle(entry) {
    cursor = entry.__CURSOR ?? cursor;
    // journald sends messages containing control characters (sing-box colors) as byte arrays.
    const msg = Array.isArray(entry.MESSAGE) ? Buffer.from(entry.MESSAGE).toString('utf8') : String(entry.MESSAGE ?? '');
    const ev = parseSingBoxLine(msg);
    if (!ev) return;
    const t = Math.round(Number(entry.__REALTIME_TIMESTAMP) / 1000) || Date.now();
    if (ev.type === 'from') {
      clients.set(ev.id, { ip: ev.ip, t });
      return;
    }
    if (ev.type === 'to') {
      const ip = clients.get(ev.id)?.ip;
      if (ip) onSite(ip, ev.host, t);
      return;
    }
    const { id, type, ...err } = ev;
    store.recordProxyError({ t, ip: clients.get(id)?.ip ?? null, ...err });
  }

  function follow() {
    // First run: start from the last hour; afterwards: right after the saved cursor.
    const from = cursor ? [`--after-cursor=${cursor}`] : ['--since=-1h'];
    const p = spawn('journalctl', ['--user', '-u', UNIT, '-f', '-o', 'json', ...from], { stdio: ['ignore', 'pipe', 'ignore'] });
    createInterface({ input: p.stdout }).on('line', (line) => {
      try {
        handle(JSON.parse(line));
      } catch {
        /* skip a malformed line */
      }
    });
    p.on('exit', () => setTimeout(follow, 5000).unref());
  }

  follow();
}
