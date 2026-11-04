// Swap roles: the uplink card becomes the hotspot and vice versa, keeping the
// hotspot's SSID, password, band and gateway so clients reconnect on their own.
// Firewall rules are per interface, so the new hotspot card gets them first.

import { pickUplink, runFlow } from './flow.js';
import { DNS_PORT, REDIRECT_PORT, applyCurrentRules } from './proxy.js';
import { updateState } from './state.js';
import { HOTSPOT_CON, defaultRouteDev, getStatus, hotspotActive, hotspotSettings, isUsb, sh, supportsAp, wifiDevices } from './system.js';

// The ufw rules the hotspot needs on a given card (idempotent; ufw skips existing ones).
export function ufwScript(ap, uplink, webPort) {
  const on = JSON.stringify(ap);
  return [
    `ufw allow in on ${on} to any port 67 proto udp comment 'hotspot dhcp'`,
    `ufw allow in on ${on} to any port 53 comment 'hotspot dns'`,
    `ufw allow in on ${on} to any port ${webPort} proto tcp comment 'wifi-extender web'`,
    `ufw allow in on ${on} to any port ${REDIRECT_PORT} proto tcp comment 'wifi-extender proxy'`,
    `ufw allow in on ${on} to any port ${DNS_PORT} comment 'wifi-extender proxy dns'`,
    `ufw route allow in on ${on} out on ${JSON.stringify(uplink)} comment 'hotspot to uplink'`,
  ].map((l) => `${l} >/dev/null\n`).join('');
}

// onStep receives the same step events as runFlow, plus the swap's own steps.
export async function swapCards({ webPort, onStep = () => {} }) {
  const { cards } = await getStatus();
  const ap = cards.find((c) => c.role === 'hotspot');
  const uplink = cards.find((c) => c !== ap && c.role === 'client');
  if (!ap) throw new Error('Hotspot is not running, nothing to swap.');
  if (!uplink) throw new Error('The other card is not connected to a router, nothing to swap.');
  if (!(await supportsAp(uplink.device))) throw new Error(`${uplink.device} does not support AP mode.`);

  const settings = await hotspotSettings();
  const next = { ap: uplink.device, uplink: ap.device, routerCon: uplink.connection };
  const say = (title, detail) => onStep({ n: '·', title, why: '', status: 'ok', detail, cmds: [] });

  // Root first: if the password dialog is cancelled, nothing has changed yet.
  await applyCurrentRules({ hotspotIf: next.ap, gateway: settings.gateway, webPort },
    ufwScript(next.ap, next.uplink, webPort));
  say('Firewall', `rules for hotspot on ${next.ap}`);

  await sh('nmcli', ['con', 'delete', HOTSPOT_CON]);
  say('Stop hotspot', `on ${ap.device}`);

  await updateState({ uplink: next.uplink });
  const res = await runFlow(
    { ...settings, uplink: next.uplink, ap: next.ap, uplinkCon: next.routerCon },
    { apply: true, onStep },
  );
  return { ...res, ...next };
}

// Hotspot is off: swap which card is the uplink and which will be the hotspot. Only saved;
// the next Start applies it (and moves the router connection to the new uplink).
export async function switchRoles() {
  if (await hotspotActive()) throw Object.assign(new Error('The hotspot is running: use "Swap cards" in the Network section.'), { status: 409 });
  const devices = await wifiDevices();
  if (devices.length < 2) throw Object.assign(new Error('Only one Wi-Fi card found, nothing to switch.'), { status: 409 });
  for (const d of devices) d.usb = await isUsb(d.device);
  const uplink = await pickUplink(devices, undefined, await defaultRouteDev());
  const ap = devices.find((d) => d.device !== uplink)?.device;
  if (!(await supportsAp(uplink))) throw Object.assign(new Error(`${uplink} does not support AP mode, so it cannot be the hotspot.`), { status: 409 });
  await updateState({ uplink: ap });
  return { uplink: ap, ap: uplink };
}
