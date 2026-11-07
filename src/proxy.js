// Transparent proxy / VPN for hotspot clients. sing-box answers their DNS with fake
// IPs (so the real lookup happens on the far side, immune to poisoned DNS), and
// nftables redirects their TCP to sing-box, which dials the domain through the
// upstream: an HTTP / HTTPS / SOCKS5 proxy, or a WireGuard VPN tunnel (userspace,
// from a provider's .conf file). Clients need no setup and see no VPN.

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { getBypass } from './bypass.js';
import { configDir, loadState, updateState } from './state.js';
import { asRoot, tryCmd, sh } from './system.js';

export const REDIRECT_PORT = 12345;
export const DNS_PORT = 12353;
export const FAKE_RANGE = '198.18.0.0/15';
// SOCKS/HTTP port on 127.0.0.1 into the running engine, so the laptop can test the
// upstream, look up the exit and measure latency the same way for every upstream type.
export const LOCAL_PORT = 12346;
const TEST_PORT = 12347;
export const UNIT = 'wifi-extender-proxy';
const DEFAULT_PORTS = { http: 80, https: 443, socks5: 1080 };
// Destinations that bypass the proxy: LAN, the hotspot itself, multicast...
const PRIVATE = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4'];

export { configDir };
const files = {
  proxy: join(configDir, 'proxy.json'),
  singbox: join(configDir, 'sing-box.json'),
  singboxTest: join(configDir, 'sing-box-test.json'),
  nft: join(configDir, 'rules.nft'),
};

// "socks5://user:pass@host:1080", "http://host:8080", "https://host?insecure=1"
export function parseProxyUrl(raw) {
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('Not a URL. Use http://, https:// or socks5://host:port');
  }
  const type = { 'http:': 'http', 'https:': 'https', 'socks5:': 'socks5', 'socks5h:': 'socks5' }[u.protocol];
  if (!type) throw new Error(`Unsupported scheme "${u.protocol}". Use http, https or socks5.`);
  if (!u.hostname) throw new Error('Missing proxy host.');
  return {
    type,
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: Number(u.port) || DEFAULT_PORTS[type],
    username: decodeURIComponent(u.username) || null,
    password: decodeURIComponent(u.password) || null,
    insecure: ['1', 'true'].includes(u.searchParams.get('insecure') ?? ''),
  };
}

// A WireGuard client config as VPN providers hand it out ([Interface] + [Peer]).
// Only the first peer is used; the tunnel carries everything (AllowedIPs is ignored).
export function parseWireGuardConf(text) {
  const sections = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s[#;].*$|^\s*[#;].*$/, '').trim();
    if (!line) continue;
    const head = line.match(/^\[(\w+)\]$/);
    if (head) sections.push({ name: head[1].toLowerCase(), kv: {} });
    else if (sections.length) {
      const kv = line.match(/^(\w+)\s*=\s*(.*)$/);
      if (kv) sections.at(-1).kv[kv[1].toLowerCase()] = kv[2].trim();
    }
  }
  const iface = sections.find((x) => x.name === 'interface')?.kv;
  const peer = sections.find((x) => x.name === 'peer')?.kv;
  if (!iface || !peer) throw new Error('Not a WireGuard config: it needs an [Interface] and a [Peer] section.');
  const list = (v) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const key = (v, what) => {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(v ?? '') || Buffer.from(v, 'base64').length !== 32) {
      throw new Error(`${what} is missing or not a WireGuard key.`);
    }
    return v;
  };
  const ep = (peer.endpoint ?? '').match(/^\[?([^\]]+?)\]?:(\d+)$/);
  if (!ep) throw new Error('[Peer] Endpoint must be host:port.');
  // An address without a prefix is a single host.
  const address = list(iface.address).map((a) => (a.includes('/') ? a : `${a}/${isIP(a) === 6 ? 128 : 32}`));
  if (!address.length || !address.every((a) => isIP(a.split('/')[0]))) throw new Error('[Interface] Address is missing or invalid.');
  return {
    type: 'wireguard',
    host: ep[1],
    port: Number(ep[2]),
    address,
    privateKey: key(iface.privatekey, '[Interface] PrivateKey'),
    publicKey: key(peer.publickey, '[Peer] PublicKey'),
    presharedKey: peer.presharedkey ? key(peer.presharedkey, '[Peer] PresharedKey') : null,
    // DNS may also list search domains; only server IPs are usable.
    dns: list(iface.dns).filter((d) => isIP(d)),
    mtu: Number(iface.mtu) || null,
    keepalive: Number(peer.persistentkeepalive) || null,
  };
}

