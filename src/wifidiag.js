// Why is there only one Wi-Fi card? Looks at every layer between the USB plug and
// NetworkManager, without root: the USB bus (sysfs), which driver took each adapter,
// the kernel log for that USB port, rfkill, Wi-Fi interfaces and nmcli's view of them.
// gatherWifiDiag reads the system; diagnose turns the readings into findings (pure, tested).

import { readFile, readdir, readlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { asRoot, hasCommand, supportsAp, tryCmd } from './system.js';

const USB = '/sys/bus/usb/devices';
const NET = '/sys/class/net';
const RFKILL = '/sys/class/rfkill';
const CD_MODE = /cd-?rom|zero-?cd|driver (cd|disk)/i;
const WIFI_NAME = /wlan|wireless|wi-?fi|802\.11|\bwifi\b/i;
// Vendors whose vendor-specific (class ff) USB devices are almost always Wi-Fi adapters.
const WIFI_VENDORS = new Set(['0bda', '148f', '0e8d', '2357', '7392', '0cf3', '13b1', '2001', '0846', '0b05', '2c4e', '35bc']);
// "Bus 4, port 2" style ids from sysfs, e.g. 4-2 or 3-1.4 (behind a hub).
const PORT = /^\d+-\d+(\.\d+)*$/;

const read = (path) => readFile(path, 'utf8').then((s) => s.trim(), () => null);
const driverOf = (path) => readlink(join(path, 'driver')).then((l) => basename(l), () => null);

async function usbDevices() {
  const names = await readdir(USB).catch(() => []);
  const out = [];
  for (const port of names.filter((n) => PORT.test(n))) {
    const dir = join(USB, port);
    const interfaces = [];
    for (const i of names.filter((n) => n.startsWith(`${port}:`))) {
      interfaces.push({ name: i, cls: await read(join(USB, i, 'bInterfaceClass')), driver: await driverOf(join(USB, i)) });
    }
    out.push({
      port,
      vendor: await read(join(dir, 'idVendor')),
      product: await read(join(dir, 'idProduct')),
      name: [await read(join(dir, 'manufacturer')), await read(join(dir, 'product'))].filter(Boolean).join(' '),
      speed: Number(await read(join(dir, 'speed'))) || null,
      interfaces,
    });
  }
  return out;
}

async function wifiInterfaces() {
  const out = [];
  for (const dev of await readdir(NET).catch(() => [])) {
    if ((await read(join(NET, dev, 'phy80211', 'name'))) === null) continue;
    const path = (await tryCmd('readlink', ['-f', join(NET, dev, 'device')]))?.trim() ?? '';
    // .../usb4/4-2/4-2:1.0 -> the adapter is the USB device 4-2.
    const usbPort = path.split('/').filter((p) => PORT.test(p)).at(-1) ?? null;
    out.push({ device: dev, driver: await driverOf(join(NET, dev, 'device')), usbPort, ap: await supportsAp(dev).catch(() => null) });
  }
  return out;
}

async function rfkill() {
  const out = [];
  for (const r of await readdir(RFKILL).catch(() => [])) {
    const dir = join(RFKILL, r);
    out.push({ type: await read(join(dir, 'type')), name: await read(join(dir, 'name')),
      soft: (await read(join(dir, 'soft'))) === '1', hard: (await read(join(dir, 'hard'))) === '1' });
  }
  return out;
}

// Wi-Fi devices as nmcli sees them, with their state ("unmanaged" matters here). null = nmcli failed.
async function nmDevices() {
  const out = await tryCmd('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE', 'dev']);
  if (out === null) return null;
  return out.split('\n').filter(Boolean).map((l) => l.split(':')).filter(([, type]) => type === 'wifi')
    .map(([device, , state]) => ({ device, state }));
}

export async function gatherWifiDiag() {
  const [usb, wifi, rf, nm, kernel, modeswitch] = await Promise.all([
    usbDevices(), wifiInterfaces(), rfkill(), nmDevices(),
    tryCmd('journalctl', ['-k', '-b', '-o', 'cat', '--no-pager', '-n', '3000']),
    hasCommand('usb_modeswitch'),
  ]);
  return { usb, wifi, rfkill: rf, nm, kernel, modeswitch };
}

