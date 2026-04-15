
/* Remote focus helpers */
const eventRegister = (() => {
  const items = () => document.getElementsByClassName("item");
  const blurAll = () => { for (const n of items()) n.blur(); };
  const over = e => { blurAll(); e.target.focus(); };
  const kd = e => { if (e.keyCode === 13) e.target.classList.add("active"); };
  const ku = e => { if (e.keyCode === 13) e.target.classList.remove("active"); };
  const add = () => {
    for (const n of items()) {
      // Guard against double-registration as rows get re-rendered.
      if (n.dataset.focusHooked === '1') continue;
      n.dataset.focusHooked = '1';
      n.addEventListener("mouseover", over);
      n.addEventListener("mouseout", () => n.blur());
      n.addEventListener("keydown", kd);
      n.addEventListener("keyup", ku);
    }
  };
  return { add };
})();

let curState = "UNKNOWN", poll = null;
const mgmtPort = 7505;
let visibilityProp = null;
let visibilityEvent = null;

// New in lgtv-vpn-split: the installed app id (drives all absolute paths).
const APP_ID = 'com.sk.app.lgtv-vpn-split';
const APP_BASE = `/media/developer/apps/usr/palm/applications/${APP_ID}`;
const CDN_RANGES_PATH = `${APP_BASE}/service/cdn-ranges.json`;

// Whole-app routing state mirrored from service.js. Also persisted to
// routing.json so user toggles survive reboots.
let cdnRanges = { apps: {} };
let routingConfig = { apps: {} };
let xtOwnerAvailable = null;

function lunaCall(uri, parameters, timeout = 8000) {
  return Promise.race([
    new Promise((_, r) => setTimeout(() => r(new Error("Timeout")), timeout)),
    new Promise((res, rej) => {
      const s = uri.indexOf('/', 7);
      webOS.service.request(uri.substring(0, s), {
        method: uri.substring(s + 1),
        parameters,
        onSuccess: res, onFailure: r => rej(new Error(JSON.stringify(r)))
      });
    })
  ]);
}

// Thin promise-to-callback adapter: the service modules expect a
// Node-style exec(cmd, cb(err, stdout)) bridge, but in the frontend we
// drive the Homebrew Channel exec endpoint with Promises.
function execBridge(cmd, cb) {
  lunaCall('luna://org.webosbrew.hbchannel.service/exec', { command: cmd }, 20000)
    .then(r => cb(null, r && r.stdoutString ? r.stdoutString : ''))
    .catch(err => cb(err));
}

function setButtonLabel(state) {
  const btn = document.getElementById('cbtn');
  btn.innerText = state === "CONNECTED" ? "Stop" : "Connect";
}
function focusFirstEnabledItem() {
  for (el of document.getElementsByClassName('item')) {
    if(!el.disabled) {
      el.focus();
      return;
    }
  }
}

function setButtonDisabled(dis) {
  document.getElementById('cbtn').disabled = dis;
  SpatialNavigation.makeFocusable();
  focusFirstEnabledItem();
}
function setDropdownDisabled(dis) { document.getElementById('configDropdown').disabled = dis;
  SpatialNavigation.makeFocusable();
  focusFirstEnabledItem();
}

function updateStateLabel(text, cls = null) {
  const s = document.getElementById('state');
  s.className = '';
  if (cls) s.classList.add(cls);
  s.innerText = text;
}

function setDebug(msg) { document.getElementById('debugInfo').innerText = "DebugMsg:\n"+msg; }
function extendDebug(msg) { document.getElementById('debugInfo').innerText = document.getElementById('debugInfo').innerText + "\n" + msg; }
function showError(msg) { document.getElementById('errorMsg').innerText = msg; }

async function terminateDaemon() {
  try {
    await lunaCall('luna://org.webosbrew.hbchannel.service/exec', { command: `{ echo "signal SIGTERM"; sleep 1s; echo "exit";} | nc 127.0.0.1 ${mgmtPort}` },timeout=15000);
  } catch (e) {
    extendDebug(`Cleanup stop failed: ${e.message}`);
  }
}

