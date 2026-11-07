// Saved proxies / VPNs: a list in ~/.config/wifi-extender/proxies.json (0600), one of them
// active. The active one is mirrored to proxy.json, which is what the engine, the nft rules
// and the CLI already read, so switching is: pick one, then restart sing-box (no root).

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir, loadProxy, parseUpstream, proxyUrl, writeActiveProxy } from './proxy.js';

const file = join(configDir, 'proxies.json');
const MAX_NAME = 60;

const fail = (status, message) => Object.assign(new Error(message), { status });

// "socks5://a" lines, one proxy each; or one or more WireGuard configs (each starts at [Interface]).
export function splitImport(text) {
  const t = String(text ?? '').trim();
  if (!t) return [];
  if (/^\s*\[Interface\]/im.test(t)) return t.split(/^(?=\s*\[Interface\])/im).map((b) => b.trim()).filter(Boolean);
  return t.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

export const nameFor = (p) => `${p.type === 'wireguard' ? 'WireGuard' : p.type.toUpperCase()} ${p.host}`;

const cleanName = (n, fallback) => String(n ?? '').trim().slice(0, MAX_NAME) || fallback;

// Keys and passwords stay in the file: the browser only gets the masked address.
export function view(entry, activeId) {
  const p = entry.proxy;
  return {
    id: entry.id, name: entry.name, type: p.type, host: p.host, port: p.port,
    url: proxyUrl(p, { mask: true }), auth: Boolean(p.username), active: entry.id === activeId,
    lastTest: entry.lastTest ?? null, addedAt: entry.addedAt,
  };
}

let chain = Promise.resolve();
// One change at a time, so two clicks can't overwrite each other's write.
const locked = (fn) => (chain = chain.then(fn, fn));

async function load() {
  try {
    const s = JSON.parse(await readFile(file, 'utf8'));
    return { activeId: s.activeId ?? null, proxies: Array.isArray(s.proxies) ? s.proxies : [] };
  } catch {
    // First run with the new list: adopt the single proxy from before.
    const old = await loadProxy();
    if (!old) return { activeId: null, proxies: [] };
    const entry = { id: 'imported', name: nameFor(old), addedAt: Date.now(), proxy: old, lastTest: null };
    return { activeId: entry.id, proxies: [entry] };
  }
}

async function save(store) {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}

const find = (store, id) => {
  const e = store.proxies.find((x) => x.id === id);
  if (!e) throw fail(404, 'That proxy no longer exists.');
  return e;
};

export async function listProxies() {
  const store = await load();
  return { activeId: store.activeId, proxies: store.proxies.map((e) => view(e, store.activeId)) };
}

export async function getProxy(id) {
  return find(await load(), id);
}

// Adds every proxy in `raw` (all or nothing). The first one ever added becomes active.
export function addProxies(raw, name) {
  return locked(async () => {
    const items = splitImport(raw);
    if (!items.length) throw fail(400, 'Paste a proxy URL or a WireGuard config first.');
    const parsed = items.map((item, i) => {
      try {
        return parseUpstream(item);
      } catch (err) {
        throw fail(400, items.length > 1 ? `Entry ${i + 1}: ${err.message}` : err.message);
      }
    });
    const store = await load();
    const added = parsed.map((proxy) => ({
      id: randomBytes(4).toString('hex'),
      name: cleanName(parsed.length === 1 ? name : '', nameFor(proxy)),
      addedAt: Date.now(), proxy, lastTest: null,
    }));
    store.proxies.push(...added);
    const activated = !store.activeId;
    if (activated) {
      store.activeId = added[0].id;
      await writeActiveProxy(added[0].proxy);
    }
    await save(store);
    return { added: added.map((e) => view(e, store.activeId)), activated };
  });
}

// name and/or raw (a new URL or config). Returns whether the active proxy's settings changed.
export function updateProxy(id, { name, raw }) {
  return locked(async () => {
    const store = await load();
    const e = find(store, id);
    if (name !== undefined) e.name = cleanName(name, e.name);
    let changed = false;
    if (raw !== undefined && String(raw).trim()) {
      const items = splitImport(raw);
      if (items.length !== 1) throw fail(400, 'Paste one proxy URL or one WireGuard config.');
      try {
        e.proxy = parseUpstream(items[0]);
      } catch (err) {
        throw fail(400, err.message);
      }
      e.lastTest = null;
      changed = e.id === store.activeId;
      if (changed) await writeActiveProxy(e.proxy);
    }
    await save(store);
    return { changed };
  });
}

export function removeProxy(id) {
  return locked(async () => {
    const store = await load();
    const e = find(store, id);
    store.proxies = store.proxies.filter((x) => x !== e);
    const wasActive = store.activeId === id;
    if (wasActive) {
      store.activeId = null;
      await writeActiveProxy(null);
    }
    await save(store);
    return { wasActive };
  });
}

// Returns the previously active id, so the caller can roll back if the engine rejects the new one.
export function selectProxy(id) {
  return locked(async () => {
    const store = await load();
    const e = find(store, id);
    const previous = store.activeId;
    store.activeId = id;
    await writeActiveProxy(e.proxy);
    await save(store);
    return { previous, name: e.name };
  });
}

export function recordTest(id, r) {
  return locked(async () => {
    const store = await load();
    const e = store.proxies.find((x) => x.id === id);
    if (!e) return;
    e.lastTest = r.ok
      ? { ok: true, ip: r.ip, ms: r.ms, city: r.city ?? null, region: r.region ?? null, country: r.country ?? null, at: Date.now() }
      : { ok: false, error: String(r.error ?? '').slice(0, 300), at: Date.now() };
    await save(store);
  });
}
