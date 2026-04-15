/*
 * uid-discovery.js
 *
 * Best-effort mapping from a webOS app ID to the Linux UID of its running
 * process. Used by the experimental UID-based routing mode. The mapping is
 * unstable across reboots on many firmwares, so results are cached per-boot
 * in /tmp and persisted to the app's config directory for faster startup;
 * callers must be prepared for a lookup to return null.
 *
 * ES5 only (runs in both the frontend polyfill and a possible future JS
 * service). All shell work is done through a caller-supplied `exec(cmd, cb)`
 * bridge so we stay agnostic about whether we're talking to the Luna
 * hbchannel exec endpoint or to a local child_process.
 */

/*global module*/
(function (root) {
  'use strict';

  var CACHE_PATH = '/tmp/lgtv-vpn-split-uid-cache.json';
  var PERSIST_PATH =
    '/media/developer/apps/usr/palm/applications/com.sk.app.lgtv-vpn-split/config/uid-cache.json';

  // A compact shell pipeline that: for every running PID, reads cmdline and
  // the effective UID, finds those whose cmdline mentions the given appId,
  // and prints "<uid> <pid>" lines. Uses only busybox-safe tools.
  //
  // We match on appId substring in /proc/<pid>/cmdline because webOS launches
  // web apps as children of WAM/sam where the appId appears on the argv but
  // not always as argv[0].
  function buildLookupScript(appId) {
    // appId is coming from UI input; sanity-check before putting in the shell.
    if (!/^[A-Za-z0-9._\-]+$/.test(appId || '')) {
      return null;
    }
    // xargs+grep pipeline against /proc, printing "uid pid" per match.
    return [
      'for p in /proc/[0-9]*; do',
      '  pid=${p##*/};',
      '  cl=$(tr "\\0" " " < "$p/cmdline" 2>/dev/null);',
      '  case "$cl" in',
      '    *' + appId + '*)',
      '      uid=$(awk "/^Uid:/ {print \\$2; exit}" "$p/status" 2>/dev/null);',
      '      [ -n "$uid" ] && echo "$uid $pid";',
      '      ;;',
      '  esac;',
      'done'
    ].join(' ');
  }

  function parseLookupOutput(stdout) {
    if (!stdout) { return null; }
    var lines = String(stdout).split(/\r?\n/);
    // Prefer the lowest UID that isn't root (0) — app sandboxes tend to run
    // as a dedicated non-root UID, and if we see root it's probably WAM.
    var best = null;
    for (var i = 0; i < lines.length; i++) {
      var parts = lines[i].trim().split(/\s+/);
      if (parts.length < 1) { continue; }
      var uid = parseInt(parts[0], 10);
      if (isNaN(uid) || uid < 0) { continue; }
      if (uid === 0) { continue; }
      if (best === null || uid < best) { best = uid; }
    }
    return best;
  }

  // Cache file manipulation is done via shell (cat/printf) so we don't need a
  // Node fs module — keeps this usable from the frontend polyfill path.
  function buildReadCacheScript(path) {
    return 'cat ' + shellQuote(path) + ' 2>/dev/null || echo "{}"';
  }

  function buildWriteCacheScript(path, jsonString) {
    // Write atomically: tmp + mv. `printf %s` avoids newline / escape surprises.
    var tmp = path + '.tmp';
    return 'mkdir -p "$(dirname ' + shellQuote(path) + ')" && ' +
      'printf %s ' + shellQuote(jsonString) + ' > ' + shellQuote(tmp) + ' && ' +
      'mv ' + shellQuote(tmp) + ' ' + shellQuote(path);
  }

  function shellQuote(s) {
    if (s === null || s === undefined) { return "''"; }
    var str = String(s);
    if (/^[A-Za-z0-9_./:,{}" -]+$/.test(str) && str.indexOf("'") === -1) {
      return "'" + str + "'";
    }
    return "'" + str.replace(/'/g, "'\\''") + "'";
  }

  // High-level lookup. exec is a function(cmd, cb(err, stdout)).
  // Tries in-memory cache, then /tmp cache, then persisted cache, then /proc.
  function discoverAppUid(exec, appId, cb) {
    if (!appId) { cb(new Error('appId required')); return; }
    if (memoryCache.hasOwnProperty(appId)) {
      cb(null, memoryCache[appId]);
      return;
    }
    loadCache(exec, CACHE_PATH, function (err, bootCache) {
      if (!err && bootCache && bootCache[appId] != null) {
        memoryCache[appId] = bootCache[appId];
        cb(null, bootCache[appId]);
        return;
      }
      var script = buildLookupScript(appId);
      if (!script) { cb(new Error('invalid appId: ' + appId)); return; }
      exec(script, function (execErr, stdout) {
        if (execErr) { cb(execErr); return; }
        var uid = parseLookupOutput(stdout);
        if (uid === null) { cb(null, null); return; }
        memoryCache[appId] = uid;
        bootCache = bootCache || {};
        bootCache[appId] = uid;
        // Persist best-effort; don't block on failure.
        saveCache(exec, CACHE_PATH, bootCache, function () {});
        saveCache(exec, PERSIST_PATH, bootCache, function () {});
        cb(null, uid);
      });
    });
  }

  var memoryCache = {};

  function loadCache(exec, path, cb) {
    exec(buildReadCacheScript(path), function (err, stdout) {
      if (err) { cb(err); return; }
      try {
        cb(null, JSON.parse(stdout || '{}'));
      } catch (e) {
        cb(null, {});
      }
    });
  }

  function saveCache(exec, path, obj, cb) {
    var json;
    try { json = JSON.stringify(obj); }
    catch (e) { cb(e); return; }
    exec(buildWriteCacheScript(path, json), cb);
  }

  function clearCache(exec, cb) {
    memoryCache = {};
    exec('rm -f ' + shellQuote(CACHE_PATH) + ' ' + shellQuote(PERSIST_PATH), cb || function () {});
  }

  var api = {
    CACHE_PATH: CACHE_PATH,
    PERSIST_PATH: PERSIST_PATH,
    buildLookupScript: buildLookupScript,
    parseLookupOutput: parseLookupOutput,
    discoverAppUid: discoverAppUid,
    clearCache: clearCache
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.UidDiscovery = api;
  }
}(typeof window !== 'undefined' ? window : this));