// Kernel lines about one USB port since it was last plugged in ("usb 4-2: ..." and "drv 4-2:1.0: ...").
export function kernelLinesFor(log, port) {
  const lines = String(log ?? '').split('\n');
  const esc = port.replace(/\./g, '\\.');
  const mine = new RegExp(`(^|\\s)${esc}(:\\d+\\.\\d+)?:\\s`);
  const plugged = new RegExp(`^usb ${esc}: new .*USB device number`, 'i');
  const start = lines.findLastIndex((l) => plugged.test(l));
  return lines.slice(Math.max(start, 0)).filter((l) => mine.test(l));
}

// A USB device that is (or wants to be) a Wi-Fi adapter. Bluetooth and hubs are never.
export function isWifiCandidate(d, wifi = []) {
  if (wifi.some((w) => w.usbPort === d.port)) return true;
  if (/bluetooth/i.test(d.name) || d.interfaces.some((i) => ['09', 'e0'].includes(i.cls))) return false;
  if (CD_MODE.test(d.name) || WIFI_NAME.test(d.name)) return true;
  // A storage interface from a Wi-Fi vendor is an adapter still in CDROM mode (card readers aside).
  if (/reader/i.test(d.name)) return false;
  return WIFI_VENDORS.has(d.vendor) && d.interfaces.some((i) => i.cls === 'ff' || i.cls === '08');
}

const usbSpeed = (mbps) => (mbps >= 5000 ? 'USB 3' : mbps >= 480 ? 'USB 2' : mbps ? 'USB 1' : '');

// What happened to one adapter, as { level, title, detail, fix, log, port, action }.
function adapterFinding(d, data) {
  const id = `${d.vendor}:${d.product}`;
  const label = `${d.name || 'USB device'} (${id}, port ${d.port})`;
  const iface = data.wifi.find((w) => w.usbPort === d.port);
  const log = kernelLinesFor(data.kernel, d.port);
  const base = { port: d.port, title: label, log: log.slice(-12) };
  if (iface) {
    return { ...base, level: 'ok', detail: `Working: Wi-Fi card ${iface.device}, driver ${iface.driver ?? 'unknown'}.`, log: [] };
  }
  const storage = d.interfaces.some((i) => i.cls === '08');
  if (CD_MODE.test(d.name) || (storage && !d.interfaces.some((i) => i.cls === 'ff'))) {
    return {
      ...base, level: 'fail', action: 'modeswitch',
      detail: 'The adapter is in "CDROM mode": it pretends to be a driver disk and is not a Wi-Fi card yet.',
      fix: `Press "Switch to Wi-Fi mode" (installs usb_modeswitch${data.modeswitch ? ', already installed' : ''} and switches it).`,
    };
  }
  const probe = log.map((l) => l.match(/probe with driver (\S+) failed with error (-?\d+)/)).filter(Boolean).at(-1);
  const fwMissing = log.find((l) => /firmware load for \S+ failed|failed to (load|request) firmware/i.test(l));
  if (fwMissing) {
    return {
      ...base, level: 'fail', action: 'replug',
      detail: 'The driver could not find the firmware file it needs.',
      fix: 'Install or update the firmware (Arch: sudo pacman -Syu linux-firmware), then replug the adapter.',
    };
  }
  if (probe) {
    // The first failure is the cause; the ones after it ("failed to setup chip", "probe failed") follow from it.
    const why = log.find((l) => /fail|error|unable/i.test(l) && !l.includes('probe with driver'))?.replace(/^\S+ \S+: /, '');
    const firmware = /firmware/i.test(why ?? '');
    return {
      ...base, level: 'fail', action: 'replug',
      detail: `The driver ${probe[1]} found the adapter but failed to start it (error ${probe[2]})${why ? `: "${why}"` : ''}. ` +
        `${firmware ? 'The firmware file and the driver in this kernel don\'t match. ' : ''}` +
        'The adapter will not show up as a Wi-Fi card until the driver starts.',
      fix: firmware
        ? 'Update kernel and firmware together (sudo pacman -Syu, then reboot); a replug alone rarely helps. ' +
          'If they are already current, the firmware is newer than the driver understands: try another kernel (e.g. linux-lts) ' +
          'or wait for the next kernel update.'
        : 'Replug it (the button below does it in software), or unplug and plug it into another port' +
          `${d.speed >= 5000 ? ' (a USB 2 port often works better for these adapters)' : ''}. ` +
          'If it keeps failing, reboot; if it still fails, update the system (sudo pacman -Syu) or try another kernel.',
    };
  }
  const driver = d.interfaces.map((i) => i.driver).find(Boolean);
  if (driver) {
    return {
      ...base, level: 'warn', action: 'replug',
      detail: `Driver ${driver} took the adapter, but no Wi-Fi card appeared.`,
      fix: 'Wait a few seconds and re-check; if nothing changes, replug it.',
    };
  }
  return {
    ...base, level: 'fail',
    detail: 'No driver took this adapter: Linux has no driver for it built in.',
    fix: `Search for "${id} linux driver" (it may need a driver from the AUR), or use an adapter Linux supports out of the box.`,
  };
}

