import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseDefaultRoute,
  parseDevices,
  parseDhcpAcks,
  parseDhcpRange,
  parseIwInfo,
  parseLink,
  parseModes,
  parseNeighbors,
  parseSingBoxLine,
  parseStations,
  splitTerse,
  isRandomMac,
  wifiStandard,
  wifiQrText,
} from '../src/parse.js';

test('splitTerse handles escaped colons', () => {
  assert.deepEqual(splitTerse('a\\:b:c'), ['a:b', 'c']);
});

test('parseDevices keeps only wifi devices', () => {
  const out = [
    'wlp0s20f0u2:wifi:connected:MyRouter',
    'lo:loopback:connected (externally):lo',
    'wlp0s20f3:wifi:disconnected:',
    'p2p-dev-wlp0s20f3:wifi-p2p:disconnected:',
  ].join('\n');
  assert.deepEqual(parseDevices(out), [
    { device: 'wlp0s20f0u2', type: 'wifi', state: 'connected', connection: 'MyRouter' },
    { device: 'wlp0s20f3', type: 'wifi', state: 'disconnected', connection: null },
  ]);
});

test('parseModes reads supported interface modes', () => {
  const out = `Wiphy phy0
\tSupported interface modes:
\t\t * IBSS
\t\t * managed
\t\t * AP
\t\t * monitor
\tBand 1:`;
  assert.deepEqual(parseModes(out), ['IBSS', 'managed', 'AP', 'monitor']);
});

test('parseLink reads ssid, signal, bitrates', () => {
  const out = `Connected to 0c:11:22:33:44:55 (on wlp0s20f0u2)
\tSSID: MyRouter
\tfreq: 5180.0
\tsignal: -49 dBm
\trx bitrate: 780.0 MBit/s VHT-MCS 9 80MHz VHT-NSS 2
\ttx bitrate: 866.7 MBit/s VHT-MCS 9 80MHz short GI VHT-NSS 2`;
  assert.deepEqual(parseLink(out), {
    ssid: 'MyRouter',
    freq: 5180,
    signal: -49,
    rxBitrate: '780.0 MBit/s',
    txBitrate: '866.7 MBit/s',
  });
  assert.equal(parseLink('Not connected.'), null);
});

test('parseDefaultRoute picks the lowest metric', () => {
  const out = [
    'default via 192.168.1.1 dev wlp0s20f3 proto dhcp src 192.168.1.79 metric 20602',
    'default via 192.168.1.1 dev wlp0s20f0u2 proto dhcp src 192.168.1.225 metric 601',
  ].join('\n');
  assert.equal(parseDefaultRoute(out), 'wlp0s20f0u2');
  assert.equal(parseDefaultRoute(''), null);
});

test('parseStations reads each client block', () => {
  const out = `Station 2a:11:22:33:44:55 (on wlp0s20f3)
\tauthorized:\tyes
\tWMM/WME:\tyes
\tMFP:\t\tyes
\tinactive time:\t260 ms
\trx bytes:\t31123015
\trx packets:\t156242
\ttx bytes:\t414273234
\ttx packets:\t292651
\ttx retries:\t19207
\ttx failed:\t1
\trx drop misc:\t0
\tsignal:  \t-29 [-30, -29] dBm
\ttx bitrate:\t286.7 MBit/s HE-MCS 11 HE-NSS 2 HE-GI 0 HE-DCM 0
\trx bitrate:\t6.0 MBit/s
\tconnected time:\t7231 seconds
Station 11:22:33:44:55:66 (on wlp0s20f3)
\tconnected time:\t3 seconds`;
  const [a, b] = parseStations(out);
  assert.deepEqual(a, {
    mac: '2a:11:22:33:44:55', signal: -29, signalChains: [-30, -29],
    rxBytes: 31123015, txBytes: 414273234, rxPackets: 156242, txPackets: 292651,
    txRetries: 19207, txFailed: 1, rxDrops: 0, inactiveMs: 260,
    txBitrate: 286.7, txMode: 'HE-MCS 11 HE-NSS 2 HE-GI 0 HE-DCM 0', rxBitrate: 6, rxMode: null,
    mfp: true, wmm: true, connectedSeconds: 7231,
  });
  assert.equal(b.mac, '11:22:33:44:55:66');
  assert.equal(b.signal, null);
  assert.equal(b.connectedSeconds, 3);
  assert.deepEqual(parseStations(''), []);
});

