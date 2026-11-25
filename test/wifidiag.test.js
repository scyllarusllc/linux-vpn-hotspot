import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockSize, diagnose, isWifiCandidate, kernelLinesFor, maxFreeOrder, parseUpdates } from '../src/wifidiag.js';

// A Realtek RTL8852BU whose driver probe failed, after an earlier attempt on the same port.
const KERNEL = `usb 4-2: new SuperSpeed USB device number 1 using xhci_hcd
rtw89_8852bu 4-2:1.0: failed to allocate hw
usb 4-2: USB disconnect, device number 1
usb 4-2: new SuperSpeed USB device number 2 using xhci_hcd
usb 4-2: New USB device found, idVendor=0bda, idProduct=b832, bcdDevice= 0.00
usb 4-20: unrelated device
rtw89_8852bu 4-2:1.0: loaded firmware rtw89/rtw8852b_fw-2.bin
kworker/6:1: page allocation failure: order:8, mode:0x40dc0(GFP_KERNEL|__GFP_ZERO|__GFP_COMP), nodemask=(null)
rtw89_8852bu 4-2:1.0: failed to recognize firmware elements
rtw89_8852bu 4-2:1.0: failed to setup chip information
rtw89_8852bu 4-2:1.0: probe with driver rtw89_8852bu failed with error -12
kworker/1:0: page allocation failure: order:4, later and unrelated
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
    'kworker/6:1: page allocation failure: order:8, mode:0x40dc0(GFP_KERNEL|__GFP_ZERO|__GFP_COMP), nodemask=(null)',
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

test('failed probe with error -12: out of memory (fragmentation), not a firmware mismatch', () => {
  const d = diagnose({ ...base, memory: { maxOrder: 5, uptime: 6 * 86400 } });
  assert.equal(d.verdict.level, 'fail');
  assert.match(d.verdict.text, /^1 Wi-Fi card visible/);
  const f = d.findings[0];
  assert.equal(f.level, 'fail');
  assert.equal(f.action, 'compact');
  assert.match(f.detail, /rtw89_8852bu .*error -12, out of memory.*unbroken 1 MiB block.*6 days.*not a firmware/);
  assert.match(f.detail, /biggest free block is 128 KiB/);
  assert.match(f.fix, /Free memory and replug/);
  assert.match(diagnose({ ...base, memory: { maxOrder: 9 } }).findings[0].detail, /1 MiB block is free/);
  assert.deepEqual(d.adapters, ['4-2']);
  assert.equal(d.usb.find((u) => u.port === '4-2').failedDriver, 'rtw89_8852bu');
  assert.equal(d.usb.find((u) => u.port === '3-5').failedDriver, null);
});

test('failed probe with another error: names the first error and a firmware mismatch', () => {
  const kernel = KERNEL.replace(/^kworker\/6.*\n/m, '').replace('error -12', 'error -22');
  const f = diagnose({ ...base, kernel }).findings[0];
  assert.equal(f.action, 'replug');
  assert.match(f.detail, /error -22.*"failed to recognize firmware elements".*don't match/);
  assert.match(f.fix, /pacman -Syu/);
});

test('buddyinfo: biggest free block, DMA zone ignored', () => {
  const info = `Node 0, zone      DMA      0      0      0      0      0      0      0      0      0      1      3
Node 0, zone    DMA32  12108   8967   4506   2499    327     12      0      0      0      0      0
Node 0, zone   Normal  20332  29612  13442   2679    266      3      0      0      0      0      0`;
  assert.equal(maxFreeOrder(info), 5);
  assert.equal(maxFreeOrder(null), null);
  assert.equal(blockSize(8), '1 MiB');
  assert.equal(blockSize(5), '128 KiB');
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

test('updates: only the running kernel and firmware packages', () => {
  const out = 'firefox 140.0-1 -> 141.0-1\nlinux-omarchy 7.2.8-9 -> 7.2.15-1\nlinux-firmware-realtek 20260916-1 -> 20261012-1\nlinux-lts 6.18.57-2 -> 6.18.60-1\n';
  const wanted = (n) => n === 'linux-omarchy' || n.startsWith('linux-firmware');
  assert.deepEqual(parseUpdates(out, wanted), [
    { name: 'linux-omarchy', from: '7.2.8-9', to: '7.2.15-1' },
    { name: 'linux-firmware-realtek', from: '20260916-1', to: '20261012-1' },
  ]);
  assert.deepEqual(parseUpdates('', wanted), []);
});
