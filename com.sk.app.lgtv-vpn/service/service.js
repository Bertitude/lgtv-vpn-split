/*
 * service.js
 *
 * Core per-app routing orchestration. The upstream project (sekrell/lgtv-vpn)
 * is frontend-only: it shells out to luna://org.webosbrew.hbchannel.service
 * directly from the browser context. This file intentionally keeps that
 * architecture — the "service" here is a script that runs inside the
 * frontend's JS engine and composes the routing-rules / app-monitor /
 * uid-discovery helpers into a single state machine.
 *
 * A future migration to a proper webOS JS service (services.json, palm-bus
 * registration, separate Node.js process) can reuse this module as-is
 * because it only talks to its dependencies through a tiny `exec` shim.
 *
 * ES5 only.
 */

/*global module, require, window, RoutingRules, AppMonitor, UidDiscovery*/
(function (root) {
  'use strict';

  var RR = (typeof require === 'function') ? require('./routing-rules') : root.RoutingRules;
  var AM = (typeof require === 'function') ? require('./app-monitor') : root.AppMonitor;
  var UD = (typeof require === 'function') ? require('./uid-discovery') : root.UidDiscovery;

  // Keep a single, authoritative snapshot of everything this process added to
  // the network stack. If anything in here leaks, the init.d cleanup script
  // picks it up on reboot.
  var state = {
    vpnConnected: false,
    activeProfile: null,
    foregroundApp: null,
    routingMode: 'ip',              // 'ip' | 'uid'
    vpnGateway: null,
    activeRoutes: [],               // CIDRs currently installed via tun0
    activeRules: [],                // UIDs currently marked via iptables
    routingConfig: { apps: {} },    // merged user settings (per-app on/off)
    cdnRanges: { apps: {} },        // loaded from cdn-ranges.json
    uidTableReady: false,
    xtOwnerAvailable: null
  };

  // ------ exec bridge ------
  // The caller (the frontend) injects a function(cmd, cb) that pushes through
  // the Homebrew Channel Luna exec endpoint. Keeping it injected means this
  // file is testable off-device.
  var execShell = null;
  function setExec(fn) { execShell = fn; }

  function exec(cmd, cb) {
    if (!execShell) {
      cb(new Error('exec bridge not wired; call setExec() first'));
      return;
    }
    execShell(cmd, cb);
  }

  // ------ lifecycle ------

  function init(cfg, cb) {
    cfg = cfg || {};
    if (cfg.exec) { setExec(cfg.exec); }
    if (cfg.cdnRanges) { state.cdnRanges = cfg.cdnRanges; }
    if (cfg.routingConfig) { state.routingConfig = cfg.routingConfig; }
    if (cfg.routingMode) { state.routingMode = cfg.routingMode; }

    // Probe xt_owner availability upfront so the UI can disable the
    // UID-based toggle with a clear reason when the kernel doesn't have it.
    exec(RR.buildCheckXtOwnerScript(), function (err, out) {
      state.xtOwnerAvailable = !err && /yes/.test(String(out || ''));
      cb && cb(null, {
        xtOwnerAvailable: state.xtOwnerAvailable,
        routingMode: state.routingMode
      });
    });
  }

  // Called after the VPN has come up. Pulls the gateway off tun0 and
  // pre-arms the UID routing table if we're in that mode.
  function onVpnConnected(profile, cb) {
    state.vpnConnected = true;
    state.activeProfile = profile;

    exec(RR.buildDiscoverVpnGatewayScript(), function (err, out) {
      if (!err && out) {
        var firstLine = String(out).split(/\r?\n/)[0].trim();
        state.vpnGateway = firstLine || null;
      }
      if (state.routingMode === 'uid') {
        exec(RR.buildUidTableInitScript(state.vpnGateway), function (e2) {
          state.uidTableReady = !e2;
          // Re-apply rules for whatever app is currently in the foreground.
          applyForCurrentApp(function () { cb && cb(null, state); });
        });
      } else {
        applyForCurrentApp(function () { cb && cb(null, state); });
      }
    });
  }

  // Called when the VPN is being torn down. Removes every rule/route we
  // tracked; deliberately synchronous-feeling (sequential) so we don't leak.
  function onVpnDisconnecting(cb) {
    var routes = state.activeRoutes.slice();
    var uids = state.activeRules.slice();
    var steps = [];

    if (routes.length) { steps.push(RR.buildDelRangesScript(routes)); }
    for (var i = 0; i < uids.length; i++) {
      var s = RR.buildUidRuleDelScript(uids[i]);
      if (s) { steps.push(s); }
    }
    steps.push(RR.buildFullCleanupScript());

    runSequential(steps, function (err) {
      state.activeRoutes = [];
      state.activeRules = [];
      state.uidTableReady = false;
      state.vpnConnected = false;
      state.vpnGateway = null;
      state.activeProfile = null;
      cb && cb(err || null);
    });
  }

  // ------ foreground-app reactions ------

  var appMonitorHandle = null;

  function startAppMonitor(onChange) {
    if (appMonitorHandle) { return; }
    appMonitorHandle = AM.subscribe(function (appId) {
      state.foregroundApp = appId;
      if (onChange) { onChange(appId); }
      // Only touch routes if the VPN is up; otherwise this is a no-op.
      if (state.vpnConnected) {
        applyForCurrentApp(function () {});
      }
    }, function (err) {
      // Surface the error through the same callback so the UI can render it.
      if (onChange) { onChange(null, err); }
    });
  }

  function stopAppMonitor() {
    if (appMonitorHandle) {
      appMonitorHandle.cancel();
      appMonitorHandle = null;
    }
  }

  // Given the current foreground app and the user's routing config, drive
  // the network state to match. The strategy is idempotent: we compute the
  // desired set of routes/rules, diff against what's already installed, and
  // only issue commands for the delta.
  function applyForCurrentApp(cb) {
    var appId = state.foregroundApp;
    var enabled = !!(appId && state.routingConfig.apps &&
                     state.routingConfig.apps[appId] &&
                     state.routingConfig.apps[appId].enabled);

    if (state.routingMode === 'ip') {
      var desiredRanges = [];
      if (enabled) {
        var entry = state.cdnRanges.apps && state.cdnRanges.apps[appId];
        if (entry && entry.ranges) { desiredRanges = entry.ranges.slice(); }
      }
      var toAdd = diff(desiredRanges, state.activeRoutes);
      var toDel = diff(state.activeRoutes, desiredRanges);
      var steps = [];
      if (toDel.length) { steps.push(RR.buildDelRangesScript(toDel)); }
      if (toAdd.length && state.vpnConnected) {
        steps.push(RR.buildAddRangesScript(toAdd, state.vpnGateway));
      }
      runSequential(steps, function (err) {
        if (!err) {
          state.activeRoutes = desiredRanges.slice();
        }
        cb && cb(err || null);
      });
      return;
    }

    // routingMode === 'uid'
    if (!enabled) {
      // Clear any UID rules we put in place.
      var oldUids = state.activeRules.slice();
      var delSteps = [];
      for (var i = 0; i < oldUids.length; i++) {
        var ds = RR.buildUidRuleDelScript(oldUids[i]);
        if (ds) { delSteps.push(ds); }
      }
      runSequential(delSteps, function (err) {
        if (!err) { state.activeRules = []; }
        cb && cb(err || null);
      });
      return;
    }

    // Resolve UID for the foreground app, then install the mark rule.
    UD.discoverAppUid(exec, appId, function (err, uid) {
      if (err || uid == null) {
        // Degrade gracefully: surface through callback but don't throw.
        cb && cb(err || new Error('UID not found for ' + appId));
        return;
      }
      if (state.activeRules.indexOf(uid) !== -1) {
        cb && cb(null);
        return;
      }
      var addScript = RR.buildUidRuleAddScript(uid);
      if (!addScript) { cb && cb(new Error('bad uid ' + uid)); return; }
      exec(addScript, function (e2) {
        if (!e2) { state.activeRules.push(uid); }
        cb && cb(e2 || null);
      });
    });
  }

  // ------ config persistence ------
  // Settings live alongside the app install so they survive reinstalls but
  // not uninstalls. Path is resolved at runtime against appinfo.id.

  function configPath() {
    return '/media/developer/apps/usr/palm/applications/' +
      'com.sk.app.lgtv-vpn-split/config/routing.json';
  }

  function loadConfig(cb) {
    exec('cat ' + shellQuote(configPath()) + ' 2>/dev/null || echo "{}"', function (err, out) {
      if (err) { cb(err); return; }
      var parsed = {};
      try { parsed = JSON.parse(out || '{}'); }
      catch (e) { parsed = {}; }
      if (!parsed.apps) { parsed.apps = {}; }
      state.routingConfig = parsed;
      cb(null, parsed);
    });
  }

  function saveConfig(cfg, cb) {
    state.routingConfig = cfg || state.routingConfig;
    var json;
    try { json = JSON.stringify(state.routingConfig, null, 2); }
    catch (e) { cb && cb(e); return; }
    var script =
      'mkdir -p "$(dirname ' + shellQuote(configPath()) + ')" && ' +
      'printf %s ' + shellQuote(json) + ' > ' + shellQuote(configPath());
    exec(script, function (err) { cb && cb(err || null); });
  }

  // ------ utilities ------

  function runSequential(cmds, cb) {
    var i = 0;
    function next() {
      if (i >= cmds.length) { cb(null); return; }
      var c = cmds[i++];
      if (!c) { next(); return; }
      exec(c, function (err) {
        if (err) { cb(err); return; }
        next();
      });
    }
    next();
  }

  function diff(a, b) {
    var set = {};
    for (var i = 0; i < b.length; i++) { set[b[i]] = true; }
    var out = [];
    for (var j = 0; j < a.length; j++) {
      if (!set[a[j]]) { out.push(a[j]); }
    }
    return out;
  }

  function shellQuote(s) { return RR.shellQuote(s); }

  function getState() {
    // Return a shallow copy so callers can't mutate our state object.
    return {
      vpnConnected: state.vpnConnected,
      activeProfile: state.activeProfile,
      foregroundApp: state.foregroundApp,
      routingMode: state.routingMode,
      vpnGateway: state.vpnGateway,
      activeRoutes: state.activeRoutes.slice(),
      activeRules: state.activeRules.slice(),
      xtOwnerAvailable: state.xtOwnerAvailable,
      knownApps: state.cdnRanges.apps ? Object.keys(state.cdnRanges.apps) : []
    };
  }

  function setRoutingMode(mode, cb) {
    if (mode !== 'ip' && mode !== 'uid') {
      cb && cb(new Error('invalid routing mode: ' + mode));
      return;
    }
    // Tear down current rules before switching mode to avoid a mixed state.
    onVpnDisconnecting(function () {
      state.routingMode = mode;
      if (state.vpnConnected) {
        onVpnConnected(state.activeProfile, cb);
      } else {
        cb && cb(null);
      }
    });
  }

  var api = {
    setExec: setExec,
    init: init,
    onVpnConnected: onVpnConnected,
    onVpnDisconnecting: onVpnDisconnecting,
    startAppMonitor: startAppMonitor,
    stopAppMonitor: stopAppMonitor,
    applyForCurrentApp: applyForCurrentApp,
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    configPath: configPath,
    setRoutingMode: setRoutingMode,
    getState: getState
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.VpnSplitService = api;
  }
}(typeof window !== 'undefined' ? window : this));
