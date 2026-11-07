// Network map for the homepage hero. Loaded as an ES module, so its helpers
// don't collide with the page's own script. Expects the nm-* elements in the page.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const SVGNS = 'http://www.w3.org/2000/svg';

const fmtRate = (b) => (b == null ? '—' : b >= 1e6 ? `${(b / 1e6).toFixed(1)} Mbit/s` : `${(b / 1e3).toFixed(0)} kbit/s`);
const fmtBytes = (n) => (n == null ? '—' : n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(0)} KB`);
const fmtDur = (s) => (s == null ? '—' : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`
  : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Country code -> flag emoji (regional indicator letters) and its name in the browser's language.
const flagOf = (cc) => (/^[A-Z]{2}$/.test(cc ?? '') ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');
const regionNames = new Intl.DisplayNames([], { type: 'region' });
const countryOf = (cc) => { try { return regionNames.of(cc); } catch { return cc; } };

// Signal rings, strongest (inner) to weakest (outer).
const RINGS = [-40, -55, -70, -85];
const SIG_MIN = -95, SIG_MAX = -25;

// A stable angle per device from its MAC, so nodes don't jump around as others come and go.
function angleOf(mac) {
  let h = 2166136261;
  for (const ch of mac) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) / 2 ** 32) * Math.PI * 2;
}

// One categorical slot per device, picked by MAC so a device keeps its color across visits.
function colorOf(mac) {
  let h = 0;
  for (const ch of mac) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `var(--c${(h % 8) + 1})`;
}

// Wi-Fi channel and band from a frequency in MHz.
const channelOf = (f) => (!f ? null : f === 2484 ? 14 : f < 3000 ? (f - 2407) / 5 : f < 5950 ? (f - 5000) / 5 : (f - 5950) / 5);
const bandOf = (f) => (!f ? '' : f < 3000 ? '2.4 GHz' : f < 5950 ? '5 GHz' : '6 GHz');
// Same rule as the server: 2.4 GHz channels under 5 apart, 5 GHz ones in the same 80 MHz block.
function overlap(a, b) {
  if (a <= 14 || b <= 14) return a <= 14 && b <= 14 && Math.abs(a - b) < 5;
  const block = (c) => (c >= 149 ? Math.floor((c - 149) / 16) + 100 : Math.floor((c - 36) / 16));
  return block(a) === block(b);
}
// Latency color class: fine below `warn` ms, slow below `bad`, very slow above.
const latClass = (v, warn, bad) => (v == null ? '' : v >= bad ? 'nm-lat-bad' : v >= warn ? 'nm-lat-warn' : '');

function iconFor(name) {
  if (/mac|book|laptop|desktop|pc|thinkpad|lenovo|dell|intel|asus/i.test(name ?? '')) return 'laptop';
  if (/ipad|tab/i.test(name ?? '')) return 'tablet-screen-button';
  if (/tv|chromecast|roku|lg|sony|vizio|tcl/i.test(name ?? '')) return 'tv';
  if (/sonos|amazon|echo|nest/i.test(name ?? '')) return 'volume-high';
  return 'mobile-screen';
}

function latest(d) {
  const p = [...d.points].reverse().find((x) => x.down != null);
  return d.online && p ? { down: p.down, up: p.up } : { down: null, up: null };
}

