import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DNS_PORT, REDIRECT_PORT, nftRuleset, parseProxyUrl, proxyUrl, singBoxConfig } from '../src/proxy.js';

test('parseProxyUrl handles each scheme, auth and default ports', () => {
  assert.deepEqual(parseProxyUrl('socks5://u:p%40ss@1.2.3.4:1080'), {
    type: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p@ss', insecure: false,
  });
  assert.equal(parseProxyUrl('socks5h://h').port, 1080);
  assert.equal(parseProxyUrl('socks5h://h').type, 'socks5');
  assert.equal(parseProxyUrl('http://h').port, 80);
  const https = parseProxyUrl('https://h?insecure=1');
  assert.equal(https.port, 443);
  assert.equal(https.insecure, true);
  assert.equal(parseProxyUrl('socks5://[2001:db8::1]:9').host, '2001:db8::1');
});

test('parseProxyUrl rejects bad input', () => {
  assert.throws(() => parseProxyUrl('ftp://h'), /Unsupported scheme/);
  assert.throws(() => parseProxyUrl('nonsense'), /Not a URL/);
});

test('proxyUrl round-trips and masks the password', () => {
  const p = parseProxyUrl('socks5://u:secret@h:1080');
  assert.equal(proxyUrl(p), 'socks5://u:secret@h:1080');
  assert.equal(proxyUrl(p, { mask: true }), 'socks5://u:****@h:1080');
  assert.deepEqual(parseProxyUrl(proxyUrl(p)), p);
});

test('singBoxConfig builds the right upstream outbound', () => {
  const socks = singBoxConfig(parseProxyUrl('socks5://u:p@h:1080'), { cacheFile: 'c.db' });
  assert.deepEqual(socks.outbounds[0], {
    tag: 'proxy', server: 'h', server_port: 1080, type: 'socks', version: '5', username: 'u', password: 'p',
  });
  const https = singBoxConfig(parseProxyUrl('https://h:8443'), { cacheFile: 'c.db' });
  assert.deepEqual(https.outbounds[0], {
    tag: 'proxy', server: 'h', server_port: 8443, type: 'http', tls: { enabled: true, server_name: 'h', insecure: false },
  });
  assert.equal(singBoxConfig(parseProxyUrl('http://h:8080'), { cacheFile: 'c.db' }).outbounds[0].tls, undefined);
  assert.equal(socks.inbounds.find((i) => i.tag === 'redirect-in').listen_port, REDIRECT_PORT);
  assert.equal(socks.route.final, 'proxy');
});

test('nftRuleset adds proxy rules only when the proxy is on', () => {
  const net = { hotspotIf: 'wlp0s20f3', gateway: '10.0.0.1', webPort: 4321 };
  const off = nftRuleset({ ...net, proxy: false });
  const on = nftRuleset({ ...net, proxy: true });
  const admin = 'iifname "wlp0s20f3" ip daddr 10.0.0.1 tcp dport 80 redirect to :4321';
  assert.ok(off.includes(admin) && on.includes(admin));
  assert.ok(!off.includes(`:${REDIRECT_PORT}`));
  assert.ok(on.includes(`ip daddr != @private meta l4proto tcp redirect to :${REDIRECT_PORT}`));
  assert.ok(on.includes(`th dport 53 redirect to :${DNS_PORT}`));
  assert.ok(on.includes('udp dport 443 reject'));
});

test('nftRuleset carries paused clients with their remaining time', () => {
  const net = { hotspotIf: 'wlp0s20f0u2', gateway: '10.0.0.1', webPort: 4321, proxy: false };
  const none = nftRuleset(net);
  assert.ok(none.includes('set paused {') && !none.includes('elements = { 10.0.0.248'));
  const some = nftRuleset({ ...net, paused: [{ ip: '10.0.0.248', seconds: 1799.2 }, { ip: '10.0.0.9', seconds: -3 }] });
  assert.ok(some.includes('elements = { 10.0.0.248 timeout 1800s }'));
  assert.ok(!some.includes('10.0.0.9'), 'expired pauses are dropped');
  assert.ok(some.includes('iifname "wlp0s20f0u2" ip saddr @paused ip daddr != 10.0.0.1 drop'));
});

