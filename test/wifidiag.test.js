import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnose, isWifiCandidate, kernelLinesFor } from '../src/wifidiag.js';

// A Realtek RTL8852BU whose driver probe failed, after an earlier attempt on the same port.
const KERNEL = `usb 4-2: new SuperSpeed USB device number 1 using xhci_hcd
rtw89_8852bu 4-2:1.0: failed to allocate hw
usb 4-2: USB disconnect, device number 1
usb 4-2: new SuperSpeed USB device number 2 using xhci_hcd
usb 4-2: New USB device found, idVendor=0bda, idProduct=b832, bcdDevice= 0.00
usb 4-20: unrelated device
rtw89_8852bu 4-2:1.0: loaded firmware rtw89/rtw8852b_fw-2.bin
rtw89_8852bu 4-2:1.0: failed to recognize firmware elements
rtw89_8852bu 4-2:1.0: failed to setup chip information
rtw89_8852bu 4-2:1.0: probe with driver rtw89_8852bu failed with error -12
[UFW BLOCK] IN=wlp0s20f3 OUT=`;

const realtek = { port: '4-2', vendor: '0bda', product: 'b832', name: 'Realtek 802.11ax WLAN Adapter', speed: 5000,
  interfaces: [{ name: '4-2:1.0', cls: 'ff', driver: null }] };
const camera = { port: '3-5', vendor: '5986', product: '212a', name: 'SunplusIT Inc Integrated Camera', speed: 480,
  interfaces: [{ name: '3-5:1.0', cls: '0e', driver: 'uvcvideo' }] };
const bluetooth = { port: '3-10', vendor: '8087', product: '0026', name: 'Intel Corp. AX201 Bluetooth', speed: 12,
  interfaces: [{ name: '3-10:1.0', cls: 'e0', driver: 'btusb' }] };
const builtIn = { device: 'wlp0s20f3', driver: 'iwlwifi', usbPort: null, ap: true };
const base = { usb: [realtek, camera, bluetooth], wifi: [builtIn], rfkill: [], nm: [{ device: 'wlp0s20f3', state: 'connected' }], kernel: KERNEL, modeswitch: false };

test('kernel lines: only this port, only since it was last plugged in', () => {
  assert.deepEqual(kernelLinesFor(KERNEL, '4-2'), [
    'usb 4-2: new SuperSpeed USB device number 2 using xhci_hcd',
    'usb 4-2: New USB device found, idVendor=0bda, idProduct=b832, bcdDevice= 0.00',
    'rtw89_8852bu 4-2:1.0: loaded firmware rtw89/rtw8852b_fw-2.bin',
    'rtw89_8852bu 4-2:1.0: failed to recognize firmware elements',
    'rtw89_8852bu 4-2:1.0: failed to setup chip information',
    'rtw89_8852bu 4-2:1.0: probe with driver rtw89_8852bu failed with error -12',
  ]);
  assert.deepEqual(kernelLinesFor(null, '4-2'), []);
});

test('Wi-Fi candidates: Realtek vendor-specific yes, camera and Bluetooth no', () => {
  assert.equal(isWifiCandidate(realtek), true);
  assert.equal(isWifiCandidate(camera), false);
  assert.equal(isWifiCandidate(bluetooth), false);
});

test('failed driver probe: names the driver, the first error and a firmware mismatch', () => {
  const d = diagnose(base);
  assert.equal(d.verdict.level, 'fail');
  assert.match(d.verdict.text, /^1 Wi-Fi card visible/);
  const f = d.findings[0];
  assert.equal(f.level, 'fail');
  assert.equal(f.action, 'replug');
  assert.match(f.detail, /rtw89_8852bu .*error -12.*"failed to recognize firmware elements".*don't match/);
  assert.match(f.fix, /pacman -Syu/);
  assert.deepEqual(d.adapters, ['4-2']);
});

test('adapter working as a Wi-Fi card: two cards, all ok', () => {
  const d = diagnose({ ...base,
    usb: [{ ...realtek, interfaces: [{ ...realtek.interfaces[0], driver: 'rtw89_8852bu' }] }],
    wifi: [builtIn, { device: 'wlp0s20f0u2', driver: 'rtw89_8852bu', usbPort: '4-2', ap: true }],
    nm: [{ device: 'wlp0s20f3', state: 'connected' }, { device: 'wlp0s20f0u2', state: 'disconnected' }] });
  assert.equal(d.verdict.level, 'ok');
  assert.deepEqual(d.findings.map((f) => f.level), ['ok']);
});

test('CDROM mode, nothing plugged in, rfkill and unmanaged cards', () => {
  const cd = { port: '3-1', vendor: '0bda', product: '1a2b', name: 'Realtek DISK', speed: 480, interfaces: [{ name: '3-1:1.0', cls: '08', driver: 'usb-storage' }] };
  assert.equal(diagnose({ ...base, usb: [cd] }).findings[0].action, 'modeswitch');

  const none = diagnose({ ...base, usb: [camera] });
  assert.equal(none.findings[0].title, 'No USB Wi-Fi adapter on the USB bus');

  const off = diagnose({ ...base, usb: [], rfkill: [{ type: 'wlan', name: 'phy0', soft: true, hard: false }],
    nm: [{ device: 'wlp0s20f3', state: 'unmanaged' }] });
  assert.ok(off.findings.some((f) => f.fix === 'Run: rfkill unblock wifi'));
  assert.ok(off.findings.some((f) => f.fix === 'Run: nmcli dev set wlp0s20f3 managed yes'));
});