// The Proxy box takes either a proxy URL or a pasted WireGuard config.
export function parseUpstream(raw) {
  return /\[Interface\]/i.test(raw) ? parseWireGuardConf(raw) : parseProxyUrl(raw);
}

// Keys never leave proxy.json: a WireGuard upstream displays as wireguard://endpoint.
export function proxyUrl(p, { mask = false } = {}) {
  if (p.type === 'wireguard') return `wireguard://${p.host.includes(':') ? `[${p.host}]` : p.host}:${p.port}`;
  const auth = p.username ? `${encodeURIComponent(p.username)}${p.password ? `:${mask ? '****' : encodeURIComponent(p.password)}` : ''}@` : '';
  const host = p.host.includes(':') ? `[${p.host}]` : p.host;
  return `${p.type}://${auth}${host}:${p.port}${p.insecure ? '?insecure=1' : ''}`;
}

// The upstream as sing-box's "proxy" outbound (HTTP/SOCKS) or endpoint (WireGuard).
function upstreamOf(p) {
  if (p.type === 'wireguard') {
    return {
      type: 'wireguard', tag: 'proxy', system: false, mtu: p.mtu ?? 1408, address: p.address, private_key: p.privateKey,
      peers: [{
        address: p.host, port: p.port, public_key: p.publicKey, allowed_ips: ['0.0.0.0/0', '::/0'],
        ...(p.presharedKey && { pre_shared_key: p.presharedKey }),
        ...(p.keepalive && { persistent_keepalive_interval: p.keepalive }),
      }],
      // The VPN server's own name must be looked up outside the tunnel.
      domain_resolver: 'local',
    };
  }
  const auth = p.username ? { username: p.username, password: p.password ?? '' } : {};
  const upstream =
    p.type === 'socks5'
      ? { type: 'socks', version: '5', ...auth }
      : { type: 'http', ...auth, ...(p.type === 'https' && { tls: { enabled: true, server_name: p.host, insecure: p.insecure } }) };
  return { tag: 'proxy', server: p.host, server_port: p.port, ...upstream };
}

// A WireGuard tunnel only carries IPs, so names are resolved first, by a DNS server
// reached through the tunnel (the .conf's DNS, else 1.1.1.1): no DNS leaks to the router.
// HTTP/SOCKS proxies get the name itself and resolve it on their side.
function tunnelDns(p) {
  const v6 = p.address.some((a) => isIP(a.split('/')[0]) === 6);
  return {
    server: { type: 'udp', tag: 'remote', server: p.dns[0] ?? '1.1.1.1', detour: 'proxy' },
    rule: { action: 'resolve', server: 'remote', strategy: v6 ? 'prefer_ipv4' : 'ipv4_only' },
  };
}

export function singBoxConfig(p, { cacheFile, bypass = [] }) {
  const wg = p.type === 'wireguard';
  const up = upstreamOf(p);
  const tdns = wg ? tunnelDns(p) : null;
  return {
    // info logs each client connection, which proxylog.js needs to tie failures to a device.
    log: { level: 'info' },
    dns: {
      servers: [
        { type: 'local', tag: 'local' },
        { type: 'fakeip', tag: 'fake', inet4_range: FAKE_RANGE },
        ...(wg ? [tdns.server] : []),
      ],
      rules: [
        // Bypass domains get their real address, so the client can reach them directly (e.g. Wi-Fi calling).
        ...(bypass.length ? [{ domain_suffix: bypass, query_type: ['A'], action: 'route', server: 'local' }] : []),
        { query_type: ['A'], action: 'route', server: 'fake' },
        // No IPv6 or HTTPS-record answers, so clients always use the fake IPv4.
        { query_type: ['AAAA', 'HTTPS'], action: 'predefined', rcode: 'NOERROR' },
      ],
      final: 'local',
    },
    inbounds: [
      { type: 'redirect', tag: 'redirect-in', listen: '0.0.0.0', listen_port: REDIRECT_PORT },
      { type: 'direct', tag: 'dns-in', listen: '0.0.0.0', listen_port: DNS_PORT },
      { type: 'mixed', tag: 'local-in', listen: '127.0.0.1', listen_port: LOCAL_PORT },
    ],
    ...(wg ? { endpoints: [up] } : {}),
    outbounds: [...(wg ? [] : [up]), { type: 'direct', tag: 'direct' }],
    route: {
      rules: [
        { inbound: 'dns-in', action: 'hijack-dns' },
        { inbound: 'redirect-in', action: 'sniff' },
        ...(bypass.length ? [{ domain_suffix: bypass, action: 'route', outbound: 'direct' }] : []),
        ...(wg ? [tdns.rule] : []),
        { ip_is_private: true, action: 'route', outbound: 'direct' },
      ],
      final: 'proxy',
      default_domain_resolver: 'local',
    },
    // Keep fake-IP mappings across restarts; clients cache the answers.
    experimental: { cache_file: { enabled: true, path: cacheFile, store_fakeip: true } },
  };
}

