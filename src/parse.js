// Pure parsers for nmcli / iw output, kept separate so they can be unit tested.

// Split one line of `nmcli -t` output, honouring `\:` escapes.
export function splitTerse(line) {
  const fields = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i];
    } else if (ch === ':') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION dev`
export function parseDevices(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [device, type, state, connection] = splitTerse(line);
      return { device, type, state, connection: connection || null };
    })
    .filter((d) => d.type === 'wifi');
}

// `iw phy <phy> info` -> list of supported interface modes
export function parseModes(text) {
  const modes = [];
  let inModes = false;
  for (const line of text.split('\n')) {
    if (/Supported interface modes:/.test(line)) {
      inModes = true;
      continue;
    }
    if (inModes) {
      const m = line.match(/^\s+\* (.+)$/);
      if (!m) break;
      modes.push(m[1].trim());
    }
  }
  return modes;
}

// `iw dev <dev> link`
export function parseLink(text) {
  if (/Not connected/.test(text)) return null;
  const get = (re) => text.match(re)?.[1] ?? null;
  return {
    ssid: get(/SSID: (.+)/),
    freq: Number(get(/freq: ([\d.]+)/)) || null,
    signal: Number(get(/signal: (-?\d+)/)) || null,
    rxBitrate: get(/rx bitrate: ([\d.]+ MBit\/s)/),
    txBitrate: get(/tx bitrate: ([\d.]+ MBit\/s)/),
  };
}

// `ip route show default` -> device carrying the lowest-metric default route
export function parseDefaultRoute(text) {
  const routes = text
    .split('\n')
    .filter((l) => l.startsWith('default'))
    .map((l) => ({
      dev: l.match(/ dev (\S+)/)?.[1],
      metric: Number(l.match(/ metric (\d+)/)?.[1] ?? 0),
    }))
    .sort((a, b) => a.metric - b.metric);
  return routes[0]?.dev ?? null;
}

// `iw dev <dev> station dump` -> one entry per connected client
export function parseStations(text) {
  return text
    .split(/^(?=Station )/m)
    .filter((block) => block.startsWith('Station '))
    .map((block) => {
      const str = (re) => block.match(re)?.[1]?.trim() ?? null;
      const num = (re) => Number(str(re) ?? NaN);
      const int = (re) => num(re) || 0;
      return {
        mac: str(/^Station ([0-9a-f:]{17})/i),
        signal: num(/^\s*signal:\s+(-?\d+)/m) || null,
        signalChains: (str(/^\s*signal:.*\[([^\]]+)\]/m) ?? '').split(',').map(Number).filter((n) => !Number.isNaN(n) && n !== 0),
        rxBytes: int(/rx bytes:\s+(\d+)/),
        txBytes: int(/tx bytes:\s+(\d+)/),
        rxPackets: int(/rx packets:\s+(\d+)/),
        txPackets: int(/tx packets:\s+(\d+)/),
        txRetries: int(/tx retries:\s+(\d+)/),
        txFailed: int(/tx failed:\s+(\d+)/),
        rxDrops: int(/rx drop misc:\s+(\d+)/),
        inactiveMs: int(/inactive time:\s+(\d+)/),
        txBitrate: num(/tx bitrate:\s+([\d.]+) MBit/) || null,
        txMode: str(/tx bitrate:\s+[\d.]+ MBit\/s ?(.*)$/m) || null,
        rxBitrate: num(/rx bitrate:\s+([\d.]+) MBit/) || null,
        rxMode: str(/rx bitrate:\s+[\d.]+ MBit\/s ?(.*)$/m) || null,
        mfp: str(/^\s*MFP:\s+(\w+)/m) === 'yes',
        wmm: str(/^\s*WMM\/WME:\s+(\w+)/m) === 'yes',
        connectedSeconds: int(/connected time:\s+(\d+)/),
      };
    });
}

// Wi-Fi generation and spatial streams from an iw bitrate mode string, e.g. "HE-MCS 11 HE-NSS 2".
export function wifiStandard(mode) {
  if (!mode) return { standard: null, streams: null };
  const standard = /EHT-/.test(mode) ? 'Wi-Fi 7' : /HE-/.test(mode) ? 'Wi-Fi 6'
    : /VHT-/.test(mode) ? 'Wi-Fi 5' : /MCS/.test(mode) ? 'Wi-Fi 4' : null;
  const streams = Number(mode.match(/NSS (\d+)/)?.[1]) || null;
  return { standard, streams };
}

// A set "locally administered" bit means the phone made the MAC up (private/random MAC).
export const isRandomMac = (mac) => (parseInt(mac.slice(0, 2), 16) & 2) === 2;

// `iw dev <dev> info` -> hotspot radio details
export function parseIwInfo(text) {
  const m = text.match(/channel (\d+) \((\d+) MHz\), width: (\d+) MHz/);
  return {
    channel: m ? Number(m[1]) : null,
    freq: m ? Number(m[2]) : null,
    width: m ? Number(m[3]) : null,
    txPower: Number(text.match(/txpower ([\d.]+) dBm/)?.[1]) || null,
  };
}

// `ip neigh show dev <dev>` -> { mac: ip }
export function parseNeighbors(text) {
  const map = {};
  for (const m of text.matchAll(/^(\d+\.\d+\.\d+\.\d+) lladdr ([0-9a-f:]{17})/gim)) map[m[2].toLowerCase()] = m[1];
  return map;
}

// dnsmasq-dhcp log lines -> { mac: { ip, hostname } }, latest lease wins
export function parseDhcpAcks(text) {
  const map = {};
  for (const m of text.matchAll(/DHCPACK\(\S+\) (\S+) ([0-9a-f:]{17})(?: (\S+))?/gi)) {
    map[m[2].toLowerCase()] = { ip: m[1], hostname: m[3] ?? null };
  }
  return map;
}

// dnsmasq command line -> { start, end } of the DHCP range
export function parseDhcpRange(text) {
  const m = text.match(/--dhcp-range=([\d.]+),([\d.]+)/);
  return m ? { start: m[1], end: m[2] } : null;
}

// SOCKS5 reply codes (RFC 1928), for readable rejection reasons.
const SOCKS_REPLIES = {
  1: 'general failure', 2: 'not allowed by proxy rules', 3: 'network unreachable', 4: 'host unreachable',
  5: 'connection refused', 6: 'TTL expired', 7: 'command not supported', 8: 'address type not supported',
};

// One sing-box log line (colors allowed). Returns
//   { type: 'from', id, ip }                 a redirected client connection opened
//   { type: 'to', id, host, port }           it went out through the proxy to host:port
//   { type: 'fail', id, host, port, reason, detail }  dialing through the proxy failed
//   null                                     anything else (incl. the client cancelling)
export function parseSingBoxLine(raw) {
  const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
  const m = line.match(/^[A-Z]+\[\d+\]\s+\[(\d+) [^\]]*\]\s+(.*)$/);
  if (!m) return null;
  const [, id, rest] = m;

  const from = rest.match(/^inbound\/redirect\[[^\]]+\]: inbound connection from ([\d.]+):\d+$/);
  if (from) return { type: 'from', id, ip: from[1] };

  // Proxies log as outbound/socks[proxy], a WireGuard upstream as endpoint/wireguard[proxy].
  const to = rest.match(/^(?:outbound|endpoint)\/\w+\[proxy\]: outbound connection to (.+):(\d+)$/);
  if (to) return { type: 'to', id, host: to[1].replace(/^\[|\]$/g, ''), port: Number(to[2]) };

  const fail = rest.match(/^connection: open connection to (.+):(\d+) using (?:outbound|endpoint)\/\w+\[proxy\]: (.*)$/);
  if (!fail || /context canceled/.test(fail[3])) return null;
  const detail = fail[3];
  const code = Number(detail.match(/socks5: request rejected, code=(\d+)/)?.[1]);
  const reason = code ? `rejected: ${SOCKS_REPLIES[code] ?? `code ${code}`}`
    : /timeout|deadline exceeded/i.test(detail) ? 'timeout'
    : /refused/i.test(detail) ? 'proxy refused connection'
    : /HTTP|status/.test(detail) ? 'rejected by HTTP proxy'
    : 'error';
  return { type: 'fail', id, host: fail[1].replace(/^\[|\]$/g, ''), port: Number(fail[2]), reason, detail };
}

// `nmcli -t -f SSID,BSSID,CHAN,SIGNAL dev wifi list` -> nearby networks (signal is 0-100 %).
export function parseWifiList(text) {
  return text.split('\n').filter(Boolean).map((line) => {
    const [ssid, bssid, chan, signal] = splitTerse(line);
    return { ssid: ssid || null, bssid: bssid.toLowerCase(), channel: Number(chan) || null, signal: Number(signal) || 0 };
  }).filter((n) => n.channel);
}

// Channels that interfere with each other: 2.4 GHz ones closer than 5 apart,
// 5 GHz ones in the same 80 MHz block (36-48, 52-64, ..., 149-161).
export function channelsOverlap(a, b) {
  if (a <= 14 || b <= 14) return a <= 14 && b <= 14 && Math.abs(a - b) < 5;
  const block = (c) => (c >= 149 ? Math.floor((c - 149) / 16) + 100 : Math.floor((c - 36) / 16));
  return block(a) === block(b);
}

// How crowded each candidate channel is (sum of the signal % of overlapping networks),
// and the quietest one. Candidates: 1/6/11 on 2.4 GHz, the non-DFS 5 GHz channels.
export function channelAdvice(networks, current) {
  const band5 = current > 14;
  const candidates = band5 ? [36, 40, 44, 48, 149, 153, 157, 161] : [1, 6, 11];
  const load = (c) => networks.filter((n) => (n.channel > 14) === band5 && channelsOverlap(n.channel, c))
    .reduce((s, n) => s + n.signal, 0);
  const scores = candidates.map((c) => ({ channel: c, load: load(c) })).sort((x, y) => x.load - y.load);
  const here = current ? load(current) : null;
  const best = scores[0];
  return {
    current, load: here, scores,
    // Only worth moving for a clearly quieter channel.
    suggest: best && here != null && best.channel !== current && here - best.load >= 40 ? best.channel : null,
  };
}

// IEEE OUI list (hwdata's oui.txt) -> Map of "aabbcc" -> company.
export function parseOui(text) {
  const map = new Map();
  for (const m of text.matchAll(/^([0-9A-F]{6})\s+\(base 16\)\s+(.+)$/gm)) map.set(m[1].toLowerCase(), m[2].trim());
  return map;
}

// Short, familiar maker names: "Apple, Inc." -> "Apple", "TP-LINK TECHNOLOGIES CO.,LTD." -> "TP-Link".
// Short all-caps words (TP, LG, HTC) stay as they are; longer ones get title case.
const VENDOR_NOISE = /\b(inc|corp|corporation|co|ltd|limited|llc|gmbh|ag|sa|bv|technologies|technology|electronics|communications|computer|systems|mobile|telecommunication|international|devices?|electro-mechanics|network|networks)\b/gi;
export function shortVendor(name) {
  if (!name) return null;
  const words = name.replace(/\(.*?\)/g, '').replace(/[,.]/g, ' ').replace(VENDOR_NOISE, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const tidy = (w) => w.split('-').map((p) => (/^[A-Z0-9]{1,3}$/.test(p) ? p : p[0].toUpperCase() + p.slice(1).toLowerCase())).join('-');
  return words.length ? words.map(tidy).join(' ') : null;
}

// Text for a "join WiFi" QR code (the format phone cameras understand).
// Special characters in SSID and password are backslash-escaped.
export function wifiQrText(ssid, password) {
  const e = (v) => String(v).replace(/([\\;,:"])/g, '\\$1');
  return password ? `WIFI:T:WPA;S:${e(ssid)};P:${e(password)};;` : `WIFI:T:nopass;S:${e(ssid)};;`;
}