function render(hist, status, proxy, x = {}) {
  const map = $('nm-map');
  const W = map.clientWidth, H = map.clientHeight;
  const cx = W / 2, cy = H / 2 + 30;
  const maxR = Math.min(W / 2, H / 2) - 60;
  const rOf = (sig) => {
    const s = Math.min(SIG_MAX, Math.max(SIG_MIN, sig ?? SIG_MIN));
    return 70 + ((SIG_MAX - s) / (SIG_MAX - SIG_MIN)) * (maxR - 70);
  };

  // Rings and links live in the SVG; nodes are HTML so they can carry icons and text.
  const svg = $('nm-lines');
  svg.innerHTML = '';
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  for (const sig of RINGS) {
    const r = rOf(sig);
    const c = document.createElementNS(SVGNS, 'circle');
    Object.entries({ class: 'nm-ring', cx, cy, r }).forEach(([k, v]) => c.setAttribute(k, v));
    svg.appendChild(c);
    const t = document.createElementNS(SVGNS, 'text');
    // Labels sit at the bottom of each ring, where they never overlap each other.
    Object.entries({ class: 'nm-ring-label', x: cx, y: cy + r - 4, 'text-anchor': 'middle' }).forEach(([k, v]) => t.setAttribute(k, v));
    t.textContent = `${sig} dBm`;
    svg.appendChild(t);
  }
  const line = (x1, y1, x2, y2, cls, color) => {
    const l = document.createElementNS(SVGNS, 'line');
    Object.entries({ class: `nm-link ${cls}`, x1, y1, x2, y2 }).forEach(([k, v]) => l.setAttribute(k, v));
    if (color) l.style.stroke = color;
    svg.appendChild(l);
  };
  // Small text on a link (latency); cls colors it by how slow it is.
  const label = (lx, ly, text, anchor, cls = '') => {
    if (!text) return;
    const t = document.createElementNS(SVGNS, 'text');
    Object.entries({ class: `nm-lat ${cls}`, x: lx, y: ly, 'text-anchor': anchor }).forEach(([k, v]) => t.setAttribute(k, v));
    t.textContent = text;
    svg.appendChild(t);
  };
  const flows = [];
  const HUB_R = 23;

  map.querySelectorAll('.nm-node').forEach((n) => n.remove());
  const nodes = [];

  // Router and hub.
  const lat = x.latency ?? {};
  const ms = (v) => (v == null ? null : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);
  const uplinkCard = status.cards.find((c) => c.device === status.defaultRoute);
  const ry = 36;
  line(cx, ry + 20, cx, cy, 'nm-uplink');
  label(cx + 8, (ry + cy) / 2, ms(lat.router), 'start', latClass(lat.router, 10, 50));
  label(cx - 26, ry - 8, lat.internet != null ? `internet ${ms(lat.internet)}` : null, 'end', latClass(lat.internet, 80, 250));
  const totals = hist.devices.reduce((t, d) => { const l = latest(d); t.down += l.down ?? 0; t.up += l.up ?? 0; return t; }, { down: 0, up: 0 });
  // Router -> hub carries everyone's downloads, hub -> router their uploads.
  flows.push({ key: 'uplink-down', from: [cx - 3, ry + 18], to: [cx - 3, cy - HUB_R], rate: totals.down, color: 'var(--flow-uplink)', r: 3 });
  flows.push({ key: 'uplink-up', from: [cx + 3, cy - HUB_R], to: [cx + 3, ry + 18], rate: totals.up, color: 'var(--flow-uplink)', r: 2.2 });
  const ul = uplinkCard?.link;
  const ulCh = channelOf(ul?.freq);
  // Uplink health by signal: below -67 dBm streaming starts to suffer, below -75 it drops out.
  const ulState = !ul ? ' nm-bad' : ul.signal < -75 ? ' nm-bad' : ul.signal < -67 ? ' nm-warn' : '';
  nodes.push({ cls: `nm-router${ulState}`, x: cx, y: ry, size: 34, icon: 'globe', name: ul?.ssid ?? 'Router',
    meta: ul ? `${ul.signal} dBm · ch ${ulCh ?? '?'} · ${bandOf(ul.freq)}` : 'not connected',
    tip: ul && `<div class="nm-t">${esc(ul.ssid)} (router)</div>
      <div>Signal ${ul.signal} dBm${ulState ? ` · <b class="nm-tip-warn">${ul.signal < -75 ? 'weak, expect drop-outs' : 'fair'}</b>` : ' · good'}</div>
      <div>Link ↓ ${esc(ul.rxBitrate ?? '—')} · ↑ ${esc(ul.txBitrate ?? '—')}</div>
      <div>Channel ${ulCh ?? '?'} · ${bandOf(ul.freq)} · via ${esc(uplinkCard.device)}</div>
      <div>Ping router ${ms(lat.router) ?? '—'} · internet ${ms(lat.internet) ?? '—'}</div>` });
  // Proxy on: everyone's traffic leaves through its exit, shown beside the router with city and flag.
  if (proxy?.enabled) {
    const px = cx + Math.min(220, W / 2 - 90);
    const g = proxy.geo;
    const kind = proxy.type === 'wireguard' ? 'VPN' : 'Proxy';
    // Running but the redirect rules miss the hotspot card: phones go direct, so draw it as down.
    const up = proxy.engine && proxy.routing !== false;
    line(cx + 20, ry, px - 20, ry, 'nm-uplink');
    label((cx + px) / 2, ry - 8, ms(lat.proxy), 'middle', latClass(lat.proxy, 400, 1500));
    if (up) {
      flows.push({ key: 'proxy-down', from: [px - 18, ry - 3], to: [cx + 18, ry - 3], rate: totals.down, color: 'var(--flow-uplink)', r: 3 });
      flows.push({ key: 'proxy-up', from: [cx + 18, ry + 3], to: [px - 18, ry + 3], rate: totals.up, color: 'var(--flow-uplink)', r: 2.2 });
    }
    nodes.push({
      cls: `nm-router nm-proxy${up ? '' : ' nm-offline'}`, x: px, y: ry, size: 34, icon: 'shield-halved',
      flag: g ? flagOf(g.country) : '',
      // City and state on the label, country and the exit IP under it.
      name: g ? ([g.city, g.region].filter(Boolean).join(', ') || countryOf(g.country) || kind) : kind,
      meta: !proxy.engine ? 'sing-box stopped' : !up ? 'not routing: fix in Proxy' : g ? [g.city || g.region ? countryOf(g.country) : null, g.ip].filter(Boolean).join(' · ') : 'locating exit…',
      tip: `<div class="nm-t">${g ? `${flagOf(g.country)} ` : ''}${kind} exit</div>
        ${g ? `<div>${esc([g.city, g.region, countryOf(g.country)].filter(Boolean).join(', '))}</div><div>Exit IP ${esc(g.ip)}</div>` : ''}
        <div>${esc(proxy.configured ?? '')}</div>
        <div>Request through it ${ms(lat.proxy) ?? '—'}${proxy.engine ? '' : ' · <b class="nm-tip-warn">sing-box stopped</b>'}</div>
        ${proxy.routing === false ? `<div class="nm-tip-bad">Phones are not going through it: ${esc(proxy.routingIssue ?? '')}</div>` : ''}`,
    });
  }
  const radio = hist.radio;
  const airInfo = x.air ?? {};
  const sharing = (airInfo.networks ?? []).filter((n) => radio?.channel && overlap(n.channel, radio.channel));
  nodes.push({ cls: 'nm-hub', x: cx, y: cy, size: 46, icon: 'tower-broadcast', name: radio?.ssid ?? 'Hotspot',
    meta: radio ? `${(radio.address ?? '').split('/')[0]} · ch ${radio.channel ?? '?'} · ${radio.width ?? '?'} MHz · ${radio.txPower ?? '?'} dBm` : 'off',
    tip: radio && `<div class="nm-t">${esc(radio.ssid)} (hotspot)</div>
      <div>${esc(radio.band)} · channel ${radio.channel} · ${radio.width} MHz wide · ${radio.txPower} dBm</div>
      <div>Gateway ${esc(radio.address ?? '—')}${radio.dhcpRange ? ` · DHCP ${esc(radio.dhcpRange.start)} – ${esc(radio.dhcpRange.end)}` : ''}</div>
      ${radio.width && radio.width <= 20 && radio.channel > 14 ? '<div class="nm-tip-warn">20 MHz on 5 GHz: about half the speed of 40 MHz</div>' : ''}
      <div>${sharing.length} nearby network${sharing.length === 1 ? '' : 's'} on overlapping channels${airInfo.suggest ? ` · quieter: ch ${airInfo.suggest}` : ''}</div>` });

  // Devices: size by current traffic (area ∝ rate), position by signal.
  const now = Date.now();
  const maxRate = Math.max(1e5, ...hist.devices.map((d) => { const l = latest(d); return (l.down ?? 0) + (l.up ?? 0); }));
  for (const d of hist.devices) {
    const l = latest(d);
    const rate = (l.down ?? 0) + (l.up ?? 0);
    const size = 24 + 32 * Math.sqrt(rate / maxRate);
    const a = angleOf(d.mac);
    // Keep devices off the router's spot straight above the hub.
    const ang = Math.abs(Math.sin(a) + 1) < 0.15 ? a + 0.6 : a;
    const r = rOf(d.online ? d.signal : SIG_MIN);
    const x0 = Math.max(60, Math.min(W - 60, cx + r * Math.cos(ang)));
    const y0 = Math.max(24, Math.min(H - 30, cy + r * Math.sin(ang)));
    const color = colorOf(d.mac);
    const active = d.online && rate > 0;
    line(cx, cy, x0, y0, active ? 'nm-active' : '', active ? color : null);
    const devMs = d.online ? lat.devices?.[d.mac] : null;
    if (d.online) label((cx + x0) / 2 + 6, (cy + y0) / 2 - 4, ms(devMs), 'start', `nm-lat-dev ${latClass(devMs, 30, 100)}`);
    if (d.online) {
      // Two parallel tracks so both directions stay visible: download hub -> device, upload back.
      const len = Math.hypot(x0 - cx, y0 - cy) || 1;
      const ux = (x0 - cx) / len, uy = (y0 - cy) / len;
      const px = -uy * 3, py = ux * 3;
      const hubEdge = [cx + ux * HUB_R, cy + uy * HUB_R];
      const devEdge = [x0 - ux * (size / 2 + 2), y0 - uy * (size / 2 + 2)];
      flows.push({ key: `${d.mac}-down`, from: [hubEdge[0] + px, hubEdge[1] + py], to: [devEdge[0] + px, devEdge[1] + py], rate: l.down ?? 0, color, r: 3 });
      flows.push({ key: `${d.mac}-up`, from: [devEdge[0] - px, devEdge[1] - py], to: [hubEdge[0] - px, hubEdge[1] - py], rate: l.up ?? 0, color, r: 2.2 });
    }
    // Retry rate since the device joined: lots of resends with fine signal usually means interference.
    const retry = d.online && d.txPackets > 200 ? d.txRetries / d.txPackets : null;
    const badRetry = retry != null && retry > 0.2;
    const rejects = x.rejects?.[d.mac] ?? 0;
    const vendor = x.vendors?.[d.mac];
    const used = x.usage?.[d.mac];
    const sites = x.sites?.[d.mac];
    const joinedAt = x.joined?.[d.mac];
    const name = d.alias ?? d.hostname ?? (vendor ? `${vendor} device` : d.mac);
    const tags = d.online ? [
      d.standard && `${d.standard.replace('Wi-Fi', 'WiFi')}${d.streams ? ` ${d.streams}×${d.streams}` : ''}`,
      fmtDur(d.connectedSeconds),
      used && `${fmtBytes(used.down + used.up)} today`,
      d.randomMac && 'private MAC',
    ].filter(Boolean).join(' · ') : '';
    nodes.push({
      cls: `nm-device${d.online ? '' : ' nm-offline'}${d.pausedUntil ? ' nm-paused' : ''}${fresh.has(d.mac) ? ' nm-new' : ''}`
        + `${d.online && joinedAt && now - joinedAt < 120_000 && !fresh.has(d.mac) ? ' nm-joined' : ''}${badRetry ? ' nm-retry' : ''}`,
      x: x0, y: y0, size, icon: d.icon ?? iconFor(`${d.hostname ?? ''} ${vendor ?? ''}`), d, l, color, name, tags,
      badge: rejects ? { text: rejects > 99 ? '99+' : String(rejects), title: `${rejects} connection${rejects === 1 ? '' : 's'} rejected by the proxy in the last hour` } : null,
      meta: d.pausedUntil ? `⏸ paused · ${Math.ceil((d.pausedUntil - Date.now()) / 60000)} min left`
        : badRetry ? `⚠ ${Math.round(retry * 100)}% retries · ↓ ${fmtRate(l.down)}`
        : d.online ? `↓ ${fmtRate(l.down)} · ↑ ${fmtRate(l.up)}` : `offline · seen ${fmtTime(d.lastSeen)}`,
      tip: `<div class="nm-t">${esc(name)} ${d.online ? '' : '(offline)'}</div>
        <div>IP ${esc(d.ip ?? '—')} · ${esc(d.mac)}${d.randomMac ? ' (private)' : ''}</div>
        ${vendor ? `<div>Made by ${esc(vendor)}</div>` : ''}
        <div>Signal ${d.signal ?? '—'} dBm · ${esc(d.standard ?? '')}${d.streams ? ` ${d.streams}×${d.streams}` : ''} ${d.txBitrate ? `· link ${d.txBitrate} Mbit/s` : ''}</div>
        ${d.online ? `<div>Ping ${ms(devMs) ?? 'no answer'}${retry != null ? ` · retries ${Math.round(retry * 100)}%` : ''}${d.txFailed ? ` · ${d.txFailed} failed` : ''}</div>` : ''}
        ${badRetry ? '<div class="nm-tip-warn">Many resends: interference or a wall in the way</div>' : ''}
        <div>Now ↓ ${fmtRate(l.down)} · ↑ ${fmtRate(l.up)}</div>
        <div>Today ${used ? `${fmtBytes(used.down)} down · ${fmtBytes(used.up)} up` : '—'}</div>
        <div>${d.online ? `Connected ${fmtDur(d.connectedSeconds)}` : `Last seen ${fmtTime(d.lastSeen)}`}</div>
        ${rejects ? `<div class="nm-tip-bad">${rejects} rejected by the proxy (last hour)</div>` : ''}
        ${sites?.length ? `<div class="nm-tip-sites">Busy with: ${sites.map((s) => esc(s.host)).join(', ')}</div>` : ''}`,
    });
  }

  for (const n of nodes) {
    const el = document.createElement(n.d ? 'a' : 'div');
    el.className = `nm-node ${n.cls}`;
    if (n.color) el.style.setProperty('--dev', n.color);
    el.style.left = `${Math.max(60, Math.min(W - 60, n.x))}px`;
    el.style.top = `${Math.max(24, Math.min(H - 30, n.y))}px`;
    el.innerHTML = `<div class="nm-bubble" style="width:${n.size}px;height:${n.size}px;font-size:${Math.round(n.size * 0.42)}px">
        <i class="fa-solid fa-${n.icon}" aria-hidden="true"></i>
        ${n.badge ? `<span class="nm-badge" title="${esc(n.badge.title)}">${esc(n.badge.text)}</span>` : ''}</div>
      <div class="nm-name">${n.flag ? `<span class="nm-flag" aria-hidden="true">${n.flag}</span> ` : ''}${esc(n.name)}</div>
      <div class="nm-meta">${esc(n.meta)}</div>${n.tags ? `<div class="nm-meta nm-tags">${esc(n.tags)}</div>` : ''}`;
    if (n.d) {
      el.href = `/device?mac=${encodeURIComponent(n.d.mac)}`;
      el.setAttribute('aria-label', `${n.name}, ${n.meta}${n.badge ? `, ${n.badge.title}` : ''}`);
    }
    if (n.tip) {
      el.tabIndex = 0;
      const show = () => {
        const tip = $('nm-tip');
        tip.innerHTML = n.tip;
        tip.style.display = 'block';
        const left = parseFloat(el.style.left) + n.size / 2 + 12;
        tip.style.left = `${left + tip.offsetWidth > W ? parseFloat(el.style.left) - tip.offsetWidth - n.size / 2 - 12 : left}px`;
        tip.style.top = `${Math.max(8, Math.min(H - tip.offsetHeight - 8, parseFloat(el.style.top) - tip.offsetHeight / 2))}px`;
      };
      el.addEventListener('pointerenter', show);
      el.addEventListener('focus', show);
      el.addEventListener('pointerleave', () => { $('nm-tip').style.display = 'none'; });
      el.addEventListener('blur', () => { $('nm-tip').style.display = 'none'; });
    }
    map.appendChild(el);
  }

  setFlows(flows);
  renderAir(airInfo, radio, sharing);

  // Overview tiles.
  const online = hist.devices.filter((d) => d.online);
  const sum = (k) => online.reduce((s, d) => s + (latest(d)[k] ?? 0), 0);
  const tiles = [
    ['Online now', `${online.length}`],
    ['Seen (last hour)', `${hist.devices.length}`],
    ['Total download now', fmtRate(sum('down'))],
    ['Total upload now', fmtRate(sum('up'))],
    ['Weakest signal', online.length ? `${Math.min(...online.map((d) => d.signal ?? 0))} dBm` : '—'],
    ['Ping router / internet', lat.router == null && lat.internet == null ? '—' : `${ms(lat.router) ?? '—'} / ${ms(lat.internet) ?? '—'}`],
  ];
  $('nm-summary').innerHTML = tiles.map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('');
}

