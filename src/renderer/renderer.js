'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  instances: [],
  selected: null,
  status: {},
  general: {}
};

// Activity pane: hide routine chatter so a problem is not buried.
let problemsOnly = false;

// See the onLog subscription in wire().
let logReady = false;
let pendingLogs = [];
let applyAllTimer = null;

// ------------------------------------------------------------------
//  Helpers
// ------------------------------------------------------------------

function currentInstance() {
  return state.instances.find((item) => item.serial === state.selected) || null;
}

function stateClass(value) {
  return String(value || 'unknown').toLowerCase();
}

function stateText(instance) {
  if (instance.detail) {
    return instance.detail;
  }

  return instance.state;
}

function timeAgo(stamp) {
  if (!stamp) {
    return 'never';
  }

  const seconds = Math.round((Date.now() - stamp) / 1000);

  if (seconds < 60) {
    return seconds + 's ago';
  }

  if (seconds < 3600) {
    return Math.round(seconds / 60) + 'm ago';
  }

  return Math.round(seconds / 3600) + 'h ago';
}

/** Never fight the user for a field they are typing in. */
function setValue(input, value) {
  if (document.activeElement !== input) {
    input.value = value;
  }
}

// ------------------------------------------------------------------
//  Rendering
// ------------------------------------------------------------------

function renderInstances() {
  const list = $('instance-list');

  list.textContent = '';

  $('instance-count').textContent = String(state.instances.length);
  $('instance-empty').classList.toggle('hidden', state.instances.length > 0);

  for (const instance of state.instances) {
    const li = document.createElement('li');

    li.dataset.serial = instance.serial;

    if (instance.serial === state.selected) {
      li.classList.add('active');
    }

    // Not being watched - still listed, but it should not read as live.
    if (!instance.settings.enabled) {
      li.classList.add('off');
    }

    const dot = document.createElement('span');
    dot.className = 'dot ' + stateClass(instance.state);
    li.appendChild(dot);

    const meta = document.createElement('div');
    meta.className = 'meta';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = instance.name;
    meta.appendChild(name);

    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent =
      (instance.settings.enabled ? '' : 'Off · ') + stateText(instance);
    meta.appendChild(sub);

    li.appendChild(meta);

    li.addEventListener('click', () => {
      state.selected = instance.serial;
      state.selectedKey = instance.key;
      renderInstances();
      renderDetail();
    });

    list.appendChild(li);
  }
}

function renderDetail() {
  const instance = currentInstance();

  $('detail-empty').classList.toggle('hidden', Boolean(instance));
  $('detail-body').classList.toggle('hidden', !instance);

  if (!instance) {
    return;
  }

  $('detail-name').textContent = instance.name;
  // A placeholder for a down instance has no ADB address to show yet.
  $('detail-serial').textContent = instance.offline
    ? 'not running · instance ' + instance.index
    : instance.serial +
      (instance.index === null ? '' : ' · instance ' + instance.index);

  const badge = $('detail-state');
  badge.textContent = stateText(instance);
  badge.className = 'state-badge ' + stateClass(instance.state);

  $('enabled').checked = Boolean(instance.settings.enabled);
  $('relaunch').checked = Boolean(instance.settings.relaunchMuMu);

  setValue($('join-url'), instance.settings.joinUrl || '');
  setValue($('package'), instance.settings.package || '');
  setValue($('launch-component'), instance.settings.launchComponent || '');

  $('stat-reconnects').textContent = String(instance.reconnects || 0);
  $('stat-last').textContent = timeAgo(instance.lastReconnect);

  $('rejoin-btn').disabled =
    !state.status.running ||
    !instance.settings.joinUrl ||
    instance.reconnecting ||
    Boolean(instance.offline);
}

/**
 * The title bar's status word. The install path is useful once and
 * noise every other time, so it lives in the tooltip.
 */
