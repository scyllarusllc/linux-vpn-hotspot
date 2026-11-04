// The extender flow as an ordered list of steps. Each step inspects the live
// system and returns the commands (if any) needed to reach its goal state.
// `flow` prints the plan; `start` executes it.

import {
  HOTSPOT_CON,
  defaultRouteDev,
  fmt,
  hasCommand,
  hotspotActive,
  hotspotAddress,
  isUsb,
  link,
  sh,
  stations,
  supportsAp,
  wifiDevices,
} from './system.js';
import { loadState } from './state.js';

const steps = [
  {
    title: 'Detect WiFi cards',
    why: 'An extender needs two radios: one joins the router, the other broadcasts.',
    async check(ctx) {
      ctx.devices = await wifiDevices();
      for (const d of ctx.devices) d.usb = await isUsb(d.device);
      const list = ctx.devices.map((d) => `${d.device}${d.usb ? ' (USB)' : ''}`).join(', ');
      if (ctx.devices.length < 2) return { ok: false, fatal: true, detail: `only found: ${list || 'none'}` };
      return { ok: true, detail: list };
    },
  },
  {
    title: 'Assign roles (uplink / hotspot)',
    why: 'Uplink = the card with the best signal to the router. Hotspot = the other card, must support AP mode.',
    async check(ctx) {
      const { opts, devices } = ctx;
      const names = devices.map((d) => d.device);
      // A saved choice (from "swap") wins over the default of using the USB card for the uplink.
      const saved = (await loadState()).uplink;
      ctx.uplink =
        opts.uplink ?? (names.includes(saved) ? saved : null) ??
        devices.find((d) => d.usb)?.device ?? (await defaultRouteDev()) ?? names[0];
      ctx.ap = opts.ap ?? names.find((n) => n !== ctx.uplink);
      for (const dev of [ctx.uplink, ctx.ap]) {
        if (!names.includes(dev)) return { ok: false, fatal: true, detail: `${dev} is not a WiFi device` };
      }
      if (ctx.uplink === ctx.ap) return { ok: false, fatal: true, detail: 'uplink and hotspot must differ' };
      if (!(await supportsAp(ctx.ap))) {
        return { ok: false, fatal: true, detail: `${ctx.ap} does not support AP mode` };
      }
      return { ok: true, detail: `uplink=${ctx.uplink}  hotspot=${ctx.ap} (AP mode supported)` };
    },
  },
  {
    title: 'Check dnsmasq',
    why: 'NetworkManager "shared" mode uses dnsmasq to hand out addresses to clients.',
    async check() {
      if (await hasCommand('dnsmasq')) return { ok: true, detail: 'installed' };
      // soft: a dry run can still show the remaining steps.
      return { ok: false, fatal: true, soft: true, detail: 'missing; install with: sudo pacman -S dnsmasq' };
    },
  },
  {
    title: 'Connect uplink to the router',
    why: 'All hotspot traffic is NATed out through this connection.',
    async check(ctx) {
      const up = ctx.devices.find((d) => d.device === ctx.uplink);
      const l = await link(ctx.uplink);
      if (l && up.connection !== HOTSPOT_CON) {
        return { ok: true, detail: `${l.ssid}, ${l.signal} dBm, ${l.freq} MHz` };
      }
      const con =
        ctx.opts.uplinkCon ??
        ctx.devices.find((d) => d.connection && d.connection !== HOTSPOT_CON)?.connection;
      if (!con) return { ok: false, fatal: true, detail: 'no router connection found; pass --uplink-con' };
      return {
        ok: false,
        detail: `move "${con}" to ${ctx.uplink}`,
        cmds: [['nmcli', ['con', 'up', con, 'ifname', ctx.uplink]]],
      };
    },
  },
  {
    title: 'Free the hotspot card',
    why: 'A card cannot be a client and an AP at the same time here, so drop any client connection.',
    async check(ctx) {
      const ap = ctx.devices.find((d) => d.device === ctx.ap);
      if (!ap.connection || ap.connection === HOTSPOT_CON) return { ok: true, detail: 'free' };
      // If the router connection is being moved off this card, `con up` already frees it.
      if (ctx.pendingUplinkMove) return { ok: true, detail: `freed by moving "${ap.connection}"` };
      return {
        ok: false,
        detail: `disconnect "${ap.connection}"`,
        cmds: [['nmcli', ['dev', 'disconnect', ctx.ap]]],
      };
    },
  },
  {
    title: 'Start the hotspot',
    why: 'Creates an AP connection in "shared" mode: NAT + DHCP from the hotspot card to the uplink.',
    async check(ctx) {
      const { ssid, password, band, gateway } = ctx.opts;
      const address = `${gateway}/24`;
      // NetworkManager picks 10.42.0.1 by default; pin our gateway and restart to apply it.
      const setGateway = [
        ['nmcli', ['con', 'modify', HOTSPOT_CON, 'ipv4.addresses', address]],
        ['nmcli', ['con', 'up', HOTSPOT_CON]],
      ];
      if (await hotspotActive()) {
        const current = await hotspotAddress();
        if (current === address) return { ok: true, detail: `"${HOTSPOT_CON}" running, gateway ${gateway}` };
        return { ok: false, detail: `change gateway ${current || '10.42.0.1/24'} -> ${address}`, cmds: setGateway };
      }
      return {
        ok: false,
        detail: `SSID "${ssid}", band ${band === 'bg' ? '2.4 GHz' : '5 GHz'}, gateway ${gateway}`,
        cmds: [
          ['nmcli', ['con', 'delete', HOTSPOT_CON], { ignoreError: true }],
          ['nmcli', ['dev', 'wifi', 'hotspot', 'ifname', ctx.ap, 'con-name', HOTSPOT_CON,
            'ssid', ssid, 'band', band, 'password', password], { secret: password }],
          ...setGateway,
        ],
      };
    },
  },
  {
    title: 'Verify',
    why: 'Internet must leave through the uplink, and clients should appear on the hotspot.',
    async check(ctx) {
      const route = await defaultRouteDev();
      const clients = (await stations(ctx.ap)).length;
      const ok = route === ctx.uplink && (await hotspotActive());
      return {
        ok,
        detail: `default route via ${route ?? 'none'}, gateway ${(await hotspotAddress()) || 'default'}, ${clients} client(s)`,
      };
    },
  },
];

