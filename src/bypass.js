// Domains that skip the proxy. Hotspot clients get their real IP for these names (not a fake one) and
// their traffic leaves the laptop directly. Needed for Wi-Fi calling: the phone talks UDP 500/4500
// (IPsec) to the carrier's gateway, e.g. epdg.epc.mnc260.mcc310.pub.3gppnetwork.org, which cannot
// go through a TCP proxy and cannot work against a fake IP.

import { loadState, updateState } from './state.js';

export const DEFAULT_BYPASS = ['3gppnetwork.org'];
export const MAX_BYPASS = 200;

// One name per line (commas and spaces work too). "*.example.com" and ".example.com" mean example.com;
// every subdomain is covered either way. Throws on anything that isn't a domain name.
export function parseBypass(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/[\s,;]+/)) {
    const d = raw.trim().toLowerCase().replace(/^\*?\./, '').replace(/\.$/, '');
    if (!d || d.startsWith('#')) continue;
    // The last label (org, com…) must have a letter: that also keeps IP addresses out.
    if (!/^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(d) || !/[a-z]/.test(d.split('.').pop())) {
      throw Object.assign(new Error(`"${raw}" is not a domain name. Use names like example.com (one per line).`), { status: 400 });
    }
    if (!out.includes(d)) out.push(d);
  }
  if (out.length > MAX_BYPASS) throw Object.assign(new Error(`At most ${MAX_BYPASS} domains.`), { status: 400 });
  return out;
}

// Never saved yet: the defaults. Saved as an empty list: really none.
export async function getBypass() {
  const { bypass } = await loadState();
  return Array.isArray(bypass) ? bypass : DEFAULT_BYPASS;
}

export async function setBypass(list) {
  await updateState({ bypass: list });
}