async function getState(retries = 3, canfail = false) {
  try {
    updateStateLabel('Checking...', "connecting");
    showError("");
    const r = await lunaCall('luna://org.webosbrew.hbchannel.service/exec', { command: `{ echo "state"; sleep 1s; echo "exit";} | nc 127.0.0.1 ${mgmtPort}` });
    const out = r.stdoutString || '';
    setDebug(out);
    if (out.includes('CONNECTED')) {
      const wasConnected = curState === 'CONNECTED';
      curState = 'CONNECTED';
      updateStateLabel('CONNECTED', 'connected');
      setButtonLabel(curState);
      setButtonDisabled(false);
      setDropdownDisabled(true);
      if (!wasConnected) {
        // Transition: wire routing to the fresh tunnel. `null` profile is fine;
        // we only use the profile for diagnostics in the service.
        VpnSplitService.onVpnConnected(
          document.getElementById('configDropdown').value || null,
          () => { renderRoutingStatus(); });
      }
    } else if (out.includes('WAIT')) {
      setTimeout((retries, canfail) => {console.log('state from retry wait'); getState(retries - 1, canfail)}, 1500, retries, canfail);
      extendDebug('VPN is connecting, retrying state check...');
    } else {
      const wasConnected = curState === 'CONNECTED';
      curState = 'DISCONNECTED';
      updateStateLabel('DISCONNECTED', 'disconnected');
      setButtonLabel(curState);
      setButtonDisabled(false);
      setDropdownDisabled(false);
      if (wasConnected) {
        VpnSplitService.onVpnDisconnecting(() => renderRoutingStatus());
      }
    }
  } catch (e) {
    if (retries > 0) {
      setTimeout((retries, canfail) => {console.log('state from retry'); getState(retries - 1, canfail)}, 1500,retries, canfail);
      if(!canfail){
        extendDebug(`VPN not responding, retrying state check (${retries} attempts left)...`);
      }
    }
    else {
      curState = 'DISCONNECTED';
      updateStateLabel('DISCONNECTED', 'disconnected');
      setButtonLabel(curState);
      setButtonDisabled(false);
      setDropdownDisabled(false);
      if(!canfail)
      {
        setDebug(e.message);
        showError('Could not connect to management interface.');
      }
    }
  }
}

async function loadProfiles() {
  const dropdown = document.getElementById("configDropdown");
  dropdown.innerHTML = "";
  try {
    const r = await lunaCall("luna://org.webosbrew.hbchannel.service/exec", {
      command:
        `cd ${APP_BASE}/profiles && ls -1 *.ovpn`
    },timeout=15000);
    const files = (r.stdoutString || "")
      .split(/\r?\n/)
      .map((f) => f.trim())
      .filter((f) => f.length > 0);

    if (files.length === 0) {
      const emptyOption = document.createElement("option");
      emptyOption.value = "";
      emptyOption.textContent = "Keine Profile gefunden";
      dropdown.appendChild(emptyOption);
      setDropdownDisabled(true);
      setButtonDisabled(true);
      showError(`No Profiles found in profiles folder. Please make sure to upload .ovpn files into ${APP_BASE}/profiles`);
      return Promise.reject("No Profiles found");
    }

    files.forEach((file) => {
      const option = document.createElement("option");
      option.value = file;
      option.textContent = file.replace(/\.ovpn$/i, "");
      dropdown.appendChild(option);
    });
    extendDebug(`Loaded ${files.length} profile(s).`);
    return Promise.resolve();
  } catch (e) {
    setDropdownDisabled(true);
    setButtonDisabled(true);
    showError("Profiles could not be loaded: " + e.message);
    return Promise.resolve(e); //still resolve, maybe management interface is still up
  }
}