// The whole wifi_extender nft table, rebuilt on every change so it stays consistent.
// paused: [{ ip, seconds }] - clients cut off from the internet until their timeout runs out.
export function nftRuleset({ hotspotIf, gateway, webPort, proxy, paused = [] }) {
  const ifn = JSON.stringify(hotspotIf);
  const pre = [`iifname ${ifn} ip daddr ${gateway} tcp dport 80 redirect to :${webPort}`];
  const fwd = [];
  if (proxy) {
    pre.push(
      `iifname ${ifn} meta l4proto { tcp, udp } th dport 53 redirect to :${DNS_PORT}`,
      `iifname ${ifn} ip daddr != @private meta l4proto tcp redirect to :${REDIRECT_PORT}`,
    );
    // QUIC and UDP to fake IPs cannot go through the proxy; rejecting makes apps fall back to TCP.
    fwd.push(`iifname ${ifn} udp dport 443 reject`, `iifname ${ifn} ip daddr ${FAKE_RANGE} reject`);
  }
  const pausedElems = paused.filter((p) => p.seconds > 0).map((p) => `${p.ip} timeout ${Math.ceil(p.seconds)}s`);
  return `table ip wifi_extender
delete table ip wifi_extender
table ip wifi_extender {
  set private {
    type ipv4_addr; flags interval;
    elements = { ${PRIVATE.join(', ')} }
  }
  set paused {
    type ipv4_addr; flags timeout;${pausedElems.length ? `\n    elements = { ${pausedElems.join(', ')} }` : ''}
  }
  # Paused clients can still reach the hotspot itself (DNS, DHCP, this admin page), nothing else.
  # Runs before the redirects, so proxied traffic is cut off too.
  chain pause {
    type filter hook prerouting priority -150; policy accept;
    iifname ${ifn} ip saddr @paused ip daddr != ${gateway} drop
  }
  chain prerouting {
    type nat hook prerouting priority dstnat; policy accept;
${pre.map((r) => `    ${r}`).join('\n')}
  }
  chain forward {
    type filter hook forward priority filter - 1; policy accept;
${fwd.map((r) => `    ${r}`).join('\n')}
  }
}
`;
}

async function readJsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writePrivate(path, text) {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(path, text, { mode: 0o600 });
}

export const loadProxy = () => readJsonFile(files.proxy, null);

// proxy.json always holds the proxy in use (what the engine runs); src/proxies.js keeps the full list.
export async function writeActiveProxy(p) {
  if (p) await writePrivate(files.proxy, JSON.stringify(p, null, 2));
  else await rm(files.proxy, { force: true });
}

export async function saveProxy(raw) {
  const p = parseUpstream(raw);
  await writePrivate(files.proxy, JSON.stringify(p, null, 2));
  return p;
}

const engineActive = async () => (await tryCmd('systemctl', ['--user', 'is-active', UNIT]))?.trim() === 'active';

async function listening(port) {
  return ((await tryCmd('ss', ['-Htln', `sport = :${port}`])) ?? '').trim() !== '';
}

// Paused clients from state.json, with the seconds they have left.
async function activePauses() {
  const now = Date.now();
  return Object.values((await loadState()).paused ?? {})
    .map((p) => ({ ip: p.ip, seconds: (p.until - now) / 1000 }))
    .filter((p) => p.seconds > 0);
}

// Changes on every boot; the kernel forgets nft rules on reboot.
const bootId = async () => (await readFile('/proc/sys/kernel/random/boot_id', 'utf8').catch(() => '')).trim() || null;

