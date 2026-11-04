// Dev server: serves the flow UI and a small JSON API around the same flow the
// CLI runs. It answers on loopback and on the hotspot gateway (e.g. 10.0.0.1),
// so hotspot clients can open it like a router admin page. Start/Stop change
// the network configuration, so remote clients need the admin password.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { isIPv4 } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFlow } from './flow.js';
import QRCode from 'qrcode';
import { swapCards, ufwScript } from './swap.js';
import { firewallCheck } from './firewall.js';
import { loadState } from './state.js';
import { MAX_PAUSE_MIN, activePauses, setPause } from './pause.js';
import { parseStations, wifiQrText } from './parse.js';
import { INTERVAL_MS, deviceHistory, historyStore, startSampler } from './history.js';
import { startProxyLog } from './proxylog.js';
import { insights, recordSite, setSites, sitesEnabled, startInsights } from './insights.js';
import {
  applyCurrentRules, loadProxy, proxyGeo, proxyOff, proxyOn, proxyStatus as proxyState, restartEngine, rulesStatus, saveProxy,
  testProxy,
} from './proxy.js';
import {
  HOTSPOT_CON, getStatus, hotspotActive, hotspotAddress, hotspotNet, hotspotSettings, sh, tryCmd,
} from './system.js';

const PORT = Number(process.env.PORT) || 4321;
const MAX_BODY = 64 * 1024;
// Static files: Font Awesome (self-hosted from npm so icons work without internet)
// and our own shared page assets. Only flat file names with a known type, no "..".
const assetTypes = { '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.js': 'text/javascript; charset=utf-8' };
const staticRoots = [
  ['/fa/', fileURLToPath(new URL('../node_modules/@fortawesome/fontawesome-free/', import.meta.url)), /^(css|webfonts)\/[\w.-]+$/],
  ['/assets/', fileURLToPath(new URL('../public/assets/', import.meta.url)), /^[\w.-]+$/],
];

function staticFile(path) {
  for (const [prefix, root, allowed] of staticRoots) {
    if (!path.startsWith(prefix)) continue;
    const rel = normalize(path.slice(prefix.length));
    return allowed.test(rel) && assetTypes[extname(rel)] ? join(root, rel) : null;
  }
  return null;
}

const pages = {
  '/': new URL('../public/index.html', import.meta.url),
  '/device': new URL('../public/device.html', import.meta.url),
  '/hunt': new URL('../public/hunt.html', import.meta.url),
  '/log': new URL('../public/log.html', import.meta.url),
};
// Shared header and footer, put into every page at <!--#header--> / <!--#footer-->.
// The nav link for the current page gets aria-current. Read per request, so edits show on reload.
const partial = (name) => readFile(new URL(`../public/partials/${name}.html`, import.meta.url), 'utf8');
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

async function renderPage(path) {
  const [html, header, footer] = await Promise.all([readFile(pages[path], 'utf8'), partial('header'), partial('footer')]);
  return html
    .replace('<!--#header-->', header.replace(`href="${path}" data-nav`, `href="${path}" data-nav aria-current="page"`))
    .replace('<!--#footer-->', footer.replaceAll('{{version}}', version));
}

const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'wifi-extender');
const passwordFile = join(configDir, 'admin-password');

// ADMIN_PASSWORD wins; otherwise reuse the saved one, or create and save a random one.
async function loadAdminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  try {
    return (await readFile(passwordFile, 'utf8')).trim();
  } catch {
    const pw = randomBytes(9).toString('base64url');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(passwordFile, `${pw}\n`, { mode: 0o600 });
    return pw;
  }
}

const adminPassword = Buffer.from(await loadAdminPassword());

function checkAdmin(req) {
  const given = Buffer.from(req.headers['x-admin-password'] ?? '');
  return given.length === adminPassword.length && timingSafeEqual(given, adminPassword);
}

// The hotspot gateway IP, cached briefly since every remote request needs it.
let gateway = { ip: null, at: 0 };
async function gatewayIp() {
  if (Date.now() - gateway.at > 5000) {
    gateway = { ip: (await hotspotAddress()).split('/')[0] || null, at: Date.now() };
  }
  return gateway.ip;
}

