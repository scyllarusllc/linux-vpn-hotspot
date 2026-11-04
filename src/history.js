// Per-device history for the /device and /map pages: every few seconds sample
// the hotspot clients into SQLite (see db.js), keeping 30 days.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './db.js';
import { getStatus } from './system.js';

export const INTERVAL_MS = 5000;
const KEEP_MS = 30 * 24 * 3600 * 1000;
const MAX_POINTS = 720;
export const DB_PATH = process.env.HISTORY_DB ||
  join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'wifi-extender', 'history.db');

let store = null;
let radio = null;
// Last byte counters per MAC, to turn them into rates. Memory only: after a
// restart the first sample has no rate, which shows as a gap.
const last = new Map();

// Turn two byte-counter readings into bit rates. Station counters are from the
// AP's side: tx = sent to the client (its download), rx = its upload.
// Returns nulls when there is no previous reading or the counters went backwards
// (the client reconnected), so the chart shows a gap instead of a spike.
export function rates(prev, cur) {
  if (!prev || cur.txBytes < prev.txBytes || cur.rxBytes < prev.rxBytes) return { down: null, up: null };
  const seconds = (cur.t - prev.t) / 1000;
  if (seconds <= 0) return { down: null, up: null };
  return {
    down: ((cur.txBytes - prev.txBytes) * 8) / seconds,
    up: ((cur.rxBytes - prev.rxBytes) * 8) / seconds,
  };
}

// Bucket size so a range comes back as at most MAX_POINTS points, in whole ticks.
export function bucketFor(rangeMs) {
  return Math.max(INTERVAL_MS, Math.ceil(rangeMs / MAX_POINTS / INTERVAL_MS) * INTERVAL_MS);
}

async function sample() {
  let status;
  try {
    status = await getStatus();
  } catch {
    return;
  }
  const t = Date.now();
  const ap = status.cards.find((c) => c.role === 'hotspot');
  radio = ap?.info ?? null;

  const seen = (ap?.clients ?? []).map((c) => {
    const cur = { t, txBytes: c.txBytes, rxBytes: c.rxBytes };
    const point = { ...rates(last.get(c.mac), cur), signal: c.signal, link: c.txBitrate };
    last.set(c.mac, cur);
    return { client: c, point };
  });
  const macs = new Set(seen.map((s) => s.client.mac));
  for (const mac of last.keys()) if (!macs.has(mac)) last.delete(mac);

  store.tick(t, seen);
}

export const historyStore = () => store;

export function startSampler(path = DB_PATH) {
  store = openStore(path);
  store.markAllOffline(Date.now());
  store.prune(Date.now() - KEEP_MS);
  sample();
  setInterval(sample, INTERVAL_MS).unref();
  setInterval(() => store.prune(Date.now() - KEEP_MS), 3600 * 1000).unref();
}

// Devices seen in the last rangeMin minutes, with their points over that range.
export function deviceHistory(rangeMin = 60) {
  const rangeMs = rangeMin * 60_000;
  const bucketMs = bucketFor(rangeMs);
  return {
    intervalMs: INTERVAL_MS,
    bucketMs,
    radio,
    devices: store.devices(Date.now() - rangeMs, bucketMs),
  };
}
