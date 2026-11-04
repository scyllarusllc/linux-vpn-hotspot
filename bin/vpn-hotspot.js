#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { parseArgs } from 'node:util';
import { runFlow } from '../src/flow.js';
import { swapCards } from '../src/swap.js';
import {
  applyCurrentRules, loadProxy, proxyOff, proxyOn, proxyStatus, restartEngine, saveProxy, testProxy,
} from '../src/proxy.js';
import { HOTSPOT_CON, getStatus, hotspotActive, hotspotNet, sh } from '../src/system.js';

const usage = `Usage: vpn-hotspot <command> [options]

Commands:
  flow     Walk through the extender flow and show what would change (dry run)
  start    Run the flow: connect uplink, start hotspot
  stop     Stop and remove the hotspot
  status   Show both cards and hotspot clients
  swap     Swap the cards: uplink becomes hotspot and vice versa (keeps SSID/password)
  port80   Let hotspot clients open http://<gateway> (re-run after a reboot)
  proxy    Route hotspot clients through an upstream proxy:
             proxy set <url>   http://, https:// or socks5://[user:pass@]host:port
             proxy set <file>  a WireGuard .conf from your VPN provider
             proxy test        check the proxy works and show the exit IP
             proxy on | off    start / stop routing clients through it
             proxy status

Options:
  --uplink <dev>       Card that joins the router (default: the USB card)
  --ap <dev>           Card that broadcasts the hotspot (default: the other card)
  --uplink-con <name>  Saved NetworkManager connection for the router
  --ssid <name>        Hotspot name (default: Omarchy-Hotspot)
  --password <pw>      Hotspot password, 8+ chars (default: random)
  --band <bg|a>        bg = 2.4 GHz (default), a = 5 GHz
  --gateway <ip>       Hotspot gateway, clients get <ip>/24 (default: 10.0.0.1)`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    uplink: { type: 'string' },
    ap: { type: 'string' },
    'uplink-con': { type: 'string' },
    ssid: { type: 'string', default: 'Omarchy-Hotspot' },
    password: { type: 'string' },
    band: { type: 'string', default: 'bg' },
    gateway: { type: 'string', default: '10.0.0.1' },
    help: { type: 'boolean', short: 'h' },
    'web-port': { type: 'string', default: process.env.PORT || '4321' },
  },
});

const command = positionals[0];
if (values.help || !command) {
  console.log(usage);
  process.exit(command || values.help ? 0 : 1);
}

if (values.password && values.password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}
if (!['bg', 'a'].includes(values.band)) {
  console.error('--band must be "bg" or "a".');
  process.exit(1);
}

if (!isIPv4(values.gateway)) {
  console.error('--gateway must be an IPv4 address, e.g. 10.0.0.1.');
  process.exit(1);
}

const opts = {
  uplink: values.uplink,
  ap: values.ap,
  uplinkCon: values['uplink-con'],
  ssid: values.ssid,
  band: values.band,
  gateway: values.gateway,
  password: values.password ?? randomBytes(9).toString('base64url'),
  generatedPassword: !values.password,
};

const color = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = color(32);
const yellow = color(33);
const red = color(31);
const dim = color(2);
const marks = { ok: green('✓'), todo: yellow('→'), fail: red('✗'), pending: dim('…') };

function printStep(e) {
  console.log(`${e.n}. ${e.title}  ${marks[e.status]} ${e.detail}`);
  console.log(`   ${dim(e.why)}`);
  for (const c of e.cmds) console.log(`     ${dim('$')} ${c}`);
  if (e.error) console.log(`   ${red('Failed:')} ${e.error}`);
  console.log();
}

async function flow(apply) {
  console.log(apply ? 'Starting the VPN hotspot\n' : 'VPN hotspot flow (dry run, nothing is changed)\n');
  const res = await runFlow(opts, { apply, onStep: printStep });
  if (!res.ok) {
    console.log(`${red(res.blocked ? 'Blocked:' : 'Stopped:')} fix the ${red('✗')} step above and run again.`);
  } else if (apply) {
    console.log(green(`Hotspot "${opts.ssid}" is up.`));
    if (opts.generatedPassword) console.log(`Password: ${opts.password}`);
  } else {
    console.log(`Run ${green('vpn-hotspot start')} to apply.`);
  }
  return res.ok;
}