function renderRunState() {
  const status = state.status;
  const env = $('env-line');
  const dot = $('run-dot');

  let text;
  let tone;

  if (!status.adbFound) {
    text = 'MuMuPlayer not found';
    tone = 'bad';
  } else if (status.running) {
    // Instances waiting on a relaunch are listed but not running.
    const count = state.instances.filter((item) => !item.offline).length;
    text = 'Watching · ' + count + (count === 1 ? ' instance' : ' instances');
    tone = 'good';
  } else {
    text = 'Stopped';
    tone = 'idle';
  }

  env.textContent = text;
  env.title = status.mumuRoot || 'Set the MuMuPlayer folder in Settings';
  dot.setAttribute('class', 'run-dot ' + tone);
}

function renderStatus() {
  const status = state.status;

  const power = $('power-btn');
  power.textContent = status.running ? 'Stop watching' : 'Start watching';
  power.classList.toggle('on', Boolean(status.running));

  renderRunState();

  $('mumu-root').textContent = status.mumuRoot || 'Not set';
  $('mumu-root').title = status.mumuRoot || '';

  const version = status.mumuVersion ? ' ' + status.mumuVersion : '';

  $('root-hint').textContent = status.adbFound
    ? status.managerFound
      ? 'MuMuPlayer' + version + ' detected.'
      : 'Found ADB' + version + ' but not MuMuManager. Instance names may be missing.'
    : 'Pick the folder that holds nx_device and nx_main.';

  renderDetail();
}

/** Swap the maximise glyph for a restore one, and the tooltip with it. */
function setMaximized(maximized) {
  const button = $('win-max');

  button.classList.toggle('maximized', Boolean(maximized));
  button.title = maximized ? 'Restore' : 'Maximize';
  button.setAttribute('aria-label', button.title);
}

function isProblem(li) {
  return li.dataset.level === 'warn' || li.dataset.level === 'error';
}

function setLogFilter(onlyProblems) {
  problemsOnly = onlyProblems;

  $('filter-all').classList.toggle('active', !onlyProblems);
  $('filter-problems').classList.toggle('active', onlyProblems);
  $('filter-all').setAttribute('aria-pressed', String(!onlyProblems));
  $('filter-problems').setAttribute('aria-pressed', String(onlyProblems));

  // Re-apply to rows already on screen, not just new ones.
  for (const li of $('log').children) {
    li.classList.toggle('filtered', onlyProblems && !isProblem(li));
  }
}

function setLogCollapsed(collapsed) {
  $('logpane').classList.toggle('collapsed', collapsed);
  $('log-toggle').setAttribute('aria-expanded', String(!collapsed));
  writePref('logCollapsed', collapsed ? '1' : '0');
}

// Per-window conveniences only. Storage can be unavailable, so every
// access is guarded and the UI works the same without it.
function readPref(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (err) {
    return null;
  }
}

function writePref(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (err) {
    /* not remembered, which is fine */
  }
}

function appendLog(entry) {
  const log = $('log');
  const li = document.createElement('li');
  const level = entry.level || 'info';

  li.className = level;
  li.dataset.level = level;

  // Three aligned columns - when, which instance, what happened - read
  // far more easily than one run-on line per event.
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = entry.time.slice(11, 19);
  time.title = new Date(entry.time).toLocaleString();
  li.appendChild(time);

  // Labels arrive as "6:fuzzalt". The index is noise here; the name is
  // what anyone recognises.
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = entry.label ? String(entry.label).replace(/^\d+:/, '') : '';
  li.appendChild(who);

  const message = document.createElement('span');
  message.className = 'msg';
  message.textContent = entry.message;
  li.appendChild(message);

  if (problemsOnly && !isProblem(li)) {
    li.classList.add('filtered');
  }

  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;

  log.appendChild(li);

  while (log.childElementCount > 400) {
    log.removeChild(log.firstElementChild);
  }

  if (atBottom) {
    log.scrollTop = log.scrollHeight;
  }
}

// ------------------------------------------------------------------
//  Saving
// ------------------------------------------------------------------

// Saves are debounced, so edits made close together are merged rather
// than replaced. With a single "latest patch" two quick edits lost the
// first one - including an edit on one instance followed by an edit on
// another, which dropped the first instance's change entirely.

let saveTimer = null;
const pendingInstances = new Map();

function flushInstances() {
  clearTimeout(saveTimer);

  for (const [key, patch] of pendingInstances) {
    window.api.saveInstance(key, patch);
  }

  pendingInstances.clear();
}

