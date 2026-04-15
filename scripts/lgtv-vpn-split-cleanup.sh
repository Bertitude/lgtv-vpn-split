#!/bin/sh
#
# lgtv-vpn-split-cleanup.sh
#
# Install this into the Homebrew Channel init.d directory on the TV so any
# routing/iptables state left behind by a crashed session is flushed at boot:
#
#   cp scripts/lgtv-vpn-split-cleanup.sh /var/lib/webosbrew/init.d/
#   chmod +x /var/lib/webosbrew/init.d/lgtv-vpn-split-cleanup.sh
#
# The commands are deliberately tolerant: the TV may boot into a state where
# table 100 or the fwmark rule don't exist, and that's fine.

FWMARK=100
TABLE=100

# Remove any lingering MARK rules on the mangle OUTPUT chain. This is a
# broad flush; on LG firmwares OUTPUT is not typically used by the system,
# but if you know it is on your TV, replace this with targeted -D calls.
iptables -t mangle -F OUTPUT 2>/dev/null || true

# Drop the policy-routing rule that sent marked packets into table 100.
ip rule del fwmark "$FWMARK" table "$TABLE" 2>/dev/null || true

# And flush any leftover routes in that table.
ip route flush table "$TABLE" 2>/dev/null || true

# Per-boot UID cache is in /tmp and disappears on its own, but remove it
# explicitly in case /tmp isn't tmpfs on some TV models.
rm -f /tmp/lgtv-vpn-split-uid-cache.json 2>/dev/null || true

exit 0