async function connect() {
  const cfg = document.getElementById('configDropdown').value;
  if (!cfg) {
    showError('No Profile found');
    return;
  }
  showError('');
  setButtonDisabled(true);
  setDropdownDisabled(true);
  setDebug('Launching OpenVPN with ' + cfg);
  try {
    await lunaCall('luna://org.webosbrew.hbchannel.service/spawn', { command: `${APP_BASE}/res/openvpn --management 0.0.0.0 ${mgmtPort} --config ${APP_BASE}/profiles/${cfg} --daemon` });
    console.log('state from connect');
    setTimeout(getState,2000);
  } catch (e) {
    setDebug(e.message);
    showError('Start failed ' + e.message);
    setButtonDisabled(false);
    setDropdownDisabled(false);
  }
}
async function disconnect() {
  showError('');
  setButtonDisabled(true);
  setDropdownDisabled(true);
  setDebug('Stopping VPN Connection...');
  try {
    // Tear down routing rules BEFORE the tunnel goes away, otherwise
    // ip route del against a vanished tun0 will quietly no-op.
    await new Promise(res => VpnSplitService.onVpnDisconnecting(res));
    await terminateDaemon();
    setTimeout(async() => {
      console.log('state from disconnect');
      await getState(1, true);
      setDebug('VPN Stopped.');
      renderRoutingStatus();
    }, 2000);
  } catch (e) {
    showError('Stop failed ' + e.message); setButtonDisabled(false);
    setDropdownDisabled(false);
  }
}
function btnClick() { curState === 'CONNECTED' ? disconnect() : connect(); }

async function initVPN() {
  setDebug('Preparing openvpn binary...');
  try {
    await lunaCall('luna://org.webosbrew.hbchannel.service/exec', {
      command: `chmod +x ${APP_BASE}/res/openvpn`
    });
  } catch (e) {
    extendDebug(`Failed to set executable flag: ${e.message}`);
  }
  extendDebug('Checking management interface…');
  console.log('state from initVPN');
  await getState(1, true);
}

// ------------------------- Per-app routing UI -------------------------

async function loadCdnRanges() {
  try {
    const r = await lunaCall('luna://org.webosbrew.hbchannel.service/exec', {
      command: `cat ${CDN_RANGES_PATH}`
    }, 10000);
    cdnRanges = JSON.parse(r.stdoutString || '{"apps":{}}');
  } catch (e) {
    extendDebug(`Failed to load cdn-ranges.json: ${e.message}`);
    cdnRanges = { apps: {} };
  }
}

function loadRoutingConfig() {
  return new Promise(res => {
    VpnSplitService.loadConfig((err, cfg) => {
      if (err) {
        extendDebug(`Failed to load routing config: ${err.message}`);
        routingConfig = { apps: {} };
      } else {
        routingConfig = cfg || { apps: {} };
      }
      res();
    });
  });
}

function persistRoutingConfig() {
  return new Promise(res => {
    VpnSplitService.saveConfig(routingConfig, err => {
      if (err) extendDebug(`Save config failed: ${err.message}`);
      res();
    });
  });
}

// Merge known (seeded) apps with user-added custom app IDs so the list
// always reflects everything the user has interacted with, even when a
// custom app has no CDN ranges configured.
function renderAppList() {
  const list = document.getElementById('appList');
  list.innerHTML = '';

  const seen = new Set();
  const rows = [];

  const knownApps = cdnRanges.apps || {};
  for (const appId of Object.keys(knownApps)) {
    seen.add(appId);
    rows.push({
      appId,
      name: knownApps[appId].name || appId,
      ranges: knownApps[appId].ranges || [],
      custom: false
    });
  }
  for (const appId of Object.keys(routingConfig.apps || {})) {
    if (seen.has(appId)) continue;
    rows.push({
      appId,
      name: appId,
      ranges: [],
      custom: true
    });
  }

  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'app-row';
    li.innerHTML = '<span class="app-name">No apps configured</span>';
    list.appendChild(li);
  }

  rows.forEach(row => {
    const enabled = !!(routingConfig.apps[row.appId] && routingConfig.apps[row.appId].enabled);
    const li = document.createElement('li');
    li.className = 'app-row item' + (enabled ? ' enabled' : '') + (row.custom ? ' custom' : '');
    li.tabIndex = 0;
    li.dataset.appId = row.appId;

    const label = document.createElement('div');
    label.innerHTML =
      `<span class="app-name">${escapeHtml(row.name)}</span>` +
      `<span class="app-id">${escapeHtml(row.appId)}</span>` +
      (row.ranges.length
        ? `<span class="app-ranges">${row.ranges.length} ranges</span>`
        : (row.custom ? '<span class="app-ranges">no ranges — UID mode only</span>' : ''));
    const badge = document.createElement('span');
    badge.className = 'toggle-state';
    badge.innerText = enabled ? 'ON' : 'OFF';

    li.appendChild(label);
    li.appendChild(badge);
    li.addEventListener('click', () => toggleApp(row.appId));
    li.addEventListener('keydown', e => { if (e.keyCode === 13) toggleApp(row.appId); });
    list.appendChild(li);
  });

  SpatialNavigation.makeFocusable();
  eventRegister.add();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function toggleApp(appId) {
  routingConfig.apps = routingConfig.apps || {};
  const current = routingConfig.apps[appId] || { enabled: false };
  current.enabled = !current.enabled;
  routingConfig.apps[appId] = current;
  await persistRoutingConfig();
  renderAppList();
  // If the foreground app is the one we just toggled, apply immediately.
  VpnSplitService.applyForCurrentApp(err => {
    if (err) extendDebug(`apply failed: ${err.message}`);
    renderRoutingStatus();
  });
}