async function status() {
  for (const c of (await getStatus()).cards) {
    console.log(`${c.device}${c.usb ? ' (USB)' : ''}  [${c.role}]  ${c.state}`);
    if (c.link) console.log(`  ${c.link.ssid}, ${c.link.signal} dBm, rx ${c.link.rxBitrate}, tx ${c.link.txBitrate}`);
    if (c.info) {
      const r = c.info.dhcpRange;
      console.log(`  SSID ${c.info.ssid}, ${c.info.band}, gateway ${c.info.address}${r ? `, DHCP ${r.start} - ${r.end}` : ''}`);
    }
    for (const cl of c.clients) {
      console.log(`  ${cl.hostname ?? '?'}  ${cl.ip ?? '?'}  ${cl.mac}  ${cl.signal} dBm  ${cl.connectedSeconds}s`);
    }
  }
}

async function stop() {
  if (!(await hotspotActive())) {
    console.log('Hotspot is not running.');
    return;
  }
  await sh('nmcli', ['con', 'delete', HOTSPOT_CON]);
  console.log('Hotspot stopped.');
}

async function proxy() {
  const [, sub, arg] = positionals;
  const net = () => hotspotNet(Number(values['web-port']));
  switch (sub) {
    case 'set': {
      if (!arg) throw new Error('Usage: vpn-hotspot proxy set <url | wireguard.conf>');
      // A URL, or a file (a WireGuard .conf) to read.
      const text = /^[a-z0-9]+:\/\//i.test(arg) ? arg : await readFile(arg, 'utf8');
      const p = await saveProxy(text);
      const what = p.type === 'wireguard' ? 'WireGuard VPN' : `${p.type} proxy`;
      console.log(`Saved ${what} ${p.host}:${p.port}${(await restartEngine()) ? ', applied to the running proxy' : ''}.`);
      console.log('Run "vpn-hotspot proxy test" to check it.');
      return;
    }
    case 'test': {
      const p = await loadProxy();
      if (!p) throw new Error('No proxy configured. Run: vpn-hotspot proxy set <url>');
      const r = await testProxy(p);
      console.log(r.ok ? green(`OK: exit IP ${r.ip} (${r.ms} ms)`) : red(`Failed: ${r.error}`));
      return r.ok;
    }
    case 'on':
      await proxyOn(await net());
      console.log(green('Proxy on: hotspot clients now go through it.'));
      return;
    case 'off':
      await proxyOff(await net());
      console.log('Proxy off: hotspot clients go direct.');
      return;
    case 'status':
    case undefined: {
      const s = await proxyStatus();
      console.log(`proxy:   ${s.configured ?? 'not configured'}`);
      console.log(`routing: ${s.enabled ? 'on' : 'off'}  (sing-box ${s.engine ? 'running' : 'stopped'})`);
      return;
    }
    default:
      throw new Error(`Unknown proxy command: ${sub}`);
  }
}

async function swap() {
  console.log('Swapping cards (clients reconnect in about 20 seconds)\n');
  const res = await swapCards({ webPort: Number(values['web-port']), onStep: printStep });
  if (!res.ok) {
    console.log(red('Swap stopped at the ✗ step above.'));
    return false;
  }
  console.log(green(`Done: uplink ${res.uplink}, hotspot ${res.ap}.`));
  return true;
}

async function port80() {
  const n = await hotspotNet(Number(values['web-port']));
  await applyCurrentRules(n);
  console.log(`http://${n.gateway} on ${n.hotspotIf} now goes to port ${n.webPort}.`);
}

const commands = {
  flow: () => flow(false),
  start: () => flow(true),
  stop,
  status,
  port80,
  proxy,
  swap,
};

if (!commands[command]) {
  console.error(`Unknown command: ${command}\n\n${usage}`);
  process.exit(1);
}

try {
  const ok = await commands[command]();
  if (ok === false) process.exitCode = 1;
} catch (err) {
  console.error(err.stderr?.trim() || err.message);
  process.exitCode = 1;
}