// data from gatherWifiDiag. Returns { verdict, findings, adapters, cards }, findings worst first.
export function diagnose(data) {
  const findings = [];
  const adapters = data.usb.filter((d) => isWifiCandidate(d, data.wifi));
  const nmWifi = data.nm ?? [];

  for (const d of adapters) findings.push(adapterFinding(d, data));
  if (!adapters.length) {
    findings.push({
      level: 'fail', title: 'No USB Wi-Fi adapter on the USB bus',
      detail: 'Linux sees no USB device that looks like a Wi-Fi adapter, so it is not plugged in, gets no power or has a bad cable/port.',
      fix: 'Plug it straight into the laptop (not a hub), try another USB port, and re-check. Its light should come on.',
      log: [],
    });
  }

  for (const r of data.rfkill.filter((x) => x.type === 'wlan' && (x.soft || x.hard))) {
    findings.push({
      level: 'fail', title: `Wi-Fi is switched off (${r.name})`,
      detail: r.hard ? 'Blocked by a hardware switch or key.' : 'Blocked in software (airplane mode or rfkill).',
      fix: r.hard ? 'Flip the Wi-Fi switch / press the Wi-Fi key.' : 'Run: rfkill unblock wifi', log: [],
    });
  }

  for (const w of data.wifi) {
    const nm = nmWifi.find((n) => n.device === w.device);
    if (data.nm && !nm) {
      findings.push({ level: 'warn', title: `${w.device} is missing from NetworkManager`, detail: 'The card exists, but nmcli does not list it.',
        fix: 'Restart NetworkManager: sudo systemctl restart NetworkManager', log: [] });
    } else if (nm?.state === 'unmanaged') {
      findings.push({ level: 'fail', title: `NetworkManager ignores ${w.device}`, detail: 'The card is "unmanaged", so it cannot be used as uplink or hotspot.',
        fix: `Run: nmcli dev set ${w.device} managed yes`, log: [] });
    }
  }

  if (data.kernel === null) {
    findings.push({ level: 'warn', title: 'Kernel log not readable', detail: 'journalctl -k failed, so driver errors cannot be shown.',
      fix: 'Add yourself to the systemd-journal group (sudo usermod -aG systemd-journal $USER), log out and in.', log: [] });
  }

  const order = { fail: 0, warn: 1, ok: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  const count = data.nm ? nmWifi.length : data.wifi.length;
  const verdict = count >= 2
    ? { level: 'ok', text: `${count} Wi-Fi cards are ready. Go back and press Start.` }
    : { level: 'fail', text: `${count} Wi-Fi card${count === 1 ? '' : 's'} visible, the hotspot needs 2. ${findings[0]?.level === 'fail' ? findings[0].title : 'See below.'}` };
  return {
    verdict,
    findings,
    adapters: adapters.map((d) => d.port),
    cards: data.wifi.map((w) => ({ ...w, usb: Boolean(w.usbPort), state: nmWifi.find((n) => n.device === w.device)?.state ?? null })),
    usb: data.usb.map((d) => ({ ...d, speedName: usbSpeed(d.speed), drivers: [...new Set(d.interfaces.map((i) => i.driver).filter(Boolean))] })),
  };
}

// Software replug: de-authorize and re-authorize the USB device, so the kernel probes it again.
export async function replugUsb(port) {
  if (!PORT.test(port ?? '') || (await read(join(USB, port, 'idVendor'))) === null) {
    throw Object.assign(new Error('That USB device is not plugged in any more. Re-check.'), { status: 404 });
  }
  const f = JSON.stringify(join(USB, port, 'authorized'));
  await asRoot(`echo 0 > ${f}\nsleep 1\necho 1 > ${f}\nsleep 5`);
}