test('wifiStandard reads generation and streams', () => {
  assert.deepEqual(wifiStandard('HE-MCS 11 HE-NSS 2 HE-GI 0'), { standard: 'Wi-Fi 6', streams: 2 });
  assert.deepEqual(wifiStandard('VHT-MCS 9 80MHz VHT-NSS 2'), { standard: 'Wi-Fi 5', streams: 2 });
  assert.deepEqual(wifiStandard('MCS 7'), { standard: 'Wi-Fi 4', streams: null });
  assert.deepEqual(wifiStandard(null), { standard: null, streams: null });
});

test('isRandomMac checks the locally administered bit', () => {
  assert.equal(isRandomMac('2a:11:22:33:44:55'), true);
  assert.equal(isRandomMac('2c:11:22:33:44:66'), false);
});

test('parseIwInfo reads channel, width, power', () => {
  const out = '\tchannel 6 (2437 MHz), width: 20 MHz, center1: 2437 MHz\n\ttxpower 22.00 dBm';
  assert.deepEqual(parseIwInfo(out), { channel: 6, freq: 2437, width: 20, txPower: 22 });
});

test('parseNeighbors maps MAC to IP', () => {
  const out = '10.0.0.248 lladdr 2a:11:22:33:44:55 STALE\n10.0.0.9 FAILED';
  assert.deepEqual(parseNeighbors(out), { '2a:11:22:33:44:55': '10.0.0.248' });
});

test('parseDhcpAcks keeps the latest lease per MAC', () => {
  const out = [
    'DHCPOFFER(wlp0s20f3) 10.42.0.248 2a:11:22:33:44:55',
    'DHCPACK(wlp0s20f3) 10.42.0.248 2a:11:22:33:44:55 Alex-s-Phone',
    'DHCPACK(wlp0s20f3) 10.0.0.248 2a:11:22:33:44:55 Alex-s-Phone',
    'DHCPACK(wlp0s20f3) 10.0.0.31 aa:bb:cc:dd:ee:ff',
  ].join('\n');
  assert.deepEqual(parseDhcpAcks(out), {
    '2a:11:22:33:44:55': { ip: '10.0.0.248', hostname: 'Alex-s-Phone' },
    'aa:bb:cc:dd:ee:ff': { ip: '10.0.0.31', hostname: null },
  });
});

test('parseDhcpRange reads the dnsmasq range', () => {
  const cmd = '35880 /usr/bin/dnsmasq --listen-address=10.0.0.1 --dhcp-range=10.0.0.10,10.0.0.254,3600';
  assert.deepEqual(parseDhcpRange(cmd), { start: '10.0.0.10', end: '10.0.0.254' });
  assert.equal(parseDhcpRange(''), null);
});

test('parseSingBoxLine links client connections and proxy failures', () => {
  const from = 'INFO[0001] [2512507408 0ms] inbound/redirect[redirect-in]: inbound connection from 10.0.0.248:46428';
  assert.deepEqual(parseSingBoxLine(from), { type: 'from', id: '2512507408', ip: '10.0.0.248' });

  const colored = '\x1b[31mERROR\x1b[0m[0001] [\x1b[38;5;1m2512507408\x1b[0m 3ms] connection: open connection to ' +
    'imap.mail.me.com:993 using outbound/socks[proxy]: socks5: request rejected, code=2';
  assert.deepEqual(parseSingBoxLine(colored), {
    type: 'fail', id: '2512507408', host: 'imap.mail.me.com', port: 993,
    reason: 'rejected: not allowed by proxy rules', detail: 'socks5: request rejected, code=2',
  });

  const timeout = 'ERROR[0002] [7 10.0s] connection: open connection to a.com:443 using outbound/http[proxy]: dial tcp: i/o timeout';
  assert.equal(parseSingBoxLine(timeout).reason, 'timeout');
  const cancel = 'ERROR[0002] [7 10.0s] connection: open connection to a.com:443 using outbound/socks[proxy]: context canceled';
  assert.equal(parseSingBoxLine(cancel), null);
  const direct = 'ERROR[0002] [7 1ms] connection: open connection to 10.0.0.1:80 using outbound/direct[direct]: refused';
  assert.equal(parseSingBoxLine(direct), null);
  assert.equal(parseSingBoxLine('INFO[0000] sing-box started (0.00s)'), null);
});

