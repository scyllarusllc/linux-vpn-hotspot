// Checks that ufw lets hotspot clients in on the card the hotspot runs on now.
// ufw rules are per interface name, so a USB card that comes back under a new
// name (another port, a replug) has none: phones join but get no IP address.
// Reading /etc/ufw/user.rules needs no root; fixing does (see POST /api/firewall/fix).

import { readFile } from 'node:fs/promises';
import { DNS_PORT, REDIRECT_PORT } from './proxy.js';

const UFW_CONF = '/etc/ufw/ufw.conf';
const USER_RULES = '/etc/ufw/user.rules';

// What the hotspot needs, as the iptables lines ufw writes for ufwScript's rules.
export function requiredRules({ ap, uplink, webPort, proxy }) {
  const input = (proto, port) => `-A ufw-user-input -i ${ap} -p ${proto} --dport ${port} -j ACCEPT`;
  const rules = [
    { what: 'DHCP (phones get an IP address)', line: input('udp', 67) },
    { what: 'DNS', line: input('udp', 53) },
    { what: `this page (port ${webPort})`, line: input('tcp', webPort) },
    { what: `internet: forward to ${uplink ?? 'the uplink'}`, line: uplink ? `-A ufw-user-forward -i ${ap} -o ${uplink} -j ACCEPT` : null },
  ];
  if (proxy) {
    rules.push(
      { what: `proxy (port ${REDIRECT_PORT})`, line: input('tcp', REDIRECT_PORT) },
      { what: `proxy DNS (port ${DNS_PORT})`, line: input('udp', DNS_PORT) },
    );
  }
  return rules.filter((r) => r.line);
}

// rulesText: contents of user.rules. Returns the rules that are not there.
export function missingRules(rulesText, opts) {
  const have = new Set(rulesText.split('\n').map((l) => l.trim()));
  return requiredRules(opts).filter((r) => !have.has(r.line)).map((r) => r.what);
}

// { ufw: false } when ufw is off or not installed (nothing to fix), else the missing rules.
export async function firewallCheck(opts) {
  const conf = await readFile(UFW_CONF, 'utf8').catch(() => '');
  if (!/^ENABLED=yes/m.test(conf)) return { ufw: false, missing: [] };
  const rules = await readFile(USER_RULES, 'utf8').catch(() => null);
  // Unreadable (some distros make it root-only): can't tell, so don't nag.
  if (rules == null) return { ufw: true, unknown: true, missing: [] };
  return { ufw: true, missing: missingRules(rules, opts) };
}
