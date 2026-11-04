import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ufwScript } from '../src/swap.js';

test('ufwScript opens the hotspot ports on the new card and routes to the new uplink', () => {
  const s = ufwScript('wlp0s20f0u2', 'wlp0s20f3', 4321);
  assert.ok(s.includes(`ufw allow in on "wlp0s20f0u2" to any port 67 proto udp`));
  assert.ok(s.includes(`ufw allow in on "wlp0s20f0u2" to any port 53 `));
  assert.ok(s.includes(`ufw allow in on "wlp0s20f0u2" to any port 4321 proto tcp`));
  assert.ok(s.includes(`ufw route allow in on "wlp0s20f0u2" out on "wlp0s20f3"`));
  assert.ok(!s.includes('"wlp0s20f3" to any port'), 'uplink card gets no inbound rules');
});