test('wifiQrText escapes special characters', () => {
  assert.equal(wifiQrText('Omarchy-Hotspot', 'mmmmmmmm'), 'WIFI:T:WPA;S:Omarchy-Hotspot;P:mmmmmmmm;;');
  assert.equal(wifiQrText('a;b', 'p:w\\"x,'), 'WIFI:T:WPA;S:a\\;b;P:p\\:w\\\\\\"x\\,;;');
  assert.equal(wifiQrText('open', ''), 'WIFI:T:nopass;S:open;;');
});

test('parseSingBoxLine sees where a client connection went through the proxy', () => {
  const to = 'INFO[4582] [189284009 11ms] outbound/socks[proxy]: outbound connection to firebaselogging.googleapis.com:443';
  assert.deepEqual(parseSingBoxLine(to), { type: 'to', id: '189284009', host: 'firebaselogging.googleapis.com', port: 443 });
  assert.equal(parseSingBoxLine('INFO[1] [5 0ms] outbound/direct[direct]: outbound connection to 10.0.0.1:80'), null);
});

test('parseWifiList, channelsOverlap and channelAdvice', async () => {
  const { parseWifiList, channelsOverlap, channelAdvice } = await import('../src/parse.js');
  const nets = parseWifiList('Home:AC\\:11\\:22\\:33\\:44\\:01:153:92\n:3C\\:11\\:22\\:33\\:44\\:02:40:80\nCafe:AC\\:15:44:70\n');
  assert.deepEqual(nets[0], { ssid: 'Home', bssid: 'ac:11:22:33:44:01', channel: 153, signal: 92 });
  assert.equal(nets[1].ssid, null, 'hidden network');
  assert.ok(channelsOverlap(1, 4) && !channelsOverlap(1, 6) && !channelsOverlap(6, 40));
  assert.ok(channelsOverlap(36, 48) && !channelsOverlap(48, 52) && channelsOverlap(149, 161));
  const a = channelAdvice(nets, 40);
  assert.equal(a.load, 150, 'ch 40 shares its 80 MHz block with 40 and 44');
  assert.equal(a.suggest, 149, 'the 149-161 block only has the 92 % router');
  assert.equal(channelAdvice([], 40).suggest, null, 'nothing to escape from');
});

test('shortVendor tidies OUI company names', async () => {
  const { shortVendor, parseOui } = await import('../src/parse.js');
  assert.equal(shortVendor('Apple, Inc.'), 'Apple');
  assert.equal(shortVendor('TP-LINK TECHNOLOGIES CO.,LTD.'), 'TP-Link');
  assert.equal(shortVendor('SAMSUNG ELECTRO-MECHANICS(THAILAND)'), 'Samsung');
  assert.equal(parseOui('F0D1A9     (base 16)\t\tApple, Inc.\n').get('f0d1a9'), 'Apple, Inc.');
});

test('parseSingBoxLine handles a WireGuard upstream', () => {
  const to = 'INFO[0002] [3673609997 71ms] endpoint/wireguard[proxy]: outbound connection to 104.26.13.205:443';
  assert.deepEqual(parseSingBoxLine(to), { type: 'to', id: '3673609997', host: '104.26.13.205', port: 443 });
  const fail = 'ERROR[0002] [7 5.0s] connection: open connection to a.com:443 using endpoint/wireguard[proxy]: i/o timeout';
  assert.equal(parseSingBoxLine(fail).reason, 'timeout');
});