// Nearby networks, in a corner panel: the ones on channels that overlap the hotspot's
// are the ones slowing it down. Suggests a clearly quieter channel when there is one.
function renderAir(air, radio, sharing) {
  let box = $('nm-air');
  if (!box) {
    box = document.createElement('div');
    box.id = 'nm-air';
    $('nm-map').appendChild(box);
  }
  if (!radio?.channel || !air.at) { box.hidden = true; return; }
  box.hidden = false;
  const list = [...sharing].sort((a, b) => b.signal - a.signal);
  const others = (air.networks ?? []).length - list.length;
  box.innerHTML = `<div class="nm-air-head"><i class="fa-solid fa-tower-cell" aria-hidden="true"></i>Air around ch ${radio.channel}</div>
    ${list.slice(0, 5).map((n) => `<div class="nm-air-row" title="${esc(n.bssid)}">
      <span class="nm-air-bar" style="width:${Math.max(4, n.signal * 0.5)}px"></span>${esc(n.ssid ?? '(hidden)')} <span>ch ${n.channel}</span></div>`).join('')
      || '<div class="nm-air-row">No other networks on this channel</div>'}
    ${list.length > 5 ? `<div class="nm-air-more">+${list.length - 5} more on overlapping channels</div>` : ''}
    <div class="nm-air-more">${others} more elsewhere · scanned ${fmtTime(air.at)}</div>
    ${air.suggest ? `<div class="nm-air-tip">Channel ${air.suggest} is quieter</div>` : ''}`;
}