const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
const plain = (addr) => addr?.replace(/^::ffff:/, '');

// Who is asking: the laptop itself, a hotspot client, or someone we refuse.
async function classify(req) {
  if (isLoopback(req.socket.remoteAddress)) return 'local';
  const gw = await gatewayIp();
  return gw && plain(req.socket.localAddress) === gw ? 'remote' : 'denied';
}

// Host must be the IP the request arrived on (or localhost), which blocks DNS rebinding.
function hostAllowed(req) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  return host === 'localhost' || host === plain(req.socket.localAddress);
}

// The hotspot form's last settings (SSID, band, gateway, password), in SQLite's meta table.
const SETTINGS_KEY = 'hotspot.settings';

async function savedSettings() {
  const raw = historyStore().getMeta(SETTINGS_KEY);
  if (raw) return JSON.parse(raw);
  // Nothing saved yet: adopt the running hotspot's settings so they stick from now on.
  if (!(await hotspotActive())) return {};
  const { ssid, band, gateway, password } = await hotspotSettings();
  const s = { ssid, band, gateway, password };
  historyStore().setMeta(SETTINGS_KEY, JSON.stringify(s));
  return s;
}

const saveSettings = (s) => historyStore().setMeta(SETTINGS_KEY, JSON.stringify(s));

// Empty fields fall back to the saved settings; an empty password with none saved is random.
async function flowOpts(body = {}) {
  const saved = await savedSettings();
  const pick = (k) => body[k] || saved[k];
  const password = pick('password') || randomBytes(9).toString('base64url');
  return {
    ssid: pick('ssid') || 'Omarchy-Hotspot',
    band: pick('band') === 'a' ? 'a' : 'bg',
    gateway: isIPv4(pick('gateway') ?? '') ? pick('gateway') : '10.0.0.1',
    password,
    generatedPassword: !pick('password'),
  };
}

async function collectFlow(opts, apply) {
  const steps = [];
  const res = await runFlow(opts, { apply, onStep: (e) => steps.push(e) });
  return { ...res, steps };
}

// An admin action for /log; remote requests note which client did it.
function logEvent(kind, detail, req, extra = {}) {
  const by = req && !isLoopback(req.socket.remoteAddress) ? ` (by ${plain(req.socket.remoteAddress)})` : '';
  historyStore().addEvent({ kind, detail: `${detail}${by}`, ...extra });
}

const LOG_KINDS = new Set(['connect', 'disconnect', 'hotspot', 'swap', 'proxy', 'pause', 'label', 'firewall', 'server', 'rejected']);

// The running hotspot card and the uplink it forwards to (null when the hotspot is off).
async function hotspotCards() {
  const { cards } = await getStatus();
  const ap = cards.find((c) => c.role === 'hotspot');
  const uplink = cards.find((c) => c !== ap && c.role === 'client');
  return ap ? { ap: ap.device, uplink: uplink?.device ?? null } : null;
}

// ufw rules (per card name) and the nft rules (port 80, proxy redirects, pauses; lost on
// reboot or when the card is renamed) for the running hotspot. Fixed together by /api/firewall/fix.
async function firewallStatus() {
  const cards = await hotspotCards();
  if (!cards) return { needed: false, missing: [] };
  const { proxyEnabled } = await loadState();
  const [check, rules] = await Promise.all([
    firewallCheck({ ...cards, webPort: PORT, proxy: Boolean(proxyEnabled) }),
    hotspotNet(PORT).then(rulesStatus),
  ]);
  const missing = [...check.missing, ...(rules.ok ? [] : [`${rules.proxyWanted ? 'proxy routing' : 'redirect rules'}: ${rules.issue}`])];
  return { ...check, ...cards, missing, rules, needed: missing.length > 0 };
}

