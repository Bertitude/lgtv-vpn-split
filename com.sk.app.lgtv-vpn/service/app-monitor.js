/*
 * app-monitor.js
 *
 * Subscribes to foreground-app changes on webOS and invokes a callback when
 * the visible app changes. Exposed in two shapes:
 *   - As a CommonJS module for a Node-side JS service (webOS services API).
 *   - As a window.AppMonitor object for the frontend, which subscribes via
 *     the webOS.service.request bridge.
 *
 * ES5 only (see note in routing-rules.js).
 */

/*global module, webOS, require*/
(function (root) {
  'use strict';

  var FG_URI = 'luna://com.webos.applicationManager/getForegroundAppInfo';

  // ---------- Frontend shim (webOS.service.request in the browser) ----------

  function subscribeFrontend(onChange, onError) {
    if (typeof webOS === 'undefined' || !webOS.service || !webOS.service.request) {
      if (onError) { onError(new Error('webOS.service not available')); }
      return { cancel: function () {} };
    }
    var last = null;
    var req = webOS.service.request('luna://com.webos.applicationManager', {
      method: 'getForegroundAppInfo',
      parameters: { subscribe: true },
      onSuccess: function (resp) {
        var appId = resp && resp.appId ? resp.appId : null;
        if (appId !== last) {
          last = appId;
          try { onChange(appId, resp); } catch (e) { if (onError) { onError(e); } }
        }
      },
      onFailure: function (err) {
        if (onError) { onError(new Error(err && err.errorText ? err.errorText : 'subscription failed')); }
      },
      subscribe: true
    });

    return {
      cancel: function () {
        if (req && typeof req.cancel === 'function') {
          try { req.cancel(); } catch (e) { /* ignore */ }
        }
      }
    };
  }

  // ---------- Service-side shim (Node.js + webos-service) ----------
  //
  // Only used if this file is required from a proper JS service. The webOS
  // service runtime exposes a palm-bus client; we probe for it lazily so the
  // frontend build doesn't try to resolve the dependency.

  function subscribeService(onChange, onError) {
    var Service;
    try {
      // webos-service is the package name under @webosose tooling.
      Service = require('webos-service');
    } catch (e) {
      if (onError) { onError(new Error('webos-service not available: ' + e.message)); }
      return { cancel: function () {} };
    }

    var svc = new Service('com.sk.app.lgtv-vpn-split.service');
    var last = null;
    var sub = svc.subscribe(FG_URI, { subscribe: true });

    sub.on('response', function (msg) {
      var appId = msg && msg.payload && msg.payload.appId ? msg.payload.appId : null;
      if (appId !== last) {
        last = appId;
        try { onChange(appId, msg.payload); } catch (e) { if (onError) { onError(e); } }
      }
    });
    sub.on('cancel', function () { /* no-op */ });

    return {
      cancel: function () {
        try { sub.cancel(); } catch (e) { /* ignore */ }
      }
    };
  }

  function subscribe(onChange, onError) {
    // Frontend path takes precedence — this module is loaded in the browser
    // context today. Service path is here for the eventual migration.
    if (typeof webOS !== 'undefined' && webOS.service && webOS.service.request) {
      return subscribeFrontend(onChange, onError);
    }
    if (typeof require === 'function') {
      return subscribeService(onChange, onError);
    }
    if (onError) { onError(new Error('No Luna bus available')); }
    return { cancel: function () {} };
  }

  var api = {
    subscribe: subscribe,
    FG_URI: FG_URI
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.AppMonitor = api;
  }
}(typeof window !== 'undefined' ? window : this));
