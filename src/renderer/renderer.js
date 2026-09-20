'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  instances: [],
  selected: null,
  status: {},
  general: {}
};

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
      (instance.settings.enabled ? '' : 'off - ') + stateText(instance);
    meta.appendChild(sub);

    li.appendChild(meta);

    li.addEventListener('click', () => {
      state.selected = instance.serial;
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
  $('detail-serial').textContent =
    instance.serial +
    (instance.index === null ? '' : '  -  instance ' + instance.index);

  const badge = $('detail-state');
  badge.textContent = stateText(instance);
  badge.className = 'state-badge ' + stateClass(instance.state);

  $('enabled').checked = Boolean(instance.settings.enabled);

  setValue($('join-url'), instance.settings.joinUrl || '');
  setValue($('package'), instance.settings.package || '');
  setValue($('launch-component'), instance.settings.launchComponent || '');

  $('stat-reconnects').textContent = String(instance.reconnects || 0);
  $('stat-last').textContent = timeAgo(instance.lastReconnect);

  $('rejoin-btn').disabled =
    !state.status.running || !instance.settings.joinUrl || instance.reconnecting;
}

function renderStatus() {
  const status = state.status;

  const power = $('power-btn');
  power.textContent = status.running ? 'Stop watching' : 'Start watching';
  power.classList.toggle('on', Boolean(status.running));

  const env = $('env-line');

  if (!status.adbFound) {
    env.textContent = 'MuMuPlayer not found - set the folder in Settings.';
    env.style.color = 'var(--bad)';
  } else {
    env.textContent = status.running
      ? 'Watching - ' + status.mumuRoot
      : 'Ready - ' + status.mumuRoot;
    env.style.color = '';
  }

  $('mumu-root').value = status.mumuRoot || '';

  const version = status.mumuVersion ? ' ' + status.mumuVersion : '';

  $('root-hint').textContent = status.adbFound
    ? status.managerFound
      ? 'MuMuPlayer' + version + ' detected.'
      : 'Found ADB' + version + ' but not MuMuManager. Instance names may be missing.'
    : 'Pick the folder that holds nx_device and nx_main.';

  renderDetail();
}

function appendLog(entry) {
  const log = $('log');
  const li = document.createElement('li');

  li.className = entry.level || 'info';

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = entry.time.slice(11, 19) + ' ';
  li.appendChild(time);

  if (entry.label) {
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = '[' + entry.label + '] ';
    li.appendChild(label);
  }

  li.appendChild(document.createTextNode(entry.message));

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

let saveTimer = null;

function saveInstance(patch, { immediate = false } = {}) {
  const instance = currentInstance();

  if (!instance) {
    return;
  }

  const key = instance.key;

  Object.assign(instance.settings, patch);

  clearTimeout(saveTimer);

  const commit = () => window.api.saveInstance(key, patch);

  if (immediate) {
    commit();
  } else {
    saveTimer = setTimeout(commit, 400);
  }
}

let generalTimer = null;

function saveGeneral(patch, { immediate = false } = {}) {
  Object.assign(state.general, patch);

  clearTimeout(generalTimer);

  const commit = () => window.api.saveGeneral(patch);

  if (immediate) {
    commit();
  } else {
    generalTimer = setTimeout(commit, 400);
  }
}

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

  // Settings modal
  $('settings-btn').addEventListener('click', () => {
    fillGeneral();
    $('settings-modal').classList.remove('hidden');
  });

  $('settings-close').addEventListener('click', () => {
    $('settings-modal').classList.add('hidden');
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

  window.api.onLog(appendLog);

  window.api.onInstances((list) => {
    state.instances = list;

    if (state.selected && !currentInstance()) {
      state.selected = null;
    }

    if (!state.selected && list.length === 1) {
      state.selected = list[0].serial;
    }

    renderInstances();
    renderDetail();
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

  fillGeneral();
  renderStatus();
  renderInstances();
  renderDetail();

  // Keep "last reconnect" honest without a push from the main process.
  setInterval(renderDetail, 5000);
}

boot();