function saveInstance(patch, { immediate = false } = {}) {
  const instance = currentInstance();

  if (!instance) {
    return;
  }

  Object.assign(instance.settings, patch);

  pendingInstances.set(instance.key, {
    ...(pendingInstances.get(instance.key) || {}),
    ...patch
  });

  clearTimeout(saveTimer);

  if (immediate) {
    flushInstances();
  } else {
    saveTimer = setTimeout(flushInstances, 400);
  }
}

let generalTimer = null;
let pendingGeneral = {};

function flushGeneral() {
  clearTimeout(generalTimer);

  if (Object.keys(pendingGeneral).length) {
    window.api.saveGeneral(pendingGeneral);
    pendingGeneral = {};
  }
}

function saveGeneral(patch, { immediate = false } = {}) {
  Object.assign(state.general, patch);
  Object.assign(pendingGeneral, patch);

  clearTimeout(generalTimer);

  if (immediate) {
    flushGeneral();
  } else {
    generalTimer = setTimeout(flushGeneral, 400);
  }
}

// Closing within the debounce window would otherwise drop the last edit.
window.addEventListener('beforeunload', () => {
  flushInstances();
  flushGeneral();
});

// ------------------------------------------------------------------
//  Wiring
// ------------------------------------------------------------------

const NUMERIC_SETTINGS = [
  'checkInterval',
  'discoveryInterval',
  'loadingGrace',
  'reconnectCooldown',
  'startTimeout',
  'maxAttempts'
];

function fillGeneral() {
  for (const key of NUMERIC_SETTINGS) {
    setValue($(key), state.general[key]);
  }

  $('autoStart').checked = Boolean(state.general.autoStart);
  $('minimizeToTray').checked = Boolean(state.general.minimizeToTray);
}