// ---- data-flow animation ----------------------------------------------------
// Each flow is a stream of dots from `from` to `to`. More traffic = more dots,
// moving faster (both on a square-root scale so small flows stay visible).
// Phases persist across the 5 s data refresh, so dots never jump.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
let flowList = [];
const phase = new Map();

function setFlows(list) {
  const max = Math.max(1e5, ...list.map((f) => f.rate));
  flowList = list.map((f) => {
    const k = f.rate > 0 ? Math.sqrt(f.rate / max) : 0;
    return { ...f, dots: f.rate > 0 ? 1 + Math.round(5 * k) : 0, speed: 35 + 165 * k,
             len: Math.hypot(f.to[0] - f.from[0], f.to[1] - f.from[1]) || 1 };
  });
  const svg = $('nm-flow');
  svg.setAttribute('viewBox', `0 0 ${$('nm-map').clientWidth} ${$('nm-map').clientHeight}`);
  if (reduceMotion.matches) drawFlows(0);
}

function drawFlows(dt) {
  const svg = $('nm-flow');
  const want = flowList.reduce((n, f) => n + f.dots, 0);
  while (svg.childElementCount < want) svg.appendChild(document.createElementNS(SVGNS, 'circle'));
  while (svg.childElementCount > want) svg.lastChild.remove();
  let i = 0;
  for (const f of flowList) {
    if (!f.dots) continue;
    const p = ((phase.get(f.key) ?? Math.random()) + (f.speed * dt) / f.len) % 1;
    phase.set(f.key, p);
    for (let k = 0; k < f.dots; k++) {
      const s = (p + k / f.dots) % 1;
      const c = svg.children[i++];
      c.setAttribute('cx', f.from[0] + (f.to[0] - f.from[0]) * s);
      c.setAttribute('cy', f.from[1] + (f.to[1] - f.from[1]) * s);
      c.setAttribute('r', f.r);
      // Fade in and out at the ends so dots appear to leave and enter the bubbles.
      c.setAttribute('opacity', Math.min(1, s * 6, (1 - s) * 6).toFixed(2));
      c.style.fill = f.color;
      c.style.color = f.color;
    }
  }
}

