# lgtv-vpn-split

Per-app VPN split-tunnel routing for LG webOS TVs, built on top of
[sekrell/lgtv-vpn](https://github.com/sekrell/lgtv-vpn). The base app wraps
the bundled OpenVPN binary and drives it from the TV UI; this fork extends it
so you can pick which apps go through the tunnel (for example, just Peacock)
while everything else keeps using your default connection.

<img width="1830" height="668" alt="lg_vpn2" src="https://github.com/user-attachments/assets/9c07e479-1d45-47b8-bbf6-f2ea46c8ee42" />

## What's new vs. upstream

- **Per-app routing toggles** — a list of apps (Peacock, Netflix, YouTube by
  default, all off) that you can toggle on individually. When an app with
  routing on becomes the foreground app, only its traffic is routed through
  the VPN tunnel.
- **Two routing strategies:**
  - **IP-based (default, recommended)** — installs `ip route` entries for
    known CDN ranges so traffic to that CDN exits via `tun0`. Stable across
    reboots, doesn't depend on TV internals.
  - **UID-based (experimental)** — uses `iptables -m owner --uid-owner`
    plus a policy-routing table to mark packets from the app's Linux UID.
    Cleaner in theory, but UIDs aren't always stable across reboots, and
    requires the `xt_owner` kernel module.
- **Custom app IDs** — add any app ID manually; it'll show up in the list and
  you can toggle it (UID mode only, since we don't ship ranges for it).
- **Persistent config** in `config/routing.json` next to the app install.
- **Boot-time cleanup** via a Homebrew Channel `init.d` script.
- **Developer tool** (`tools/discover-ranges.js`) to help propose new CDN
  ranges from a pcap.

## Installation

### Build the IPK
```bash
npm install -g @webosose/ares-cli
ares-package com.sk.app.lgtv-vpn
ares-install --device webos com.sk.app.lgtv-vpn-split_0.1.0_all.ipk
```

### Provide your VPN profiles
Copy `.ovpn` files (and any referenced certs) to the TV at:

```
/media/developer/apps/usr/palm/applications/com.sk.app.lgtv-vpn-split/profiles/
```

The [webOS Dev Manager](https://github.com/webosbrew/dev-manager-desktop) is
the easiest way to push files over.

### Install the reboot-cleanup script (recommended)
If the app or the TV crashes while routes are in place, stale `ip route` /
`iptables` entries can leak. The init.d script flushes them on every boot:

```bash
scp -P 9922 -i ~/.ssh/webos_rsa \
  scripts/lgtv-vpn-split-cleanup.sh prisoner@<TV_IP>:/var/lib/webosbrew/init.d/
ssh -p 9922 -i ~/.ssh/webos_rsa prisoner@<TV_IP> \
  'chmod +x /var/lib/webosbrew/init.d/lgtv-vpn-split-cleanup.sh'
```

## Configuring per-app routing

1. Launch the app on the TV.
2. Connect to your VPN as usual.
3. In the **Per-App Routing** section, toggle the apps you want routed
   through the tunnel. Changes persist to
   `/media/developer/apps/usr/palm/applications/com.sk.app.lgtv-vpn-split/config/routing.json`.
4. Switch to the app. Its traffic (for known CDN ranges) will now exit via
   `tun0`; everything else keeps using your default connection.

### Adding Peacock / updating CDN ranges

The IP ranges we ship in `service/cdn-ranges.json` are a best-effort snapshot
of Comcast/NBCU CDN space. CDNs drift, so you may need to refresh them:

1. On a machine on the same LAN as the TV, start a capture while streaming:
   ```bash
   sudo tcpdump -i any -w peacock.pcap "tcp and host <TV_IP>"
   ```
2. Extract destination IPs:
   ```bash
   tshark -r peacock.pcap -T fields -e ip.dst > peacock.dsts.txt
   ```
3. Group into candidate CIDRs:
   ```bash
   node tools/discover-ranges.js \
     --app com.peacocktv.peacockandroid --name Peacock \
     --input peacock.dsts.txt --min-hits 5
   ```
4. Review the JSON fragment it prints. If the ranges look sensible, merge
   them into `service/cdn-ranges.json` and rebuild the IPK.

`tools/discover-ranges.js` is a developer tool only — it's not copied into
the IPK. The `res/` directory and the `service/` directory are what get
packaged.

### Choosing IP-based vs UID-based routing

Both modes are implemented; IP-based is the default.

| | IP-based (default) | UID-based (experimental) |
|---|---|---|
| How | `ip route add <cidr> dev tun0` | iptables mangle MARK + policy table |
| Stability | High — survives reboots, no kernel module deps | Depends on stable UIDs and `xt_owner` |
| Accuracy | Only hits ranges you've listed | Catches *all* traffic from the app |
| Requires | Nothing special | `xt_owner` module, root |
| Best for | Streaming apps with well-known CDNs | Apps that talk to ad-hoc hosts |

Enable UID mode with the "Experimental: Process-based routing" checkbox.
The app checks for `xt_owner` on startup and disables the checkbox (with a
warning) if it isn't available on your TV.

### Known apps seeded in `cdn-ranges.json`

- `com.peacocktv.peacockandroid` — Peacock (Comcast/NBCU CDN)
- `com.netflix.ninja` — Netflix Open Connect (wildly variable by region!)
- `youtube.leanback.v4` — YouTube / Google

All default to **off**. Toggle on only what you need.

## Requirements

- An LG TV with webOS, the Homebrew Channel installed with root, and
  Developer Mode active.
- Working `.ovpn` profile files.
- For UID-based routing: the `xt_owner` kernel module. Check with
  `lsmod | grep xt_owner` over SSH.

## Stability and troubleshooting

- **QuickStart+** can cause the app to appear frozen after a VPN failure on
  some firmware builds. If you hit it, turn QuickStart off in the TV's
  settings, or reboot the TV.
- **Developer Mode** expires after 1000 hours; you'll need to reset the
  timer periodically. For persistent installs, root via
  [rootmy.tv](https://rootmy.tv) is recommended.
- If routing seems stuck after a crash, reboot the TV — the init.d cleanup
  script flushes table 100 and the fwmark rule on boot. Or run
  `scripts/lgtv-vpn-split-cleanup.sh` manually over SSH.
- Use `ssh -p 9922 -i ~/.ssh/webos_rsa prisoner@<TV_IP>` to get a root
  shell, then inspect live state:
  ```bash
  ip route show table 100
  ip rule show
  iptables -t mangle -L OUTPUT -n -v
  ```

## File layout

```
com.sk.app.lgtv-vpn/
  appinfo.json                 # id: com.sk.app.lgtv-vpn-split
  index.html                   # UI (extended with routing section)
  css/style.css
  js/index.js                  # frontend logic + per-app toggles
  service/
    service.js                 # state machine (IP & UID modes)
    routing-rules.js           # iptables / ip route command builders
    app-monitor.js             # Luna foreground-app subscription
    uid-discovery.js           # /proc-based UID lookup w/ cache
    cdn-ranges.json            # seed IP ranges per app
  res/openvpn                  # bundled binary (unchanged from upstream)
  profiles/                    # user-provided .ovpn files live here
scripts/
  lgtv-vpn-split-cleanup.sh    # install to /var/lib/webosbrew/init.d/
tools/
  discover-ranges.js           # developer helper — not packaged
```

## Out of scope (for this iteration)

- WireGuard (OpenVPN only for now).
- Automatic CDN range discovery on-device.
- Multiple simultaneous VPN profiles.
- Editing CDN ranges from the TV UI — use Dev Manager file transfer.

## Attribution

Fork of [sekrell/lgtv-vpn](https://github.com/sekrell/lgtv-vpn). Licensed
under GPL-3.0 (see `com.sk.app.lgtv-vpn/LICENSE`).
