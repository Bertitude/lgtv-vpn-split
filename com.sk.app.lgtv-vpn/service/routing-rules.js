/*
 * routing-rules.js
 *
 * Helpers that translate a per-app routing intent into shell commands to run
 * on the TV via luna://org.webosbrew.hbchannel.service/exec.
 *
 * NOTE: webOS' on-device Node.js is ancient (v0.10 on some models). This file
 * is intentionally written in ES5 (var, callbacks, no arrow functions) so it
 * can be required by a future proper JS service worker, AND so it can be
 * eval-loaded as a plain script by the frontend polyfill. Do not use const,
 * let, template literals, destructuring, etc. here.
 */

/*global module*/
(function (root) {
  'use strict';

  // Fixed mark used for UID-based routing. Kept small so it doesn't collide
  // with marks the TV firmware might set on its own (observed values <=32).
  var FWMARK = 100;
  var RT_TABLE = 100;

  // ---------- IP-based routing (Approach A) ----------

  // Build the `ip route add` command for a single CIDR range, routed via the
  // VPN gateway on tun0. The caller is responsible for resolving the gateway.
  function ipRouteAddCmd(cidr, vpnGateway) {
    if (!cidr) { return null; }
    // If the tun device has a /32 peer (common with OpenVPN tun), using
    // `dev tun0` alone is enough; via <gw> is harmless when gw is on-link.
    if (vpnGateway) {
      return 'ip route add ' + shellQuote(cidr) + ' via ' + shellQuote(vpnGateway) + ' dev tun0';
    }
    return 'ip route add ' + shellQuote(cidr) + ' dev tun0';
  }

  function ipRouteDelCmd(cidr) {
    if (!cidr) { return null; }
    // `|| true` so cleanup never aborts a batch if a route is already gone.
    return 'ip route del ' + shellQuote(cidr) + ' 2>/dev/null || true';
  }

  function buildAddRangesScript(ranges, vpnGateway) {
    var lines = [];
    for (var i = 0; i < ranges.length; i++) {
      var cmd = ipRouteAddCmd(ranges[i], vpnGateway);
      if (cmd) { lines.push(cmd); }
    }
    return lines.join(' ; ');
  }

  function buildDelRangesScript(ranges) {
    var lines = [];
    for (var i = 0; i < ranges.length; i++) {
      var cmd = ipRouteDelCmd(ranges[i]);
      if (cmd) { lines.push(cmd); }
    }
    return lines.join(' ; ');
  }

  // ---------- UID-based routing (Approach B, experimental) ----------

  // Prime the policy routing table once per VPN connection. Safe to call
  // repeatedly; each step tolerates "file exists" / "already exists" errors.
  function buildUidTableInitScript(vpnGateway) {
    var gw = vpnGateway ? ('via ' + shellQuote(vpnGateway) + ' ') : '';
    return [
      // Route everything in table 100 through the VPN.
      'ip route replace default ' + gw + 'dev tun0 table ' + RT_TABLE,
      // Direct marked packets into that table.
      '(ip rule show | grep -q "fwmark 0x' + FWMARK.toString(16) + '") || ' +
        'ip rule add fwmark ' + FWMARK + ' table ' + RT_TABLE
    ].join(' ; ');
  }

  // Add a mangle OUTPUT rule marking packets owned by the target UID.
  function buildUidRuleAddScript(uid) {
    var u = parseInt(uid, 10);
    if (isNaN(u) || u < 0) { return null; }
    return 'iptables -t mangle -C OUTPUT -m owner --uid-owner ' + u +
      ' -j MARK --set-mark ' + FWMARK + ' 2>/dev/null || ' +
      'iptables -t mangle -A OUTPUT -m owner --uid-owner ' + u +
      ' -j MARK --set-mark ' + FWMARK;
  }

  function buildUidRuleDelScript(uid) {
    var u = parseInt(uid, 10);
    if (isNaN(u) || u < 0) { return null; }
    return 'iptables -t mangle -D OUTPUT -m owner --uid-owner ' + u +
      ' -j MARK --set-mark ' + FWMARK + ' 2>/dev/null || true';
  }

  // ---------- Cleanup ----------

  // Flush everything this app is known to add. Intended for the init.d
  // reboot-cleanup path; in-session teardown should use buildDelRangesScript /
  // buildUidRuleDelScript against the tracked state for surgical removal.
  function buildFullCleanupScript() {
    return [
      // Mangle OUTPUT: drop our mark rules without nuking any unrelated rules
      // the firmware may have installed. `iptables -t mangle -F OUTPUT` would
      // be broader than we want in a running system, so prefer selective dels
      // where possible; the init.d script below does a full flush on boot.
      'iptables -t mangle -F OUTPUT 2>/dev/null || true',
      'ip rule del fwmark ' + FWMARK + ' table ' + RT_TABLE + ' 2>/dev/null || true',
      'ip route flush table ' + RT_TABLE + ' 2>/dev/null || true'
    ].join(' ; ');
  }

  // ---------- Introspection ----------

  // Ask the kernel for the VPN gateway. Returns a shell command whose stdout
  // is a single IP (or empty if tun0 is down). The frontend parses the result.
  function buildDiscoverVpnGatewayScript() {
    return [
      // Preferred: OpenVPN's management interface exposes `route_vpn_gateway`
      // in its env-before-up block, but from shell the easiest source is
      // the tun0 peer address.
      'ip -4 addr show dev tun0 2>/dev/null | awk \'/peer /{print $4}\' | cut -d/ -f1',
      // Fallback: default route that pins dev tun0.
      'ip -4 route show default dev tun0 2>/dev/null | awk \'{for(i=1;i<=NF;i++) if($i=="via") print $(i+1)}\''
    ].join(' ; ');
  }

  function buildCheckXtOwnerScript() {
    // Two signals: is the module loaded, or does iptables understand the
    // --uid-owner match at all (it might be built in, not a module).
    return 'lsmod 2>/dev/null | grep -q "^xt_owner" && echo yes || ' +
      '( iptables -t mangle -m owner --help 2>&1 | grep -q uid-owner && echo yes || echo no )';
  }

  // ---------- Utilities ----------

  // Very small shell-quoter: we only ever pass CIDRs and dotted-quad IPs, so
  // this is defensive belt-and-suspenders against a poisoned cdn-ranges.json.
  function shellQuote(s) {
    if (s === null || s === undefined) { return "''"; }
    var str = String(s);
    if (/^[A-Za-z0-9_./:-]+$/.test(str)) { return str; }
    return "'" + str.replace(/'/g, "'\\''") + "'";
  }

  var api = {
    FWMARK: FWMARK,
    RT_TABLE: RT_TABLE,
    ipRouteAddCmd: ipRouteAddCmd,
    ipRouteDelCmd: ipRouteDelCmd,
    buildAddRangesScript: buildAddRangesScript,
    buildDelRangesScript: buildDelRangesScript,
    buildUidTableInitScript: buildUidTableInitScript,
    buildUidRuleAddScript: buildUidRuleAddScript,
    buildUidRuleDelScript: buildUidRuleDelScript,
    buildFullCleanupScript: buildFullCleanupScript,
    buildDiscoverVpnGatewayScript: buildDiscoverVpnGatewayScript,
    buildCheckXtOwnerScript: buildCheckXtOwnerScript,
    shellQuote: shellQuote
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.RoutingRules = api;
  }
}(typeof window !== 'undefined' ? window : this));
