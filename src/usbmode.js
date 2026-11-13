// Some USB Wi-Fi adapters (e.g. Realtek RTL8188GU, 0bda:1a2b) first show up as a fake
// "Driver CDROM" disk and only become a Wi-Fi card after usb_modeswitch. Until then
// `nmcli dev` lists no second card and flow step 1 fails.

import { asRoot, sh, tryCmd, wifiDevices } from './system.js';

const CD_MODE = /cd-?rom|zero-?cd|driver (cd|disk)/i;

// "Bus 003 Device 008: ID 0bda:1a2b Realtek ... (Driver CDROM Mode)" -> [{ vendor, product, name }]
export function parseModeSwitchCandidates(lsusb) {
  return lsusb.split('\n').flatMap((line) => {
    const m = line.match(/ID ([0-9a-f]{4}):([0-9a-f]{4})\s*(.*)$/i);
    return m && CD_MODE.test(m[3]) ? [{ vendor: m[1].toLowerCase(), product: m[2].toLowerCase(), name: m[3].trim() }] : [];
  });
}

export function modeSwitchScript(candidates) {
  return [
    'pacman -S --needed --noconfirm usb_modeswitch',
    ...candidates.map((c) => `usb_modeswitch -KW -v ${c.vendor} -p ${c.product}`),
    'sleep 3',
  ].join('\n');
}

export async function fixUsbWifi() {
  const candidates = parseModeSwitchCandidates((await tryCmd('lsusb', [])) ?? '');
  if (candidates.length) await asRoot(modeSwitchScript(candidates));
  const devices = (await sh('nmcli', ['dev'])).trim();
  const wifi = (await wifiDevices()).filter((d) => d.type === 'wifi').length;
  if (!candidates.length && wifi < 2) {
    throw Object.assign(new Error('No USB adapter in "CDROM mode" found and only one Wi-Fi card is visible. Plug the adapter in (try another USB port) and try again, or open /wifi-check to see why.'), { status: 409 });
  }
  return { candidates, wifi, devices };
}