function wire() {
  $('power-btn').addEventListener('click', async () => {
    $('power-btn').disabled = true;

    state.status = state.status.running
      ? await window.api.stop()
      : await window.api.start();

    $('power-btn').disabled = false;

    renderStatus();
  });

  $('rejoin-btn').addEventListener('click', () => {
    const instance = currentInstance();

    if (instance) {
      window.api.reconnectNow(instance.serial);
    }
  });

  $('relaunch').addEventListener('change', (event) => {
    saveInstance({ relaunchMuMu: event.target.checked }, { immediate: true });
  });

  $('enabled').addEventListener('change', (event) => {
    saveInstance({ enabled: event.target.checked }, { immediate: true });
    renderInstances();
  });

  $('join-url').addEventListener('input', (event) => {
    saveInstance({ joinUrl: event.target.value.trim() });
  });

  $('package').addEventListener('input', (event) => {
    saveInstance({ package: event.target.value.trim() });
  });

  $('launch-component').addEventListener('input', (event) => {
    saveInstance({ launchComponent: event.target.value.trim() });
  });

  $('rejoin-all').addEventListener('click', async (event) => {
    const button = event.target;

    button.disabled = true;

    try {
      await window.api.reconnectAll();
    } finally {
      button.disabled = false;
    }
  });

  $('apply-all').addEventListener('click', async () => {
    const url = $('join-url').value.trim();

    if (!url) {
      return;
    }

    const count = await window.api.applyUrlToAll(url);
    const done = $('apply-all-done');

    done.textContent = 'Applied to ' + count + ' instance(s)';
    done.classList.remove('hidden');

    clearTimeout(applyAllTimer);
    applyAllTimer = setTimeout(() => done.classList.add('hidden'), 2500);
  });

  $('filter-all').addEventListener('click', () => setLogFilter(false));
  $('filter-problems').addEventListener('click', () => setLogFilter(true));

  $('log-toggle').addEventListener('click', () => {
    setLogCollapsed(!$('logpane').classList.contains('collapsed'));
  });

  setLogCollapsed(readPref('logCollapsed') === '1');

  $('reset-timing').addEventListener('click', async () => {
    flushGeneral();
    state.general = await window.api.resetTiming();
    fillGeneral();
  });

  // Update banner. Only ever shown when a newer release really exists.
  window.api.onUpdate((update) => {
    $('update-text').textContent =
      'Version ' + update.latest + ' is available. You are on ' +
      update.current + '.';

    $('update-link').onclick = () => window.api.openExternal(update.url);
    $('update-banner').classList.remove('hidden');
  });

  $('update-dismiss').addEventListener('click', () => {
    $('update-banner').classList.add('hidden');
  });

  // Window controls (the window is frameless)
  $('win-min').addEventListener('click', () => window.api.minimizeWindow());

  $('win-max').addEventListener('click', async () => {
    setMaximized(await window.api.toggleMaximize());
  });

  $('win-close').addEventListener('click', () => window.api.closeWindow());

  window.api.onMaximized(setMaximized);
  window.api.isMaximized().then(setMaximized);

  // Settings modal
  $('settings-btn').addEventListener('click', () => {
    fillGeneral();
    $('settings-modal').classList.remove('hidden');
  });

  $('settings-close').addEventListener('click', () => {
    $('settings-modal').classList.add('hidden');
  });

  $('selfcheck-btn').addEventListener('click', async (event) => {
    const button = event.target;

    button.disabled = true;
    button.textContent = 'Checking...';

    try {
      // The report is written straight to the log, so close the modal
      // and let them watch it land in Activity.
      await window.api.diagnose();
      $('settings-modal').classList.add('hidden');
    } finally {
      button.disabled = false;
      button.textContent = 'Run self-check';
    }
  });

  $('settings-modal').addEventListener('click', (event) => {
    if (event.target === $('settings-modal')) {
      $('settings-modal').classList.add('hidden');
    }
  });

  for (const key of NUMERIC_SETTINGS) {
    $(key).addEventListener('input', (event) => {
      const value = Number.parseInt(event.target.value, 10);

      if (!Number.isNaN(value) && value > 0) {
        saveGeneral({ [key]: value });
      }
    });
  }

  $('autoStart').addEventListener('change', (event) => {
    saveGeneral({ autoStart: event.target.checked }, { immediate: true });
  });

  $('minimizeToTray').addEventListener('change', (event) => {
    saveGeneral({ minimizeToTray: event.target.checked }, { immediate: true });
  });

  $('browse-root').addEventListener('click', async () => {
    const result = await window.api.browseMuMuRoot();

    if (!result) {
      return;
    }

    if (result.error) {
      $('root-hint').textContent = result.error;
      return;
    }

    state.status = result;
    renderStatus();
  });

  $('open-logs').addEventListener('click', () => window.api.openLogs());

  $('clear-log').addEventListener('click', () => {
    $('log').textContent = '';
  });

  // Lines can be emitted after this subscribes but before bootstrap
  // answers, and those arrive twice: live, and again in the history.
  // Hold live lines until the history is on screen, then keep only the
  // ones newer than it.
  window.api.onLog((entry) => {
    if (logReady) {
      appendLog(entry);
    } else {
      pendingLogs.push(entry);
    }
  });

  window.api.onInstances((list) => {
    state.instances = list;

    // A relaunched instance comes back under a new serial (its placeholder
    // was "mumu:N"), so follow it by name rather than losing the selection.
    if (state.selected && !currentInstance()) {
      const same = list.find((item) => item.key === state.selectedKey);
      state.selected = same ? same.serial : null;
    }

    if (!state.selected && list.length === 1) {
      state.selected = list[0].serial;
      state.selectedKey = list[0].key;
    }

    renderInstances();
    renderDetail();
    renderRunState();
  });

  window.api.onStatus((status) => {
    state.status = status;
    renderStatus();
  });
}

async function boot() {
  wire();

  const data = await window.api.bootstrap();

  state.status = data.status;
  state.general = data.general;
  state.instances = data.instances;

  for (const entry of data.logs) {
    appendLog(entry);
  }

  const lastId = data.logs.length ? data.logs[data.logs.length - 1].id : 0;

  for (const entry of pendingLogs) {
    if (entry.id > lastId) {
      appendLog(entry);
    }
  }

  pendingLogs = [];
  logReady = true;

  fillGeneral();
  renderStatus();
  renderInstances();
  renderDetail();

  // Keep "last reconnect" honest without a push from the main process.
  setInterval(renderDetail, 5000);
}

boot();