let prevT = performance.now();
function frame(t) {
  const dt = Math.min(0.1, (t - prevT) / 1000);
  prevT = t;
  if (!reduceMotion.matches && !document.hidden) drawFlows(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- new device alerts -------------------------------------------------------
// Devices this browser has seen before are kept in localStorage. The first visit
// only records what is there; afterwards an unknown device gets a toast, a pulse
// on the map and (if switched on) a chime.
const KNOWN_KEY = 'wx.knownDevices';
const SOUND_KEY = 'wx.alertSound';
const fresh = new Map(); // mac -> time it was first noticed, pulses for a minute
let known = null;

function chime() {
  if (localStorage.getItem(SOUND_KEY) !== 'on') return;
  const ctx = new AudioContext();
  [660, 880, 1320].forEach((f, i) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.12);
    g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + i * 0.12 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.12 + 0.3);
    o.connect(g).connect(ctx.destination);
    o.start(ctx.currentTime + i * 0.12);
    o.stop(ctx.currentTime + i * 0.12 + 0.32);
  });
}

function toast(html) {
  let box = document.getElementById('nm-toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'nm-toasts';
    box.setAttribute('role', 'status');
    document.body.appendChild(box);
  }
  const t = document.createElement('div');
  t.className = 'nm-toast';
  t.innerHTML = html;
  box.appendChild(t);
  setTimeout(() => t.classList.add('nm-toast-out'), 7000);
  setTimeout(() => t.remove(), 7600);
}