// Proxy exit location, cached in SQLite's meta table per proxy (keyed by the masked URL).
// Looked up in the background so /api/proxy stays fast; again after an hour, or 5 min after a failure.
const GEO_KEY = 'proxy.geo';
let geoPending = null;

function cachedGeo(proxy) {
  const g = JSON.parse(historyStore().getMeta(GEO_KEY) ?? 'null');
  if (g?.proxy !== proxy) return { g: null, stale: true };
  return { g: g.ip ? g : null, stale: Date.now() - g.at > (g.ip ? 3600_000 : 300_000) };
}

function refreshGeo(proxy) {
  if (geoPending) return geoPending;
  geoPending = (async () => {
    const p = await loadProxy();
    if (!p) return;
    let g;
    try { g = await proxyGeo(p); } catch (err) { g = { error: err.stderr?.trim() || err.message }; }
    historyStore().setMeta(GEO_KEY, JSON.stringify({ ...g, proxy, at: Date.now() }));
  })().finally(() => { geoPending = null; });
  return geoPending;
}

async function proxyStatus() {
  const st = await proxyState();
  // "On" in state.json isn't enough: the kernel's redirect rules must point at the hotspot card.
  if (st.enabled && (await hotspotActive())) {
    const r = await rulesStatus(await hotspotNet(PORT));
    st.routing = r.ok;
    st.routingIssue = r.issue;
  }
  if (!st.configured) return { ...st, geo: null };
  const { g, stale } = cachedGeo(st.configured);
  if (stale) refreshGeo(st.configured);
  return { ...st, geo: g && { ip: g.ip, city: g.city, region: g.region, country: g.country } };
}