async function applyRules(net, proxy, extraRoot = '') {
  await writePrivate(files.nft, nftRuleset({ ...net, proxy, paused: await activePauses() }));
  await asRoot(`set -e\n${extraRoot}nft -f ${JSON.stringify(files.nft)}`);
  // Only after root succeeded: what is really loaded now (rules.nft may be from a cancelled try).
  await updateState({ applied: { hotspotIf: net.hotspotIf, gateway: net.gateway, proxy, boot: await bootId(), at: Date.now() } });
}

// Why the loaded nft rules don't match what the hotspot needs now, or null if they do.
// applied: state.applied; want: { hotspotIf, gateway, proxy, boot }.
export function rulesIssue(applied, want) {
  if (!applied) return 'the rules have not been loaded yet';
  if (applied.boot !== want.boot) return 'the laptop restarted since the rules were loaded';
  if (applied.hotspotIf !== want.hotspotIf) return `the rules are for ${applied.hotspotIf}, but the hotspot is on ${want.hotspotIf}`;
  if (applied.gateway !== want.gateway) return `the rules are for gateway ${applied.gateway}, but the hotspot uses ${want.gateway}`;
  if (applied.proxy !== want.proxy) return want.proxy ? 'the proxy redirect rules are not loaded' : 'proxy redirect rules are still loaded';
  return null;
}

// Do the kernel's rules match the running hotspot? net = { hotspotIf, gateway }.
export async function rulesStatus(net) {
  const { applied, proxyEnabled } = await loadState();
  const want = { ...net, proxy: Boolean(proxyEnabled) && (await engineActive()), boot: await bootId() };
  const issue = rulesIssue(applied, want);
  return { ok: !issue, issue, proxyWanted: want.proxy };
}

// Is the engine running with exactly this upstream and the local port? (Older configs lack it.)
async function engineServes(p) {
  if (!(await engineActive()) || !(await listening(LOCAL_PORT))) return false;
  const cfg = await readJsonFile(files.singbox, null);
  const cur = [...(cfg?.endpoints ?? []), ...(cfg?.outbounds ?? [])].find((o) => o.tag === 'proxy');
  return JSON.stringify(cur) === JSON.stringify(upstreamOf(p));
}

