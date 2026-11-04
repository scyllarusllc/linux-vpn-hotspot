// Extra facts for the map, sampled in the background so /api/map answers instantly:
// - latency: ping to the router, to the internet (via the uplink) and to each client,
//   plus a request through the proxy when it is on
// - nearby networks: nmcli's scan list from the uplink card (the hotspot card can't scan),
//   and the quietest channel for the hotspot
// - device makers from the MAC prefix (hwdata's oui.txt)
// - sites each client reaches through the proxy: opt-in, memory only, last 10 minutes

import { readFile } from 'node:fs/promises';
import { channelAdvice, parseOui, parseWifiList, shortVendor } from './parse.js';
import { loadProxy, viaUpstream } from './proxy.js';
import { loadState } from './state.js';
import { getStatus, tryCmd } from './system.js';

const PING_MS = 10_000;
const PROXY_MS = 30_000;
const SCAN_MS = 120_000;
const SITES_KEEP_MS = 10 * 60_000;
const INTERNET_HOST = '1.1.1.1';
const OUI_FILE = '/usr/share/hwdata/oui.txt';

const latency = { router: null, internet: null, proxy: null, devices: {}, at: 0 };
let air = { networks: [], at: 0 };
let cards = { ap: null, uplink: null, apMac: null, channel: null };
const sites = new Map(); // client ip -> Map(host -> { n, last })
let sitesOn = false;

// Round-trip time in ms of one ping, or null.
async function ping(host, dev) {
  const out = await tryCmd('ping', ['-n', '-c', '1', '-W', '1', ...(dev ? ['-I', dev] : []), host]);
  const ms = Number(out?.match(/time=([\d.]+) ms/)?.[1]);
  return Number.isFinite(ms) ? Math.round(ms * 10) / 10 : null;
}

async function routerIp() {
  const out = await tryCmd('ip', ['route', 'show', 'default']);
  return out?.match(/default via (\S+)/)?.[1] ?? null;
}

async function sampleLatency() {
  let st;
  try { st = await getStatus(); } catch { return; }
  const ap = st.cards.find((c) => c.role === 'hotspot');
  const up = st.cards.find((c) => c.device === st.defaultRoute);
  cards = { ap: ap?.device ?? null, uplink: up?.device ?? null, channel: ap?.info?.channel ?? null,
    apMac: ap ? ((await readFile(`/sys/class/net/${ap.device}/address`, 'utf8').catch(() => '')).trim() || null) : null };
  const gw = await routerIp();
  const clients = (ap?.clients ?? []).filter((c) => c.ip);
  const [router, internet, ...devs] = await Promise.all([
    gw ? ping(gw, cards.uplink) : null,
    ping(INTERNET_HOST, cards.uplink),
    ...clients.map((c) => ping(c.ip, ap.device)),
  ]);
  Object.assign(latency, { router, internet, at: Date.now() });
  latency.devices = Object.fromEntries(clients.map((c, i) => [c.mac, devs[i]]));
}

// Time to fetch a tiny page through the proxy, i.e. what a client feels per request.
async function sampleProxy() {
  const p = (await loadState()).proxyEnabled ? await loadProxy() : null;
  if (!p) { latency.proxy = null; return; }
  // WireGuard: only measured while the engine runs it (no test engine every 30 s).
  const out = await viaUpstream(p, (x) => tryCmd('curl', ['-s', '-o', '/dev/null', '-m', '8', '-w', '%{time_total}', ...x,
    'http://cp.cloudflare.com/generate_204']), { testEngine: false }).catch(() => null);
  const s = Number(out);
  latency.proxy = out && s > 0 ? Math.round(s * 1000) : null;
}

async function scan() {
  if (!cards.uplink) return;
  const out = await tryCmd('nmcli', ['-t', '-f', 'SSID,BSSID,CHAN,SIGNAL', 'dev', 'wifi', 'list', 'ifname', cards.uplink, '--rescan', 'auto']);
  if (out == null) return;
  // Our own hotspot shows up in the scan; it isn't competition.
  air = { networks: parseWifiList(out).filter((n) => n.bssid !== cards.apMac), at: Date.now() };
}

let oui = null;
async function vendorOf(mac) {
  // A private (locally administered) MAC is made up, so it has no maker.
  if ((parseInt(mac.slice(0, 2), 16) & 2) === 2) return null;
  oui ??= readFile(OUI_FILE, 'utf8').then(parseOui).catch(() => new Map());
  return shortVendor((await oui).get(mac.replace(/:/g, '').slice(0, 6)));
}

export function recordSite(ip, host, t) {
  if (!sitesOn || Date.now() - t > SITES_KEEP_MS) return;
  if (!sites.has(ip)) sites.set(ip, new Map());
  const m = sites.get(ip);
  const s = m.get(host) ?? { n: 0, last: 0 };
  m.set(host, { n: s.n + 1, last: Math.max(s.last, t) });
}

// Turning it off forgets everything collected.
export function setSites(on) {
  sitesOn = Boolean(on);
  if (!sitesOn) sites.clear();
}
export const sitesEnabled = () => sitesOn;

// Top hosts per client IP over the last 10 minutes.
function topSites(limit = 5) {
  const cutoff = Date.now() - SITES_KEEP_MS;
  const out = {};
  for (const [ip, m] of sites) {
    for (const [host, s] of m) if (s.last < cutoff) m.delete(host);
    if (!m.size) { sites.delete(ip); continue; }
    out[ip] = [...m].sort((a, b) => b[1].n - a[1].n).slice(0, limit).map(([host, s]) => ({ host, n: s.n }));
  }
  return out;
}

export function startInsights({ sites: on = false } = {}) {
  setSites(on);
  const every = (fn, ms) => { fn(); setInterval(fn, ms).unref(); };
  every(sampleLatency, PING_MS);
  every(sampleProxy, PROXY_MS);
  // First scan once the card names are known.
  setTimeout(() => every(scan, SCAN_MS), 3000).unref();
}

// devices: [{ mac, ip }] to look up makers and sites for.
export async function insights(devices) {
  const vendors = Object.fromEntries(await Promise.all(devices.map(async (d) => [d.mac, await vendorOf(d.mac)])));
  const byIp = sitesOn ? topSites() : null;
  return {
    latency,
    vendors,
    sites: byIp && Object.fromEntries(devices.filter((d) => byIp[d.ip]).map((d) => [d.mac, byIp[d.ip]])),
    sitesEnabled: sitesOn,
    air: {
      at: air.at,
      networks: air.networks,
      ...channelAdvice(air.networks, cards.channel),
    },
  };
}