function checkNewDevices(devices) {
  const now = Date.now();
  for (const [mac, t] of fresh) if (now - t > 60_000) fresh.delete(mac);
  if (!known) {
    known = new Set(JSON.parse(localStorage.getItem(KNOWN_KEY) ?? 'null') ?? devices.map((d) => d.mac));
  }
  for (const d of devices) {
    if (known.has(d.mac) || !d.online) continue;
    known.add(d.mac);
    fresh.set(d.mac, now);
    toast(`<i class="fa-solid fa-bell" aria-hidden="true"></i> New device joined: <b>${esc(d.alias ?? d.hostname ?? d.mac)}</b>
      <span class="nm-toast-meta">${esc(d.ip ?? '')} · ${esc(d.mac)}${d.randomMac ? ' · private MAC' : ''}</span>`);
    chime();
  }
  localStorage.setItem(KNOWN_KEY, JSON.stringify([...known]));
}

// Sound toggle (a button with id nm-sound, if the page has one).
const soundBtn = $('nm-sound');
function paintSound() {
  if (!soundBtn) return;
  const on = localStorage.getItem(SOUND_KEY) === 'on';
  soundBtn.innerHTML = `<i class="fa-solid fa-${on ? 'volume-high' : 'volume-xmark'}" aria-hidden="true"></i>Alert sound ${on ? 'on' : 'off'}`;
  soundBtn.setAttribute('aria-pressed', on);
}
soundBtn?.addEventListener('click', () => {
  localStorage.setItem(SOUND_KEY, localStorage.getItem(SOUND_KEY) === 'on' ? 'off' : 'on');
  paintSound();
  chime(); // a sample, and the click unlocks audio in the browser
});
paintSound();

