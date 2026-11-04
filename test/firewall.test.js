import assert from 'node:assert/strict';
import { test } from 'node:test';
import { missingRules } from '../src/firewall.js';

const rules = `
-A ufw-user-input -i old0 -p udp --dport 67 -j ACCEPT
-A ufw-user-input -i new0 -p tcp --dport 12345 -j ACCEPT
-A ufw-user-input -i new0 -p udp --dport 12353 -j ACCEPT
`;

test('a renamed hotspot card is missing DHCP, DNS, web and forwarding', () => {
  const missing = missingRules(rules, { ap: 'new0', uplink: 'up0', webPort: 4321, proxy: true });
  assert.deepEqual(missing, ['DHCP (phones get an IP address)', 'DNS', 'this page (port 4321)', 'internet: forward to up0']);
});

test('nothing is missing once ufwScript rules are in', () => {
  const full = `${rules}
-A ufw-user-input -i new0 -p udp --dport 67 -j ACCEPT
-A ufw-user-input -i new0 -p udp --dport 53 -j ACCEPT
-A ufw-user-input -i new0 -p tcp --dport 4321 -j ACCEPT
-A ufw-user-forward -i new0 -o up0 -j ACCEPT`;
  assert.deepEqual(missingRules(full, { ap: 'new0', uplink: 'up0', webPort: 4321, proxy: true }), []);
});

test('proxy ports only count when the proxy is on', () => {
  const missing = missingRules('', { ap: 'x', uplink: 'y', webPort: 1, proxy: false });
  assert.ok(!missing.some((m) => m.startsWith('proxy')));
});