const showCmd = (cmd, args, meta = {}) =>
  fmt(cmd, meta.secret ? args.map((a) => (a === meta.secret ? '********' : a)) : args);

// Runs every step and reports each one through onStep as
// { n, title, why, status: 'ok' | 'todo' | 'fail' | 'pending', detail, cmds, error }.
// apply=false only inspects; apply=true also runs the commands.
// Resolves to { ok, blocked } where blocked means a dry run found a ✗ step.
export async function runFlow(opts, { apply, onStep = () => {} }) {
  const ctx = { opts };

  for (const [i, step] of steps.entries()) {
    const base = { n: i + 1, title: step.title, why: step.why, cmds: [] };

    // Without applying, later steps would report state the earlier steps would change.
    if (!apply && step.title === 'Verify') {
      onStep({ ...base, status: 'pending', detail: 'runs after start' });
      continue;
    }

    const res = await step.check(ctx);
    const event = {
      ...base,
      status: res.ok ? 'ok' : res.fatal ? 'fail' : 'todo',
      detail: res.detail,
      cmds: (res.cmds ?? []).map(([cmd, args, meta]) => showCmd(cmd, args, meta)),
    };

    if (res.fatal && (apply || !res.soft)) {
      onStep(event);
      return { ok: false, blocked: true };
    }
    if (res.fatal) ctx.blocked = true;
    if (step.title === 'Connect uplink to the router' && res.cmds) ctx.pendingUplinkMove = true;

    if (apply) {
      for (const [cmd, args, meta] of res.cmds ?? []) {
        try {
          await sh(cmd, args);
        } catch (err) {
          if (meta?.ignoreError) continue;
          onStep({ ...event, status: 'fail', error: err.stderr?.trim() || err.message });
          return { ok: false, blocked: false };
        }
      }
    }
    onStep(event);
  }

  return { ok: !ctx.blocked, blocked: Boolean(ctx.blocked) };
}
