import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modeSwitchScript, parseModeSwitchCandidates } from '../src/usbmode.js';

const LSUSB = `Bus 003 Device 005: ID 8087:0026 Intel Corp. AX201 Bluetooth
Bus 003 Device 008: ID 0bda:1a2b Realtek Semiconductor Corp. RTL8188GU 802.11n WLAN Adapter (Driver CDROM Mode)
Bus 004 Device 001: ID 1d6b:0003 Linux Foundation 3.0 root hub`;

test('finds only adapters that still show up as a CDROM', () => {
  assert.deepEqual(parseModeSwitchCandidates(LSUSB).map((c) => `${c.vendor}:${c.product}`), ['0bda:1a2b']);
  assert.deepEqual(parseModeSwitchCandidates('Bus 003 Device 003: ID 5986:212a Integrated Camera'), []);
});

test('script installs usb_modeswitch, switches each adapter, then waits', () => {
  const s = modeSwitchScript(parseModeSwitchCandidates(LSUSB));
  assert.equal(s, [
    'pacman -S --needed --noconfirm usb_modeswitch',
    'usb_modeswitch -KW -v 0bda -p 1a2b',
    'sleep 3',
  ].join('\n'));
});
