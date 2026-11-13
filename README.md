# Linux VPN Hotspot: share a WireGuard VPN or proxy with your phone, no VPN app needed

**linux-vpn-hotspot** turns a Linux laptop with two Wi-Fi cards into a **VPN hotspot**: one card
joins your router, the other broadcasts its own Wi-Fi, and every phone, tablet or TV that joins is
sent through your **WireGuard VPN** (paste the `.conf` from Mullvad, Proton VPN, Surfshark, IVPN,
Windscribe, your own server…) or your **SOCKS5 / HTTP / HTTPS proxy**, automatically.
**Nothing is installed or configured on the phone**: no VPN app, no VPN profile, no VPN icon.
To the phone it is just an ordinary Wi-Fi network.

It doubles as a **WiFi extender / WiFi repeater** (two radios, so no half-speed repeating) and
comes with a live web dashboard: a network map of every connected device, per-device data usage
and signal history, a connection log, ping times, nearby-network interference and a one-tap
"pause internet" per device.

Works with NetworkManager (`nmcli`), `iw` and `ip`. Built and tested on Arch Linux
([Omarchy](https://omarchy.org)); no hostapd needed.

```
  Your router (e.g. "MyRouter", 5 GHz)
     │
     ▼
┌──────────────────────────────── laptop ────────────────────────────────┐
│  wlan USB card            uplink: joins the router as a normal client  │
│        │                                                               │
│        ▼    NetworkManager "shared" mode: NAT + DHCP (dnsmasq)         │
│        │    sing-box sends client traffic into your VPN / proxy        │
│        │                                                               │
│  built-in card            hotspot: access point, 10.0.0.1/24           │
└────────────────────────────────────────────────────────────────────────┘
     │
     ▼
  Phones / tablets / TVs (10.0.0.x): normal Wi-Fi, no app, no VPN profile
     ⇢ the internet sees your WireGuard VPN / proxy exit, not your connection
```

## Why use it

### A VPN / proxy for your phone that the phone doesn't see

A VPN app on a phone is visible: Android and iOS show a VPN icon (🔑 / "VPN"), keep a
VPN profile in Settings, and expose a "VPN is active" flag to every app (Android's
`TRANSPORT_VPN`, iOS's VPN status). Some banking, streaming and gaming apps check it
and refuse to work, nag, or switch to a different region.

With linux-vpn-hotspot the tunnel runs on the laptop, so the phone has:

- **no VPN app and no VPN profile** to install, sign in to or keep running
- **no VPN icon and no "VPN active" flag** for apps to read
- **no battery cost** for encryption on the phone
- **every app covered**, including apps that ignore the phone's own proxy setting

It also works for devices that can't run a VPN app at all: smart TVs, game consoles,
e-readers, IoT gadgets, a guest's phone.

Most VPN providers let you download a **WireGuard config file** for any server (look for
"WireGuard configuration", "manual setup" or "router" in your account). Load it in the dashboard
and you're done; SOCKS5 / HTTP proxies work too (see [VPN and proxy](#vpn-and-proxy-for-hotspot-clients)).
The dashboard shows the exit's city and flag, so you can check where traffic comes out.

**What it can't hide:** websites still see the proxy's IP address. If that address
belongs to a data centre or a known VPN provider, sites that look up IP reputation can
still flag it. Some UDP (voice/video calls, games) is not proxied and goes out directly;
see [the table below](#how-it-works). The phone's own settings (time zone, language,
SIM country) are untouched.

### Also a real WiFi repeater, not half speed

Single-radio repeaters receive and re-send on the same radio, halving throughput. Here
the two cards are separate radios: one talks to the router, the other to your devices.

### See what's on your network

A live map of every device (distance = signal, size = traffic, moving dots = data),
ping to the router, the internet and each device, retry rates that reveal interference,
nearby networks on your channel, connects and disconnects in a log, data used today,
and proxy rejections per device.

## Quick start

You need: a Linux laptop with **two Wi-Fi cards** (a cheap USB Wi-Fi adapter plus the
built-in card works; one of them must support AP mode, see `iw list`), NetworkManager,
Node.js 22.13 or newer.

```sh
git clone https://github.com/scyllarusllc/linux-vpn-hotspot.git
cd linux-vpn-hotspot
make dev          # installs missing packages (Arch: pacman), starts the dashboard, opens it
```

Then press the big **Start hotspot** button. To route phones through your VPN, open the
**VPN / proxy** panel, press **Load .conf** (or paste a proxy URL), **Save**, then **Enable**.

Command line instead of the dashboard: see [CLI](#cli).

## The flow

`vpn-hotspot flow` walks these steps against the live system and prints
what each one would do, without changing anything. `vpn-hotspot start` runs them.

| # | Step | What it checks / does |
|---|------|-----------------------|
| 1 | Detect WiFi cards | Need two radios, via `nmcli dev` |
| 2 | Assign roles | Uplink = USB card by default, hotspot = the other; hotspot card must list `AP` in `iw phy` |
| 3 | Check dnsmasq | NetworkManager needs it to hand out addresses to clients |
| 4 | Connect uplink | If the router connection is on the wrong card, `nmcli con up <con> ifname <uplink>` |
| 5 | Free hotspot card | `nmcli dev disconnect` if it is still a client somewhere |
| 6 | Start hotspot | `nmcli dev wifi hotspot ifname <ap> con-name wifi-extender-hotspot ...` |
| 7 | Verify | Default route goes out the uplink, clients show up in `iw dev <ap> station dump` |

## Dashboard (dev server)

```sh
make dev
```

Installs any missing system packages (`dnsmasq`, `iw`, ... via `sudo pacman`),
starts the server on http://127.0.0.1:4321 with auto-restart on file changes,
and opens it in your browser. The page shows the network diagram, the live
flow steps, connected clients, and Start/Stop controls. Use `PORT=5000 make dev`
to change the port.

Every page shares one header (page nav, current page highlighted) and footer:
`public/partials/{header,footer}.html`, inserted by the server at `<!--#header-->` /
`<!--#footer-->`, styled by `public/assets/layout.css` (full-width pages).

### Device trends and map

- http://127.0.0.1:4321/device: each client's IP, MAC, signal, link speed,
  Wi-Fi standard, retries and totals, plus download/upload, signal and link-speed
  charts over 5 min to 7 days.
- The homepage opens with a network map: all clients around the hotspot,
  distance = signal, size = current traffic, one color per device, and animated
  dots for data flowing (outward = download, inward = upload). `/map` redirects
  there. The map lives in `public/assets/map.{js,css}`.

History is sampled every 5 seconds into SQLite (Node's built-in `node:sqlite`,
no extra dependency) at `~/.local/share/wifi-extender/history.db`; set
`HISTORY_DB` to move it. Samples are kept for 30 days, and long ranges are
averaged down to about 720 points. Restarts show as gaps in the charts.

```sh
sqlite3 ~/.local/share/wifi-extender/history.db \
  "select hostname, ip, datetime(last_seen/1000,'unixepoch','localtime') from devices"
```

### Map details

Hover any node for details. Sampled in the background by `src/insights.js`:

| On the map | Where it comes from |
|------------|---------------------|
| Ping on each link (router, internet, proxy, each device), amber/red when slow | `ping` every 10 s; a request through the proxy every 30 s |
| Router: signal, channel, band, link speeds; amber/red ring when the signal is fair/weak | `iw dev <uplink> link` |
| Hotspot: channel, width, transmit power; a hint when 5 GHz runs at 20 MHz | `iw dev <ap> info` |
| Red badge: connections the proxy rejected from that device in the last hour | `proxy_errors` table |
| Amber dashed ring + "⚠ retries": over 20 % of frames resent (interference, walls) | station counters |
| WiFi 6 2×2 · time online · data today · private MAC | station dump + SQLite |
| Pulse when a known device rejoins (last 2 min) | `events` table |
| Device maker (Apple, Samsung, …) for devices without a name; private MACs have none | `/usr/share/hwdata/oui.txt` |
| "Air around ch N" panel: nearby networks on overlapping channels, and a clearly quieter channel if there is one | `nmcli dev wifi list` on the uplink card every 2 min |
| Sites each device is reaching (button **Sites**, off by default) | sing-box log, memory only, last 10 minutes, cleared when turned off |

### Homepage extras

| Feature | What it does |
|---------|--------------|
| Join QR | Scan to join the hotspot without typing the password; "Full screen" for showing it across a room |
| New device alerts | A toast, a pulsing node on the map and (if "Alert sound" is on) a chime when an unknown device joins. Known devices are remembered per browser |
| Pause internet | Per device, 15 min to 24 h, from the client table or `/device`. An nft set with timeouts drops the device's traffic except to the hotspot itself (so it can still open this page). Needs root (password dialog); pauses survive rule rebuilds and expire on their own |
| Leaderboard | Most data today / this week, from SQLite, with medals |
| Today card | Data used, peak speed, devices, longest online, proxy rejections |
| Names & icons | Rename a device and pick an icon on `/device`; shown everywhere |
| Signal hunt | `/hunt`: live signal once a second in big type, best spot so far, 60 s sparkline and optional Geiger-style beeps. Opened on a phone on the hotspot, it follows that phone |
| Saved settings | The hotspot form (SSID, password, gateway, band) is saved to SQLite (`meta` key `hotspot.settings`) on Start and prefilled on load. An empty password reuses the saved one, so phones keep working after a restart. On first run the running hotspot's settings are adopted |
| Firewall check | ufw rules are per interface name, so a USB card that comes back under a new name (another port, a replug) blocks DHCP and phones show "couldn't get IP address". The homepage pops up a modal listing the missing rules with a **Fix firewall** button (root, one password dialog) that adds them and re-points the nft rules at the card |
| Wi-Fi card check | `/wifi-check`, linked from the homepage when Start finds only one card: the USB adapter, the driver that took it (or failed to), what the kernel logged for its port, rfkill and NetworkManager state, with what to do. **Replug in software** (root) makes the driver try again; adapters in CDROM mode get the mode switch |
| Log | `/log`: timeline of devices connecting and disconnecting (with how long they stayed), hotspot start/stop, card swaps, proxy changes, pauses, renames and proxy rejections. Filter by type, device, range or text; remote admin actions note the client IP. Stored in the `events` table, kept 30 days |



Devices on the hotspot can open http://10.0.0.1 like a router admin page.
Let the port through the firewall once, then redirect port 80 to it:

```sh
sudo ufw allow in on wlp0s20f3 to any port 4321 proto tcp comment 'wifi-extender web'
make port80    # re-run after a reboot
```

`make port80` adds an nftables rule that sends port 80 traffic addressed to
10.0.0.1 on the hotspot card to the server's port (clients' normal web traffic
is untouched), so the server never needs root. The firewall sees
the redirected port (4321), so no extra ufw rule for 80 is needed.

| Who | Can see status | Can Start/Stop |
|-----|----------------|----------------|
| The laptop (127.0.0.1) | yes | yes |
| Hotspot clients (via 10.0.0.1) | yes | with the admin password |
| Anything else (router LAN, Docker, ...) | no, 403 | no |

The admin password is created on first start in
`~/.config/wifi-extender/admin-password` (mode 600). Set `ADMIN_PASSWORD=...`
to override it. POSTs must also come from the page itself (Origin check), and
the Host header must be the IP the request arrived on, which blocks DNS rebinding.

## VPN and proxy for hotspot clients

Route every hotspot client (phone, tablet, TV, console) through a **WireGuard VPN** or an
upstream **SOCKS5, HTTP or HTTPS proxy**, with no setup on the device: a transparent VPN / proxy
for the whole hotspot. Uses [sing-box](https://sing-box.sagernet.org) in redirect mode
(`make install` pulls it in); WireGuard runs in userspace inside sing-box, so no `wg-quick`,
no kernel module and the laptop's own traffic is not affected.

| Upstream | What to paste | Where names are resolved |
|----------|---------------|--------------------------|
| WireGuard VPN | the provider's `.conf` (`[Interface]` … `[Peer]`), or **Load .conf** | the `.conf`'s DNS server, reached **through the tunnel** (1.1.1.1 if none), so no DNS leaks |
| SOCKS5 | `socks5://user:pass@host:1080` | on the proxy (like `socks5h`) |
| HTTP / HTTPS | `http://host:8080`, `https://host:443` (`?insecure=1` to skip TLS checks) | on the proxy |

**Getting a WireGuard config:** in your VPN account look for "WireGuard configuration",
"manual setup" or "router setup", pick a server and download the `.conf`. Only the first
`[Peer]` is used, and everything goes through it (`AllowedIPs` is ignored). OpenVPN
`.ovpn` files are not supported.

```sh
node bin/vpn-hotspot.js proxy set ~/Downloads/mullvad-se-sto.conf    # a WireGuard .conf
node bin/vpn-hotspot.js proxy set 'socks5://user:pass@host:1080'     # or http://, https://
node bin/vpn-hotspot.js proxy test     # shows the exit IP
node bin/vpn-hotspot.js proxy on       # needs root (password dialog)
node bin/vpn-hotspot.js proxy off
```

Or use the **VPN / proxy** panel on the dashboard. Saving a new upstream while it is on
switches phones over right away (connections drop for about a second).

The engine also listens on `127.0.0.1:12346` (SOCKS5/HTTP, laptop only). The dashboard
uses it to test the upstream, find the exit location and measure latency the same way for
every upstream type; for a WireGuard upstream that isn't running yet, **Test** starts a
short-lived engine instead.

### How it works

| Piece | What it does |
|-------|--------------|
| DNS | Clients' DNS (port 53) is redirected to sing-box, which answers with fake IPs from 198.18.0.0/15 |
| TCP | Clients' TCP to public addresses is redirected to sing-box, which maps the fake IP back to the domain and dials it through the proxy, so poisoned DNS never matters |
| Direct | LAN / private addresses (10.0.0.1, 192.168.x.x, ...) skip the proxy |
| QUIC | UDP 443 is rejected so apps fall back to TCP, which is proxied |
| Other UDP | Not tunnelled (goes direct), also with WireGuard; UDP to fake IPs is rejected. Voice/video calls and games that use UDP may reveal the laptop's real public IP |
| IPv6 | Off on the hotspot (`ipv6.method ignore`), so clients only have IPv4 and nothing slips past the proxy over IPv6 |

Exit location: while the proxy is on, the map shows a node beside the router with
the exit's flag, city and IP (also the "Exit" tile in the VPN / proxy panel). It comes from
https://ipinfo.io, fetched through the proxy so it only ever sees the exit IP, and is
cached in SQLite (`meta` key `proxy.geo`) for an hour per proxy.

Rejected connections: the server follows sing-box's journal and records every
connection the upstream proxy refused or failed (site, port, reason, device)
into the `proxy_errors` table of the SQLite database, shown in the "Rejected
connections" panel. sing-box logs at `info` level for this (each client
connection is a few journal lines). The journal cursor is saved, so restarts
don't lose or repeat entries.

With a WireGuard upstream, the **Sites** view on the map shows IP addresses rather
than site names, because names are resolved before the connection enters the tunnel.

The proxy URL or WireGuard keys live in `~/.config/wifi-extender/proxy.json`
(mode 600) and are never sent to the dashboard (it shows `wireguard://endpoint:port`). The
folders and system names keep the project's original `wifi-extender` name so existing setups
keep working. sing-box runs as a user service: `journalctl --user -u wifi-extender-proxy`.
`proxy on` also adds ufw rules for the redirect ports (12345, 12353) on the hotspot card.
After a reboot, run `make port80` to restore the rules.

The redirect rules are tied to the hotspot card's name and are lost on reboot. If they
don't match the running hotspot (e.g. the USB card came back as `wlp0s20f0u2` instead of
`wlp0s20f0u1`), the VPN / proxy panel says **"On, but phones are NOT going through it"** with the
reason, and **Fix routing** (or the homepage's "Network rules need fixing" dialog) reloads them.

## CLI

```sh
make install                  # once

node bin/vpn-hotspot.js flow                       # dry run
node bin/vpn-hotspot.js start --ssid MyNet --password 'secret123'
node bin/vpn-hotspot.js status
node bin/vpn-hotspot.js stop
```

Or `npm link` once and call `vpn-hotspot` directly (`wifi-extender` still works as an alias).

| Option | Default |
|--------|---------|
| `--uplink <dev>` | the USB card |
| `--ap <dev>` | the other card |
| `--uplink-con <name>` | whichever saved connection is currently active |
| `--ssid <name>` | `Omarchy-Hotspot` |
| `--password <pw>` | random, printed once on start |
| `--band bg\|a` | `bg` (2.4 GHz) |
| `--gateway <ip>` | `10.0.0.1` (clients get 10.0.0.x) |

## FAQ / troubleshooting

**Phone says "Couldn't get IP address" / "Obtaining IP address" forever.**
The firewall (ufw) is blocking DHCP on the hotspot card, usually because the USB Wi-Fi
adapter got a new interface name (another USB port, a replug). The dashboard pops up
"Network rules need fixing": press **Fix** and approve the password dialog, then forget
the network on the phone and join again.

**The page says the proxy is on, but the phone's IP didn't change.**
The redirect rules point at an old card name or were lost on reboot. The VPN / proxy panel
shows the reason; press **Fix routing**.

**Which VPN providers work?**
Any that let you download a WireGuard config file (Mullvad, Proton VPN, Surfshark, IVPN, AirVPN,
Windscribe, your own WireGuard server…) or give you a SOCKS5 / HTTP proxy.
VPNs that only offer their own app or OpenVPN are not supported.

**Does the laptop's own traffic go through the VPN too?**
No. Only devices on the hotspot are tunnelled; the laptop keeps its normal connection.

**Can apps on the phone tell a VPN is used?**
Not from the phone itself: there is no VPN profile and no VPN flag. They can only judge
the exit IP address (see "What it can't hide" above).

**Do I need two Wi-Fi cards?**
Yes: one stays connected to your router, the other runs the hotspot. Any USB Wi-Fi
adapter that Linux supports will do for the uplink.

**Will the hotspot work on 5 GHz?**
It depends on the card: Intel cards often refuse to start an AP on 5 GHz because of
regulatory rules. Put the card that allows it on hotspot duty (**Swap cards**), or use 2.4 GHz.

## Alternatives and how this differs

| Project | What it is | Difference |
|---------|-----------|------------|
| [linux-wifi-hotspot](https://github.com/lakinduakash/linux-wifi-hotspot) / `create_ap` | Create a hotspot with hostapd, also from one card | No VPN routing; linux-vpn-hotspot adds the WireGuard / proxy routing and the dashboard, and uses two cards so repeating isn't half speed |
| Raspberry Pi VPN hotspot guides | A Pi as WireGuard / OpenVPN access point | Manual setup of hostapd, iptables and wg-quick; linux-vpn-hotspot is one command on a laptop, with a dashboard |
| A VPN app on the phone | Tunnel on the device | Visible to the phone and its apps; must be installed on every device |
| A travel router with VPN (GL.iNet etc.) | Dedicated hardware | Costs money; linux-vpn-hotspot reuses a laptop and a USB adapter |
| Android / iOS hotspot sharing a VPN | Phone shares its connection | Tethered devices usually don't go through the phone's VPN |

## Caveats

- Clients are on their own NAT network (10.0.0.x), not your router's
  192.168.1.x, so they may not see LAN devices like printers or casting targets.
- Intel cards usually refuse to start an AP on 5 GHz due to regulatory rules; keep `--band bg`.
- The laptop must stay awake; suspending drops the hotspot.
- The two cards use separate radios, so throughput is not halved like on single-radio repeaters.
- Use it on networks you're allowed to extend, and respect your proxy/VPN provider's terms.

## Tests

```sh
npm test
```

## License

MIT
