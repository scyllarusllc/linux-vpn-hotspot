// Thin wrappers around nmcli / iw / ip. Every command that changes the system
// goes through `run`, so the flow can print it in dry-run mode instead.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  parseDefaultRoute,
  parseDevices,
  parseDhcpAcks,
  parseDhcpRange,
  parseIwInfo,
  parseLink,
  parseModes,
  parseNeighbors,
  parseStations,
  isRandomMac,
  wifiStandard,
} from './parse.js';

const exec = promisify(execFile);

export const HOTSPOT_CON = 'wifi-extender-hotspot';

export async function sh(cmd, args) {
  const { stdout } = await exec(cmd, args, { encoding: 'utf8' });
  return stdout;
}

export async function tryCmd(cmd, args) {
  try {
    return await sh(cmd, args);
  } catch {
    return null;
  }
}

// Root is needed for nft/ufw: use cached sudo if available, else a polkit password dialog.
export async function asRoot(script) {
  const sudo = (await tryCmd('sudo', ['-n', 'true'])) !== null;
  return sudo ? sh('sudo', ['sh', '-c', script]) : sh('pkexec', ['sh', '-c', script]);
}

export const fmt = (cmd, args) =>
  [cmd, ...args.map((a) => (a === '' || /[\s"']/.test(a) ? JSON.stringify(a) : a))].join(' ');

export async function wifiDevices() {
  return parseDevices(await sh('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'dev']));
}

export async function isUsb(dev) {
  const target = await tryCmd('readlink', ['-f', `/sys/class/net/${dev}/device`]);
  return target?.includes('/usb') ?? false;
}

export async function phyOf(dev) {
  return (await readFile(`/sys/class/net/${dev}/phy80211/name`, 'utf8')).trim();
}

export async function supportsAp(dev) {
  return parseModes(await sh('iw', ['phy', await phyOf(dev), 'info'])).includes('AP');
}

export async function link(dev) {
  return parseLink((await tryCmd('iw', ['dev', dev, 'link'])) ?? 'Not connected');
}

export async function defaultRouteDev() {
  return parseDefaultRoute(await sh('ip', ['route', 'show', 'default']));
}

export async function stations(dev) {
  return parseStations((await tryCmd('iw', ['dev', dev, 'station', 'dump'])) ?? '');
}

export async function hasCommand(name) {
  return (await tryCmd('sh', ['-c', `command -v ${name}`])) !== null;
}

export async function hotspotActive() {
  const out = await sh('nmcli', ['-t', '-f', 'NAME,DEVICE', 'con', 'show', '--active']);
  return out.split('\n').some((l) => l.startsWith(`${HOTSPOT_CON}:`));
}

// Connected clients with IP and hostname. The lease file is root-only, so the
// hostname comes from dnsmasq's DHCPACK lines in the journal.
export async function clients(dev) {
  const [neigh, acks] = await Promise.all([
    tryCmd('ip', ['neigh', 'show', 'dev', dev]),
    tryCmd('journalctl', ['-t', 'dnsmasq-dhcp', '--since', '-1d', '-o', 'cat', '--no-pager']),
  ]);
  const ips = parseNeighbors(neigh ?? '');
  const leases = parseDhcpAcks(acks ?? '');
  return (await stations(dev)).map((st) => ({
    ...st,
    ...wifiStandard(st.txMode),
    randomMac: isRandomMac(st.mac),
    ip: ips[st.mac] ?? leases[st.mac]?.ip ?? null,
    hostname: leases[st.mac]?.hostname ?? null,
  }));
}

export async function hotspotInfo(dev) {
  const fields = await tryCmd('nmcli', ['-g', '802-11-wireless.ssid,802-11-wireless.band', 'con', 'show', HOTSPOT_CON]);
  const [ssid, band] = (fields ?? '').trim().split('\n');
  const dnsmasq = (await tryCmd('pgrep', ['-a', 'dnsmasq'])) ?? '';
  const mine = dnsmasq.split('\n').find((l) => l.includes(`dnsmasq-${dev}.`)) ?? '';
  return {
    ssid: ssid || null,
    band: band === 'a' ? '5 GHz' : '2.4 GHz',
    address: (await hotspotAddress()) || null,
    dhcpRange: parseDhcpRange(mine),
    ...parseIwInfo((await tryCmd('iw', ['dev', dev, 'info'])) ?? ''),
  };
}

export async function getStatus() {
  const cards = [];
  for (const d of await wifiDevices()) {
    const l = await link(d.device);
    const role = d.connection === HOTSPOT_CON ? 'hotspot' : l ? 'client' : 'idle';
    cards.push({
      device: d.device,
      usb: await isUsb(d.device),
      state: d.state,
      connection: d.connection,
      role,
      link: role === 'client' ? l : null,
      clients: role === 'hotspot' ? await clients(d.device) : [],
      info: role === 'hotspot' ? await hotspotInfo(d.device) : null,
    });
  }
  return { cards, defaultRoute: await defaultRouteDev(), hotspot: await hotspotActive() };
}

// Address the hotspot hands out as gateway, e.g. "10.0.0.1/24" (empty = NetworkManager default).
export async function hotspotAddress() {
  return ((await tryCmd('nmcli', ['-g', 'ipv4.addresses', 'con', 'show', HOTSPOT_CON])) ?? '').trim();
}

// Where the hotspot lives right now, for the nft rules.
export async function hotspotNet(webPort) {
  const ap = (await wifiDevices()).find((d) => d.connection === HOTSPOT_CON);
  const gateway = (await hotspotAddress()).split('/')[0];
  if (!ap || !gateway) throw new Error('Hotspot is not running. Start it first.');
  return { hotspotIf: ap.device, gateway, webPort };
}

// The running hotspot's SSID, band, password and gateway (nmcli -s reveals the secret).
export async function hotspotSettings() {
  const out = await sh('nmcli', ['-s', '-g',
    '802-11-wireless.ssid,802-11-wireless.band,802-11-wireless-security.psk,ipv4.addresses',
    'con', 'show', HOTSPOT_CON]);
  const [ssid, band, password, address] = out.trim().split('\n');
  return { ssid, band: band === 'a' ? 'a' : 'bg', password, gateway: address.split('/')[0] || '10.0.0.1' };
}