const routes = {
  'GET /api/health': async () => ({ ok: true }),
  // mac: which hotspot client is asking (lets /hunt follow the phone that opened it).
  'GET /api/whoami': async (_body, who, _url, req) => {
    const ip = plain(req.socket.remoteAddress);
    const me = who === 'remote' ? historyStore().devices(0, 3600_000).find((d) => d.ip === ip) : null;
    return { local: who === 'local', mac: me?.mac ?? null };
  },
  'GET /api/status': async () => withLabels(await getStatus(), await activePauses()),
  // ?range=<minutes>, 1 minute to 30 days.
  'GET /api/devices': async (_body, _who, url) => {
    const h = deviceHistory(Math.min(43200, Math.max(1, Number(url.searchParams.get('range')) || 60)));
    const paused = await activePauses();
    return { ...h, devices: h.devices.map((d) => ({ ...d, pausedUntil: paused[d.mac]?.until ?? null })) };
  },
  'POST /api/devices/label': async (body, _who, _url, req) => {
    const icon = body.icon && /^[a-z0-9-]{1,40}$/.test(body.icon) ? body.icon : null;
    const alias = String(body.alias ?? '').trim().slice(0, 40) || null;
    if (!historyStore().setLabel(String(body.mac), { alias, icon })) throw Object.assign(new Error('Unknown device.'), { status: 404 });
    logEvent('label', alias ? `Renamed to "${alias}"` : 'Name cleared', req, { mac: String(body.mac) });
    return { ok: true, alias, icon };
  },
  // minutes: 0 resumes. Needs root: a password dialog appears on the laptop.
  'POST /api/devices/pause': async (body, _who, _url, req) => {
    const mac = String(body.mac ?? '');
    const minutes = Math.max(0, Math.min(MAX_PAUSE_MIN, Number(body.minutes) || 0));
    const dev = historyStore().devices(0, 3600_000).find((d) => d.mac === mac);
    if (!dev) throw Object.assign(new Error('Unknown device.'), { status: 404 });
    let p;
    await withRoot(async () => { p = await setPause({ mac, ip: dev.ip, minutes, webPort: PORT }); });
    logEvent('pause', minutes ? `Internet paused for ${minutes} min` : 'Internet resumed', req, { mac, ip: dev.ip });
    return { ok: true, pausedUntil: p?.until ?? null };
  },
  // Today card + leaderboards, all from SQLite.
  'GET /api/stats': async () => {
    const store = historyStore();
    const midnight = new Date().setHours(0, 0, 0, 0);
    const week = Date.now() - 7 * 86400_000;
    const today = store.usage(midnight, INTERVAL_MS / 1000);
    const online = deviceHistory(5).devices.filter((d) => d.online);
    const longest = online.sort((a, b) => b.connectedSeconds - a.connectedSeconds)[0];
    return {
      today: {
        down: today.reduce((s, r) => s + r.down, 0),
        up: today.reduce((s, r) => s + r.up, 0),
        peak: Math.max(0, ...today.map((r) => r.peak ?? 0)),
        ...store.counts(midnight),
        longest: longest ? { name: longest.alias ?? longest.hostname ?? longest.mac, seconds: longest.connectedSeconds } : null,
      },
      leaders: { today, week: store.usage(week, INTERVAL_MS / 1000) },
    };
  },
  // Live signal of one client, read straight from the card (for /hunt, polled every second).
  'GET /api/signal': async (_body, _who, url) => {
    const mac = String(url.searchParams.get('mac') ?? '').toLowerCase();
    if (!/^[0-9a-f:]{17}$/.test(mac)) throw Object.assign(new Error('Pass ?mac='), { status: 400 });
    const ap = (await getStatus()).cards.find((c) => c.role === 'hotspot');
    const out = ap && (await tryCmd('iw', ['dev', ap.device, 'station', 'get', mac]));
    const st = out ? parseStations(out)[0] : null;
    return { t: Date.now(), online: Boolean(st), signal: st?.signal ?? null, link: st?.txBitrate ?? null };
  },
  // QR code that phones scan to join the hotspot.
  'GET /api/hotspot/qr': async () => {
    if (!(await hotspotActive())) return { ok: false };
    const { ssid, password } = await hotspotSettings();
    const svg = await QRCode.toString(wifiQrText(ssid, password), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { ok: true, ssid, password, svg };
  },
  'GET /api/flow': async () => collectFlow(await flowOpts(), false),
  // For prefilling the form. The password itself is not sent (hasPassword only); /api/hotspot/qr shows it.
  'GET /api/settings': async () => {
    const { password, ...s } = await savedSettings();
    return { ...s, hasPassword: Boolean(password) };
  },
  'POST /api/start': async (body, _who, _url, req) => {
    if (body.password && body.password.length < 8) {
      return { ok: false, error: 'Password must be at least 8 characters.' };
    }
    const opts = await flowOpts(body);
    // The flow keeps a running hotspot as is (it only fixes the gateway), so
    // "Apply changes" with a new SSID, band or password recreates it.
    if (await hotspotActive()) {
      const cur = await hotspotSettings();
      if (cur.ssid !== opts.ssid || cur.band !== opts.band || cur.password !== opts.password) {
        await sh('nmcli', ['con', 'delete', HOTSPOT_CON]);
      }
    }
    const res = await collectFlow(opts, true);
    // A generated password is kept only if the hotspot came up with it.
    if (res.ok || !opts.generatedPassword) {
      saveSettings({ ssid: opts.ssid, band: opts.band, gateway: opts.gateway, password: opts.password });
    }
    logEvent('hotspot', res.ok ? `Hotspot started: ${opts.ssid}, ${opts.band === 'a' ? '5' : '2.4'} GHz` : 'Hotspot failed to start', req);
    return { ...res, ssid: opts.ssid, password: res.ok && opts.generatedPassword ? opts.password : undefined };
  },
  'POST /api/stop': async (_body, _who, _url, req) => {
    if (await hotspotActive()) {
      await sh('nmcli', ['con', 'delete', HOTSPOT_CON]);
      logEvent('hotspot', 'Hotspot stopped', req);
    }
    return { ok: true };
  },
  // Needs root for the new card's firewall rules: a password dialog appears on the laptop.
  'POST /api/swap': async (_body, _who, _url, req) => {
    const steps = [];
    let res;
    await withRoot(async () => { res = await swapCards({ webPort: PORT, onStep: (e) => steps.push(e) }); });
    logEvent('swap', res.ok ? `Swapped cards: hotspot now on ${res.ap}, uplink on ${res.uplink}` : 'Card swap failed', req);
    return { ...res, steps };
  },
  // Everything the map shows beyond /api/devices and /api/status, keyed by MAC.
  'GET /api/map': async () => {
    const store = historyStore();
    const now = Date.now();
    const devices = store.devices(now - 3600_000, 3600_000);
    const usage = store.usage(new Date().setHours(0, 0, 0, 0), INTERVAL_MS / 1000);
    return {
      ...(await insights(devices.map((d) => ({ mac: d.mac, ip: d.ip })))),
      rejects: store.rejectsByMac(now - 3600_000),
      joined: store.lastConnects(now - 10 * 60_000),
      usage: Object.fromEntries(usage.map((u) => [u.mac, { down: u.down, up: u.up }])),
    };
  },
  // Opt-in: which sites each device reaches (through the proxy). Kept in memory only.
  'POST /api/map/sites': async (body, _who, _url, req) => {
    setSites(Boolean(body.enabled));
    historyStore().setMeta('map.sites', sitesEnabled() ? 'on' : 'off');
    logEvent('server', `Per-device sites on the map turned ${sitesEnabled() ? 'on' : 'off'}`, req);
    return { enabled: sitesEnabled() };
  },
  // The /log timeline. ?range=<minutes> (default 24 h), ?kinds=connect,disconnect,... (default all), ?mac=
  'GET /api/log': async (_body, _who, url) => {
    const rangeMin = Math.min(43200, Math.max(1, Number(url.searchParams.get('range')) || 1440));
    const since = Date.now() - rangeMin * 60_000;
    const kinds = (url.searchParams.get('kinds') ?? '').split(',').filter((k) => LOG_KINDS.has(k));
    const mac = String(url.searchParams.get('mac') ?? '').toLowerCase();
    const store = historyStore();
    return {
      events: store.events(since, { kinds, mac: /^[0-9a-f:]{17}$/.test(mac) ? mac : '', limit: 1000 }),
      counts: { ...store.eventCounts(since), rejected: store.counts(since).rejected },
    };
  },
  // Missing ufw rules for the hotspot card; the homepage shows a modal while any are.
  'GET /api/firewall': () => firewallStatus(),
  // Adds them and re-points the nft rules (port 80, proxy, pauses) at this card.
  // Needs root: a password dialog appears on the laptop.
  'POST /api/firewall/fix': async (_body, _who, _url, req) => {
    const cards = await hotspotCards();
    if (!cards) throw Object.assign(new Error('Hotspot is not running. Start it first.'), { status: 409 });
    if (!cards.uplink) throw Object.assign(new Error('The other card is not connected to a router.'), { status: 409 });
    await withRoot(async () => applyCurrentRules(await hotspotNet(PORT), ufwScript(cards.ap, cards.uplink, PORT)));
    const after = await firewallStatus();
    logEvent('firewall', after.needed ? `Firewall fix incomplete on ${cards.ap}` : `Firewall rules added for ${cards.ap}`, req);
    return after;
  },
  'GET /api/proxy': () => proxyStatus(),
  'POST /api/proxy': async (body, _who, _url, req) => {
    let p;
    try {
      p = await saveProxy(String(body.url ?? ''));
    } catch (err) {
      throw Object.assign(err, { status: 400 });
    }
    // Already on: switch the running engine over now (connections drop for about a second).
    const switched = await restartEngine();
    logEvent('proxy', `Upstream changed to ${p.type === 'wireguard' ? 'WireGuard VPN' : p.type} ${p.host}:${p.port}${switched ? ' (applied)' : ''}`, req);
    return proxyStatus();
  },
  // ?range=<minutes>, default 24 hours.
  'GET /api/proxy/errors': async (_body, _who, url) => {
    const rangeMin = Math.min(43200, Math.max(1, Number(url.searchParams.get('range')) || 1440));
    return historyStore().proxyErrors(Date.now() - rangeMin * 60_000);
  },
  'POST /api/proxy/test': async () => {
    const p = await loadProxy();
    if (!p) return { ok: false, error: 'No proxy configured yet.' };
    return testProxy(p);
  },
  // These need root: a password dialog appears on the laptop's screen.
  'POST /api/proxy/on': async (_body, _who, _url, req) => {
    await withRoot(async () => proxyOn(await hotspotNet(PORT)));
    logEvent('proxy', 'Proxy turned on', req);
    return proxyStatus();
  },
  'POST /api/proxy/off': async (_body, _who, _url, req) => {
    await withRoot(async () => proxyOff(await hotspotNet(PORT)));
    logEvent('proxy', 'Proxy turned off', req);
    return proxyStatus();
  },
};

// Friendly names and icons from SQLite, and pause state, onto the live client list.
function withLabels(status, paused) {
  const labels = historyStore().labels();
  for (const card of status.cards) {
    card.clients = card.clients.map((c) => ({ ...c, ...labels.get(c.mac), pausedUntil: paused[c.mac]?.until ?? null }));
  }
  return status;
}

async function withRoot(fn) {
  try {
    await fn();
  } catch (err) {
    // pkexec exits 126 when the dialog is dismissed, 127 when not authorized.
    if (err.code === 126 || err.code === 127) throw Object.assign(new Error('Password dialog was cancelled.'), { status: 403 });
    throw err;
  }
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
  }
  return raw ? JSON.parse(raw) : {};
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const server = createServer(async (req, res) => {
  res.on('finish', () => {
    if (!isLoopback(req.socket.remoteAddress)) {
      console.log(`${plain(req.socket.remoteAddress)} -> ${plain(req.socket.localAddress)} ` +
        `Host=${req.headers.host} ${req.method} ${req.url} ${res.statusCode}`);
    }
  });
  try {
    const who = await classify(req);
    if (who === 'denied' || !hostAllowed(req)) return send(res, 403, { error: 'forbidden' });

    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    if (req.method === 'GET' && (path.startsWith('/fa/') || path.startsWith('/assets/'))) {
      const file = staticFile(path);
      const body = file && (await readFile(file).catch(() => null));
      if (!body) return send(res, 404, { error: 'not found' });
      // Our own assets change during development; Font Awesome doesn't.
      const cache = path.startsWith('/fa/') ? 'public, max-age=86400' : 'no-cache';
      res.writeHead(200, { 'Content-Type': assetTypes[extname(file)], 'Cache-Control': cache });
      return res.end(body);
    }
    // The map moved into the homepage hero; keep old links working.
    if (req.method === 'GET' && path === '/map') {
      res.writeHead(302, { Location: '/#map' });
      return res.end();
    }
    if (req.method === 'GET' && pages[path]) {
      return send(res, 200, await renderPage(path), 'text/html; charset=utf-8');
    }
    const handler = routes[`${req.method} ${path}`];
    if (!handler) return send(res, 404, { error: 'not found' });

    if (req.method === 'POST') {
      // Block other websites from driving the API through the browser.
      if (req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'bad origin' });
      if (who === 'remote' && !checkAdmin(req)) return send(res, 401, { error: 'wrong admin password' });
    }
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    send(res, 200, await handler(body, who, url, req));
  } catch (err) {
    send(res, err.status ?? 500, { error: err.stderr?.trim() || err.message });
  }
});

startSampler();
historyStore().addEvent({ kind: 'server', detail: `Server started on port ${PORT}` });
startProxyLog(historyStore(), { onSite: recordSite });
startInsights({ sites: historyStore().getMeta('map.sites') === 'on' });

server.listen(PORT, async () => {
  console.log(`linux-vpn-hotspot dashboard: http://127.0.0.1:${PORT}`);
  const gw = await gatewayIp();
  if (gw) console.log(`hotspot clients:          http://${gw} (after make port80) or http://${gw}:${PORT}`);
  console.log(`admin password (hotspot clients only): ${process.env.ADMIN_PASSWORD ? '$ADMIN_PASSWORD' : passwordFile}`);
});
