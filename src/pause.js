// "Pause internet" for one hotspot client, like a parental-control switch.
// Pauses live in state.json ({ paused: { mac: { ip, until } } }) and every nft
// rebuild re-adds the ones still running (see nftRuleset), so a swap or proxy
// toggle doesn't lift them. nft drops the IP when its timeout runs out.

import { applyCurrentRules } from './proxy.js';
import { loadState, updateState } from './state.js';
import { hotspotNet } from './system.js';

export const MAX_PAUSE_MIN = 24 * 60;

// { mac: { ip, until } } for pauses that haven't expired.
export async function activePauses() {
  const now = Date.now();
  return Object.fromEntries(Object.entries((await loadState()).paused ?? {}).filter(([, p]) => p.until > now));
}

// minutes = 0 resumes the device. Needs root (password dialog) to apply.
export async function setPause({ mac, ip, minutes, webPort }) {
  const paused = await activePauses();
  if (minutes > 0) {
    if (!ip) throw new Error('This device has no IP address yet.');
    paused[mac] = { ip, until: Date.now() + Math.min(minutes, MAX_PAUSE_MIN) * 60_000 };
  } else {
    delete paused[mac];
  }
  await updateState({ paused });
  await applyCurrentRules(await hotspotNet(webPort));
  return paused[mac] ?? null;
}