// "Sites" toggle (a button with id nm-sites): which sites each device is reaching, opt-in.
const sitesBtn = $('nm-sites');
function paintSites(on) {
  if (!sitesBtn) return;
  sitesBtn.innerHTML = `<i class="fa-solid fa-${on ? 'eye' : 'eye-slash'}" aria-hidden="true"></i>Sites ${on ? 'on' : 'off'}`;
  sitesBtn.setAttribute('aria-pressed', on);
  sitesBtn.title = on ? 'Hover a device to see the sites it is reaching (through the proxy). Kept in memory for 10 minutes.'
    : 'Show which sites each device is reaching (needs the proxy on)';
}
sitesBtn?.addEventListener('click', async () => {
  const on = sitesBtn.getAttribute('aria-pressed') !== 'true';
  const headers = { 'Content-Type': 'application/json' };
  const admin = document.getElementById('admin')?.value;
  if (admin) headers['X-Admin-Password'] = admin;
  const r = await fetch('/api/map/sites', { method: 'POST', headers, body: JSON.stringify({ enabled: on }) });
  if (r.ok) paintSites((await r.json()).enabled);
});

let last = null;
async function refresh() {
  try {
    const [hist, status, proxy, extra] = await Promise.all(['/api/devices', '/api/status', '/api/proxy', '/api/map']
      .map((u) => fetch(u).then((r) => r.json())));
    last = [hist, status, proxy, extra];
    checkNewDevices(hist.devices);
    render(hist, status, proxy, extra);
    paintSites(extra.sitesEnabled);
  } catch { /* keep the last view */ }
}
window.addEventListener('resize', () => last && render(...last));
refresh();
setInterval(refresh, 5000);