// One short-lived engine at a time on TEST_PORT (test and exit lookup may overlap).
let testQueue = Promise.resolve();
function withTestEngine(p, fn) {
  const run = async () => {
    const tdns = tunnelDns(p);
    const cfg = {
      log: { level: 'warn' },
      dns: { servers: [{ type: 'local', tag: 'local' }, tdns.server], final: 'local' },
      inbounds: [{ type: 'mixed', tag: 'test-in', listen: '127.0.0.1', listen_port: TEST_PORT }],
      endpoints: [upstreamOf(p)],
      outbounds: [{ type: 'direct', tag: 'direct' }],
      route: { rules: [tdns.rule], final: 'proxy', default_domain_resolver: 'local' },
    };
    await writePrivate(files.singboxTest, JSON.stringify(cfg, null, 2));
    const child = spawn('sing-box', ['run', '-c', files.singboxTest], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    try {
      for (let i = 0; i < 25 && !(await listening(TEST_PORT)); i++) await new Promise((r) => setTimeout(r, 200));
      if (!(await listening(TEST_PORT))) throw new Error(`sing-box did not start: ${stderr.trim().split('\n').at(-1) ?? ''}`);
      return await fn(TEST_PORT);
    } finally {
      child.kill();
    }
  };
  const next = testQueue.then(run, run);
  testQueue = next.catch(() => {});
  return next;
}

// Runs fn(curlArgs) with curl options that reach the internet through p. HTTP/SOCKS:
// the upstream itself (socks5h, so names resolve on the proxy side like sing-box does).
// WireGuard: curl can't speak it, so through the engine's local port, or a short-lived
// test engine when it isn't running this upstream (e.g. Test before Enable).
// testEngine: false skips the test engine (returns null instead), for frequent background checks.
export async function viaUpstream(p, fn, { testEngine = true } = {}) {
  if (p.type !== 'wireguard') {
    const url = proxyUrl(p).replace(/^socks5:/, 'socks5h:').replace(/\?insecure=1$/, '');
    return fn(['-x', url, ...(p.insecure ? ['--proxy-insecure'] : [])]);
  }
  if (await engineServes(p)) return fn(['-x', `socks5h://127.0.0.1:${LOCAL_PORT}`]);
  if (!testEngine) return null;
  return withTestEngine(p, (port) => fn(['-x', `socks5h://127.0.0.1:${port}`]));
}

export async function testProxy(p) {
  const started = Date.now();
  try {
    const ip = (await viaUpstream(p, (x) => sh('curl', ['-sS', '-m', '10', ...x, 'https://api.ipify.org']))).trim();
    return { ok: true, ip, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: err.stderr?.trim() || err.message };
  }
}

// Test one proxy and say where it exits: ipinfo.io through the proxy gives IP, city, state and
// country in one request. If that service is unreachable, fall back to a plain IP check.
export async function testAndLocate(p) {
  const started = Date.now();
  try {
    const g = await proxyGeo(p);
    return { ok: true, ms: Date.now() - started, ...g };
  } catch {
    return testProxy(p);
  }
}

// Where the proxy exits to the internet: ipinfo.io fetched through the proxy, so
// it sees the exit IP rather than ours. Returns { ip, city, region, country } (ISO code).
export async function proxyGeo(p) {
  const j = JSON.parse(await viaUpstream(p, (x) => sh('curl', ['-sS', '-m', '10', ...x, 'https://ipinfo.io/json'])));
  if (!j.ip) throw new Error(j.error?.message ?? 'no IP in answer');
  return { ip: j.ip, city: j.city ?? null, region: j.region ?? null, country: j.country ?? null };
}

async function writeEngineConfig(p) {
  await writePrivate(files.singbox, JSON.stringify(singBoxConfig(p, { cacheFile: join(configDir, 'sing-box.db'), bypass: await getBypass() }), null, 2));
  await sh('sing-box', ['check', '-c', files.singbox]);
}

// Rewrite the sing-box config from the saved proxy and restart it, if it is running.
// No root needed: the nft rules don't change. Connections drop for about a second.
export async function restartEngine() {
  const p = await loadProxy();
  if (!p || !(await engineActive())) return false;
  await writeEngineConfig(p);
  await sh('systemctl', ['--user', 'restart', UNIT]);
  return true;
}

// net = { hotspotIf, gateway, webPort }
export async function proxyOn(net) {
  const p = await loadProxy();
  if (!p) throw new Error('No proxy configured yet. Set one first.');

  await writeEngineConfig(p);
  await tryCmd('systemctl', ['--user', 'stop', UNIT]);
  await tryCmd('systemctl', ['--user', 'reset-failed', UNIT]);
  await sh('systemd-run', ['--user', `--unit=${UNIT}`, '--collect', '--quiet',
    'sing-box', 'run', '-c', files.singbox]);
  for (let i = 0; i < 25 && !(await listening(REDIRECT_PORT)); i++) await new Promise((r) => setTimeout(r, 200));
  if (!(await listening(REDIRECT_PORT))) {
    const log = await tryCmd('journalctl', ['--user', '-u', UNIT, '-n', '5', '-o', 'cat', '--no-pager']);
    throw new Error(`sing-box did not start:\n${log ?? ''}`);
  }

  // Redirected packets reach INPUT on the proxy ports, so ufw must let them in.
  const ifn = JSON.stringify(net.hotspotIf);
  await applyRules(net, true,
    `ufw allow in on ${ifn} to any port ${REDIRECT_PORT} proto tcp comment 'wifi-extender proxy' >/dev/null\n` +
    `ufw allow in on ${ifn} to any port ${DNS_PORT} comment 'wifi-extender proxy dns' >/dev/null\n`);
  await updateState({ proxyEnabled: true });
}

export async function proxyOff(net) {
  // Rules first, so clients never get redirected to a stopped engine.
  await applyRules(net, false);
  await tryCmd('systemctl', ['--user', 'stop', UNIT]);
  await updateState({ proxyEnabled: false });
}

// Re-apply the table (e.g. after a reboot or a card swap) without changing the
// proxy state. extraRoot runs in the same root shell, so there is one password prompt.
export async function applyCurrentRules(net, extraRoot = '') {
  const { proxyEnabled } = await loadState();
  await applyRules(net, Boolean(proxyEnabled) && (await engineActive()), extraRoot);
}

export async function proxyStatus() {
  const p = await loadProxy();
  const { proxyEnabled = false } = await loadState();
  return {
    configured: p ? proxyUrl(p, { mask: true }) : null,
    type: p?.type ?? null,
    enabled: proxyEnabled,
    engine: await engineActive(),
  };
}