function wireAddApp() {
  const input = document.getElementById('customAppId');
  const btn = document.getElementById('addAppBtn');
  const submit = async () => {
    const raw = (input.value || '').trim();
    if (!raw) return;
    if (!/^[A-Za-z0-9._-]+$/.test(raw)) {
      showError(`Invalid app ID: ${raw}`);
      return;
    }
    showError('');
    routingConfig.apps = routingConfig.apps || {};
    if (!routingConfig.apps[raw]) {
      routingConfig.apps[raw] = { enabled: false };
      await persistRoutingConfig();
      renderAppList();
    }
    input.value = '';
  };
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.keyCode === 13) submit(); });
}

function wireUidModeToggle() {
  const cb = document.getElementById('uidMode');
  const note = document.getElementById('uidModeNote');
  if (xtOwnerAvailable === false) {
    cb.checked = false;
    cb.disabled = true;
    note.hidden = false;
    return;
  }
  cb.addEventListener('change', () => {
    const mode = cb.checked ? 'uid' : 'ip';
    VpnSplitService.setRoutingMode(mode, err => {
      if (err) {
        extendDebug(`Mode switch failed: ${err.message}`);
        cb.checked = !cb.checked; // revert
        return;
      }
      renderRoutingStatus();
    });
  });
}

function renderRoutingStatus() {
  const st = VpnSplitService.getState();
  document.getElementById('routingMode').innerText = st.routingMode;
  document.getElementById('fgAppId').innerText = st.foregroundApp || '—';
}

async function initRouting() {
  await loadCdnRanges();
  await loadRoutingConfig();

  await new Promise(res => {
    VpnSplitService.init({
      exec: execBridge,
      cdnRanges,
      routingConfig,
      routingMode: 'ip'
    }, (err, info) => {
      if (info) xtOwnerAvailable = info.xtOwnerAvailable;
      res();
    });
  });

  VpnSplitService.startAppMonitor((appId, err) => {
    if (err) { extendDebug(`app monitor: ${err.message}`); return; }
    document.getElementById('fgAppId').innerText = appId || '—';
  });

  renderAppList();
  wireAddApp();
  wireUidModeToggle();
  renderRoutingStatus();
}

function launchEvent() {
  SpatialNavigation.init();
  // Include the new app-row elements in spatial navigation so d-pad works.
  SpatialNavigation.add({ selector: '.item' });
  SpatialNavigation.makeFocusable();
  eventRegister.add();
  document.getElementById('cbtn').addEventListener('click', btnClick);
  initVPN().then(() => {
    extendDebug('Loading Profiles, this could take some seconds...');
    loadProfiles().then(()=>{
      extendDebug("Initialization complete.")
    },
    ()=>{
      extendDebug('Failed to load profiles.');
    });
    initRouting().catch(e => extendDebug(`Routing init failed: ${e.message}`));
  });
}


document.addEventListener('webOSLaunch', launchEvent, true);
document.addEventListener('webOSRelaunch', launchEvent, true);