test('rulesIssue spots rules loaded for another card, another boot or without the proxy', async () => {
  const { rulesIssue } = await import('../src/proxy.js');
  const applied = { hotspotIf: 'wlp0s20f0u1', gateway: '10.0.0.1', proxy: true, boot: 'b1' };
  const want = { hotspotIf: 'wlp0s20f0u1', gateway: '10.0.0.1', proxy: true, boot: 'b1' };
  assert.equal(rulesIssue(applied, want), null);
  assert.match(rulesIssue(applied, { ...want, hotspotIf: 'wlp0s20f0u2' }), /for wlp0s20f0u1, but the hotspot is on wlp0s20f0u2/);
  assert.match(rulesIssue(applied, { ...want, boot: 'b2' }), /restarted/);
  assert.match(rulesIssue({ ...applied, proxy: false }, want), /proxy redirect rules are not loaded/);
  assert.match(rulesIssue(applied, { ...want, proxy: false }), /still loaded/);
  assert.match(rulesIssue(undefined, want), /not been loaded/);
});

// Keys made up for the tests (any 32 bytes, base64).
const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');
const WG_CONF = `# Mullvad-style client config
[Interface]
PrivateKey = ${KEY_A}
Address = 10.64.1.2/32, fc00:bbbb::2/128
DNS = 10.64.0.1, corp.lan

[Peer]
PublicKey = ${KEY_B}
Endpoint = vpn.example.com:51820   # comment after a value
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
`;

test('parseWireGuardConf reads a provider config', async () => {
  const { parseWireGuardConf, parseUpstream, proxyUrl } = await import('../src/proxy.js');
  const p = parseWireGuardConf(WG_CONF);
  assert.deepEqual(p, {
    type: 'wireguard', host: 'vpn.example.com', port: 51820, address: ['10.64.1.2/32', 'fc00:bbbb::2/128'],
    privateKey: KEY_A, publicKey: KEY_B, presharedKey: null, dns: ['10.64.0.1'], mtu: null, keepalive: 25,
  });
  assert.equal(parseUpstream(WG_CONF).type, 'wireguard', 'the Proxy box accepts a pasted config');
  assert.equal(parseUpstream('socks5://h:1').type, 'socks5');
  assert.equal(proxyUrl(p, { mask: true }), 'wireguard://vpn.example.com:51820', 'keys never shown');
  assert.equal(parseWireGuardConf(WG_CONF.replace('Address = 10.64.1.2/32, fc00:bbbb::2/128', 'Address = 10.8.0.5')).address[0], '10.8.0.5/32');
});

test('parseWireGuardConf rejects broken configs', async () => {
  const { parseWireGuardConf } = await import('../src/proxy.js');
  assert.throws(() => parseWireGuardConf('[Interface]\nPrivateKey = x'), /needs an \[Interface\] and a \[Peer\]/);
  assert.throws(() => parseWireGuardConf(WG_CONF.replace(KEY_A, 'short')), /PrivateKey is missing or not a WireGuard key/);
  assert.throws(() => parseWireGuardConf(WG_CONF.replace('vpn.example.com:51820', 'vpn.example.com')), /Endpoint must be host:port/);
});

test('singBoxConfig tunnels WireGuard with DNS through the tunnel', async () => {
  const { parseWireGuardConf, LOCAL_PORT } = await import('../src/proxy.js');
  const cfg = singBoxConfig(parseWireGuardConf(WG_CONF), { cacheFile: 'c.db' });
  const [ep] = cfg.endpoints;
  assert.equal(ep.type, 'wireguard');
  assert.equal(ep.tag, 'proxy');
  assert.equal(ep.peers[0].address, 'vpn.example.com');
  assert.equal(ep.domain_resolver, 'local', 'the VPN server name is looked up outside the tunnel');
  assert.ok(!cfg.outbounds.some((o) => o.tag === 'proxy'));
  assert.deepEqual(cfg.dns.servers.find((d) => d.tag === 'remote'), { type: 'udp', tag: 'remote', server: '10.64.0.1', detour: 'proxy' });
  assert.deepEqual(cfg.route.rules.find((r) => r.action === 'resolve'), { action: 'resolve', server: 'remote', strategy: 'prefer_ipv4' });
  assert.equal(cfg.inbounds.find((i) => i.tag === 'local-in').listen, '127.0.0.1');
  assert.equal(cfg.inbounds.find((i) => i.tag === 'local-in').listen_port, LOCAL_PORT);
  // Plain proxies keep resolving on the proxy side.
  const socks = singBoxConfig(parseProxyUrl('socks5://h:1080'), { cacheFile: 'c.db' });
  assert.ok(!socks.endpoints && !socks.route.rules.some((r) => r.action === 'resolve'));
});
