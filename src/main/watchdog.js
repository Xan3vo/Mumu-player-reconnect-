'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { Adb } = require('./adb');
const { RobloxProbe } = require('./roblox');
const mumu = require('./mumu');
const paths = require('./paths');

const LOG_MAX_BYTES = 2 * 1024 * 1024;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The engine. Owns instance discovery, one monitor loop per instance,
 * and the reconnect logic. It never touches Electron, so the UI is free
 * to be replaced or driven from a headless script.
 *
 * Emits:
 *   "log"       { time, level, label, message }
 *   "instances" [ instance snapshots ]
 *   "status"    { running, mumuRoot, adbPath, adbFound, managerFound }
 */
class Watchdog extends EventEmitter {
  constructor(store, logDir) {
    super();

    this.store = store;
    this.logFile = logDir ? path.join(logDir, 'mumu-reconnect.log') : null;

    this.adb = new Adb('');
    this.probe = new RobloxProbe(this.adb);

    this.running = false;
    this.instances = new Map();
    this.logBuffer = [];

    this.refreshPaths();
  }

  // ---------------------------------------------------------------
  //  Paths
  // ---------------------------------------------------------------

  refreshPaths() {
    const configured = this.store.getMuMuRoot();

    this.mumuRoot =
      configured && paths.isMuMuRoot(configured)
        ? configured
        : paths.detectMuMuRoot();

    this.adbPath = this.mumuRoot ? paths.adbPathFor(this.mumuRoot) : '';
    this.managerPath = this.mumuRoot ? paths.managerPathFor(this.mumuRoot) : '';

    this.adb.setPath(this.adbPath);

    return this.getStatus();
  }

  getStatus() {
    return {
      running: this.running,
      mumuRoot: this.mumuRoot,
      adbPath: this.adbPath,
      adbFound: Boolean(this.adbPath && fs.existsSync(this.adbPath)),
      mumuVersion: this.mumuRoot ? paths.versionFor(this.mumuRoot) : '',
      managerFound: Boolean(this.managerPath && fs.existsSync(this.managerPath)),
      configuredRoot: this.store.getMuMuRoot()
    };
  }

  emitStatus() {
    this.emit('status', this.getStatus());
  }

  // ---------------------------------------------------------------
  //  Logging
  // ---------------------------------------------------------------

  log(message, { label = null, level = 'info' } = {}) {
    const entry = {
      time: new Date().toISOString(),
      level,
      label,
      message
    };

    this.logBuffer.push(entry);

    if (this.logBuffer.length > 500) {
      this.logBuffer.splice(0, this.logBuffer.length - 500);
    }

    this.emit('log', entry);

    if (!this.logFile) {
      return;
    }

    try {
      const stamp = entry.time.replace('T', ' ').slice(0, 19);
      const line = label
        ? '[' + stamp + '] [' + label + '] ' + message
        : '[' + stamp + '] ' + message;

      if (fs.existsSync(this.logFile)) {
        const { size } = fs.statSync(this.logFile);

        if (size > LOG_MAX_BYTES) {
          fs.renameSync(this.logFile, this.logFile + '.1');
        }
      }

      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, line + '\n', 'utf8');
    } catch (err) {
      /* logging must never break the run */
    }
  }

  history() {
    return this.logBuffer.slice();
  }

  // ---------------------------------------------------------------
  //  Snapshots for the UI
  // ---------------------------------------------------------------

  snapshot() {
    return [...this.instances.values()]
      .map((info) => ({
        serial: info.serial,
        key: info.key,
        index: info.index,
        name: info.name,
        state: info.state,
        detail: info.detail,
        lastReconnect: info.lastReconnect,
        reconnecting: info.reconnecting,
        reconnects: info.reconnects,
        settings: this.store.getInstance(info.key)
      }))
      .sort((a, b) => {
        const left = a.index === null ? 99 : a.index;
        const right = b.index === null ? 99 : b.index;
        return left - right;
      });
  }

  emitInstances() {
    this.emit('instances', this.snapshot());
  }

  labelFor(serial) {
    const info = this.instances.get(serial);

    if (!info) {
      return serial;
    }

    return info.index === null ? info.name : info.index + ':' + info.name;
  }

  setState(serial, state, detail) {
    const info = this.instances.get(serial);

    if (!info) {
      return;
    }

    const changed = info.state !== state || info.detail !== detail;

    info.state = state;

    if (detail !== undefined) {
      info.detail = detail;
    }

    if (changed) {
      this.emitInstances();
    }
  }

  // ---------------------------------------------------------------
  //  Lifecycle
  // ---------------------------------------------------------------

  async start() {
    if (this.running) {
      return this.getStatus();
    }

    this.refreshPaths();

    if (!this.getStatus().adbFound) {
      this.log('Could not find MuMuPlayer. Set the install folder in Settings.', {
        level: 'error'
      });

      this.emitStatus();

      return this.getStatus();
    }

    this.running = true;
    this.emitStatus();

    this.log('Watching for MuMu instances.');

    const server = await this.adb.startServer();

    // A different ADB (Android Studio, another emulator) already holding
    // port 5037 makes MuMu's adb talk to a server it cannot drive. The
    // symptom is "no instances" with no other clue, so name it.
    if (/version|killing|out of date/i.test(server.stderr || '')) {
      this.log(
        'Another ADB server is already running and may hide instances. ' +
          'Close other emulators or Android tools if nothing is found.',
        { level: 'warn' }
      );
    }

    this.discoveryLoop();

    return this.getStatus();
  }

  stop() {
    if (!this.running) {
      return this.getStatus();
    }

    this.running = false;

    for (const info of this.instances.values()) {
      info.state = 'STOPPED';
      info.detail = 'Not watching';
    }

    this.log('Stopped.');
    this.emitInstances();
    this.emitStatus();

    return this.getStatus();
  }

  // ---------------------------------------------------------------
  //  Discovery
  // ---------------------------------------------------------------

  async discoverOnce() {
    let records = await mumu.queryManager(this.managerPath);

    const fromManager = records !== null;

    if (!fromManager) {
      this.log('MuMuManager unavailable - falling back to port probing.', {
        level: 'warn'
      });

      records = await mumu.probePorts(this.adb);
    }

    const online = await this.adb.onlineDevices();

    const live = [];

    for (const record of records) {
      if (!record.started || !record.serial) {
        continue;
      }

      // Cloned instances never register themselves with the ADB server,
      // so connect explicitly before deciding one is missing.
      if (!online.has(record.serial)) {
        const connected = await this.adb.connect(record.serial);

        if (!connected) {
          continue;
        }
      }

      live.push(record);
    }

    // Every instance is ALSO reachable under a classic emulator-NNNN
    // serial. Those are the same emulators, not extra ones - registering
    // them would start a second monitor per instance, and the two would
    // fight: one force-stops Roblox while the other is mid-launch.
    // MuMuManager already lists everything, so when it answered there is
    // nothing left to find.
    if (fromManager) {
      return live;
    }

    const claimed = new Set(live.map((record) => record.serial));
    const strays = [...(await this.adb.onlineDevices())].sort();

    for (const serial of strays) {
      if (claimed.has(serial)) {
        continue;
      }

      live.push({ index: null, name: serial, started: true, serial });
    }

    return live;
  }

  async discoveryLoop() {
    let lastSummary = null;

    while (this.running) {
      try {
        const live = await this.discoverOnce();
        const bySerial = new Map(live.map((record) => [record.serial, record]));

        for (const [serial, record] of bySerial) {
          if (!this.instances.has(serial)) {
            this.registerInstance(record);
          }
        }

        for (const serial of [...this.instances.keys()]) {
          if (!bySerial.has(serial)) {
            this.unregisterInstance(serial);
          }
        }

        const summary = [...bySerial.keys()]
          .map((serial) => this.labelFor(serial))
          .sort()
          .join(', ');

        if (summary !== lastSummary) {
          this.log(
            summary
              ? 'Found ' + bySerial.size + ' running instance(s): ' + summary
              : 'No running MuMu instances found.'
          );

          lastSummary = summary;
        }

        this.emitInstances();
      } catch (err) {
        this.log('Discovery error: ' + err.message, { level: 'error' });
      }

      await sleep(this.store.getGeneral().discoveryInterval * 1000);
    }
  }

  registerInstance(record) {
    const info = {
      serial: record.serial,
      key: record.name,
      index: record.index === undefined ? null : record.index,
      name: record.name,
      state: 'UNKNOWN',
      detail: 'Checking...',
      lastState: 'UNKNOWN',
      waitingSince: 0,
      lastReconnect: 0,
      reconnecting: false,
      reconnects: 0
    };

    this.instances.set(record.serial, info);

    this.log('Instance connected.', { label: this.labelFor(record.serial) });

    this.monitorLoop(record.serial);
  }

  unregisterInstance(serial) {
    const label = this.labelFor(serial);

    this.instances.delete(serial);
    this.probe.forget(serial);

    this.log('Instance disconnected.', { label });
    this.emitInstances();
  }

  // ---------------------------------------------------------------
  //  Monitoring
  // ---------------------------------------------------------------

  async monitorLoop(serial) {
    while (this.running && this.instances.has(serial)) {
      const general = this.store.getGeneral();

      try {
        await this.checkInstance(serial, general);
      } catch (err) {
        this.log('Check failed: ' + err.message, {
          label: this.labelFor(serial),
          level: 'error'
        });
      }

      await sleep(general.checkInterval * 1000);
    }
  }

  async checkInstance(serial, general) {
    const info = this.instances.get(serial);

    if (!info) {
      return;
    }

    // Don't interfere with a reconnect that is already under way.
    if (info.reconnecting) {
      return;
    }

    const settings = this.store.getInstance(info.key);
    const state = await this.probe.getState(serial, settings.package);

    // Without the socket check every session looks like a game, so a
    // stuck instance would never be rejoined. Say so once.
    if (this.probe.isDegraded(serial) && !info.degradedLogged) {
      info.degradedLogged = true;

      this.log(
        'Cannot read the network state on this instance, so being in a ' +
          'game cannot be confirmed - rejoins will not trigger here.',
        { label: this.labelFor(serial), level: 'warn' }
      );
    }

    if (state === 'UNKNOWN') {
      // Busy or still booting. Stay quiet and retry rather than
      // restarting a healthy game.
      this.setState(serial, 'UNKNOWN', 'Emulator not responding');
      return;
    }

    const previous = info.lastState;

    info.lastState = state;

    if (state === 'GAME') {
      info.waitingSince = 0;
      this.setState(serial, 'GAME', 'In a game');

      if (previous !== 'GAME') {
        this.log('In a game.', { label: this.labelFor(serial) });
      }

      return;
    }

    if (!settings.enabled) {
      this.setState(
        serial,
        state,
        state === 'OTHER' ? 'Roblox not in front' : 'Not in a game'
      );

      return;
    }

    if (!settings.joinUrl) {
      this.setState(serial, state, 'No game link set');
      return;
    }

    // Roblox is up but not in a game. That covers the loading screen, a
    // join in progress, and being dumped back on the home screen after a
    // disconnect. Give it room to finish rather than killing it mid-join.
    if (state === 'LOADING' || state === 'MENU') {
      if (!info.waitingSince) {
        info.waitingSince = Date.now();
      }

      const stuckFor = (Date.now() - info.waitingSince) / 1000;

      if (stuckFor < general.loadingGrace) {
        const detail =
          state === 'LOADING'
            ? 'Loading, waiting'
            : 'On the home screen (' + Math.round(stuckFor) + 's)';

        this.setState(serial, state, detail);

        if (previous !== state) {
          this.log(
            state === 'LOADING'
              ? 'Roblox is loading. Waiting.'
              : 'Roblox is on the home screen, not in a game. Waiting.',
            { label: this.labelFor(serial) }
          );
        }

        return;
      }

      this.log('Out of game for ' + Math.round(stuckFor) + 's.', {
        label: this.labelFor(serial)
      });
    } else if (previous !== 'OTHER') {
      this.log('Roblox is no longer in front.', {
        label: this.labelFor(serial)
      });
    }

    await this.reconnect(serial, general, settings);
  }

  // ---------------------------------------------------------------
  //  Reconnect
  // ---------------------------------------------------------------

  async reconnect(serial, general, settings, { manual = false } = {}) {
    const info = this.instances.get(serial);

    if (!info) {
      return;
    }

    // Never run two reconnects for one instance at the same time. They
    // would force-stop Roblox while the other is mid-launch and keep
    // each other from ever finishing.
    if (info.reconnecting) {
      return;
    }

    const now = Date.now();

    if (!manual && now - info.lastReconnect < general.reconnectCooldown * 1000) {
      return;
    }

    if (!settings.joinUrl) {
      this.log('No game link set for this instance.', {
        label: this.labelFor(serial),
        level: 'warn'
      });

      return;
    }

    info.lastReconnect = now;
    info.reconnecting = true;

    const label = this.labelFor(serial);

    this.setState(serial, 'RECONNECTING', 'Reconnecting...');
    this.log('Starting reconnect.', { label });

    let success = false;

    try {
      for (let attempt = 1; attempt <= general.maxAttempts; attempt += 1) {
        if (!this.running || !this.instances.has(serial)) {
          return;
        }

        this.log('Attempt ' + attempt + ' of ' + general.maxAttempts + '.', {
          label
        });

        this.setState(
          serial,
          'RECONNECTING',
          'Attempt ' + attempt + ' of ' + general.maxAttempts
        );

        // If Roblox came back on its own, leave it alone.
        const current = await this.probe.getState(serial, settings.package);

        if (current === 'GAME') {
          this.log('Back in a game already. Cancelling reconnect.', { label });
          success = true;
          break;
        }

        const died = await this.probe.forceStopAndWait(
          serial,
          settings.package
        );

        if (!died) {
          this.log(
            'Roblox did not shut down in time. Launching anyway, which ' +
              'may land on the home screen.',
            { label, level: 'warn' }
          );
        }

        // Aim the intent straight at Roblox first. Without this the link
        // lands in the built-in browser on any instance where Roblox is
        // not the default handler for roblox.com, and nothing starts.
        let launch = await this.probe.sendLaunchIntent(
          serial,
          settings.joinUrl,
          settings.launchComponent
        );

        if (!launch.ok) {
          this.log('Direct launch failed. Retrying without a component.', {
            label,
            level: 'warn'
          });

          launch = await this.probe.sendLaunchIntent(serial, settings.joinUrl);
        }

        if (!launch.ok) {
          this.log(
            'Could not send the launch command. ' +
              (launch.stderr || launch.stdout),
            { label, level: 'error' }
          );

          await sleep(5000);
          continue;
        }

        if (await this.waitForGame(serial, settings, general)) {
          success = true;
          break;
        }

        this.log('Roblox did not reach a game.', { label, level: 'warn' });

        if (attempt < general.maxAttempts) {
          await sleep(5000);
        }
      }

      if (success) {
        info.reconnects += 1;
        this.log('Reconnected.', { label });
        this.setState(serial, 'GAME', 'In a game');
      } else {
        this.log('Attempts exhausted. Will retry later.', {
          label,
          level: 'warn'
        });

        this.setState(serial, 'MENU', 'Could not rejoin');
      }
    } finally {
      const still = this.instances.get(serial);

      if (still) {
        still.reconnecting = false;
        still.waitingSince = 0;
        still.lastReconnect = Date.now();
      }

      this.emitInstances();
    }
  }

  async waitForGame(serial, settings, general) {
    const label = this.labelFor(serial);

    this.log('Waiting up to ' + general.startTimeout + 's for a game.', {
      label
    });

    const start = Date.now();

    while (this.running && this.instances.has(serial)) {
      const elapsed = (Date.now() - start) / 1000;
      const state = await this.probe.getState(serial, settings.package);

      if (state === 'GAME') {
        this.log('In a game after ' + Math.round(elapsed) + 's.', { label });
        return true;
      }

      if (elapsed >= general.startTimeout) {
        return false;
      }

      this.setState(
        serial,
        'RECONNECTING',
        'Joining... ' + Math.round(elapsed) + 's'
      );

      await sleep(2000);
    }

    return false;
  }

  /** Manual "rejoin now" button. Ignores the cooldown. */
  async reconnectNow(serial) {
    const info = this.instances.get(serial);

    if (!info) {
      return false;
    }

    await this.reconnect(
      serial,
      this.store.getGeneral(),
      this.store.getInstance(info.key),
      { manual: true }
    );

    return true;
  }

  // ---------------------------------------------------------------
  //  Self-check
  // ---------------------------------------------------------------

  /**
   * Walk the whole detection chain on this PC and report each step.
   *
   * Everything the watchdog depends on varies between machines: where
   * MuMu is installed, which emulator build it ships, whether the
   * Android image lets the shell user read /proc/net. When it does not
   * work on someone's setup, this says which link broke instead of
   * leaving them with an app that quietly never rejoins.
   */
  async diagnose() {
    const steps = [];

    const ok = (name, detail) => steps.push({ name, status: 'ok', detail });
    const bad = (name, detail) => steps.push({ name, status: 'bad', detail });
    const warn = (name, detail) => steps.push({ name, status: 'warn', detail });

    this.refreshPaths();

    const status = this.getStatus();

    if (!status.mumuRoot) {
      bad('MuMuPlayer', 'Not found. Set the folder in Settings.');
      return this.reportDiagnosis(steps);
    }

    ok('MuMuPlayer', status.mumuRoot);

    if (status.adbFound) {
      ok('Emulator build', status.mumuVersion || 'unknown');
    } else {
      bad('Emulator build', 'No adb.exe under nx_device.');
      return this.reportDiagnosis(steps);
    }

    if (status.managerFound) {
      ok('MuMuManager', 'Found.');
    } else {
      warn('MuMuManager', 'Missing. Instance names fall back to ports.');
    }

    await this.adb.startServer();

    const records = await mumu.queryManager(this.managerPath);
    const list = records === null ? await mumu.probePorts(this.adb) : records;
    const started = list.filter((r) => r.started && r.serial);

    if (!started.length) {
      warn('Instances', 'None running. Start one and run this again.');
      return this.reportDiagnosis(steps);
    }

    ok('Instances', started.length + ' running.');

    const target = started[0];
    const serial = target.serial;

    if (!(await this.adb.connect(serial))) {
      bad('ADB connect', 'Could not reach ' + serial + '.');
      return this.reportDiagnosis(steps);
    }

    ok('ADB connect', serial);

    const settings = this.store.getInstance(target.name);
    const pkg = settings.package;

    const focus = await this.probe.getForegroundWindow(serial);

    if (focus) {
      ok('Foreground app', 'Readable.');
    } else {
      bad('Foreground app', 'dumpsys returned nothing.');
    }

    const uid = await this.probe.getUid(serial, pkg);

    if (uid === null) {
      bad('Roblox installed', pkg + ' not found on ' + target.name + '.');
      return this.reportDiagnosis(steps);
    }

    ok('Roblox installed', pkg + ' (uid ' + uid + ')');

    // The load-bearing one. Everything else can degrade; if this cannot
    // be read, the app can never tell a game from the home screen.
    const inGame = await this.probe.hasGameSocket(serial, pkg);

    if (inGame === null) {
      bad(
        'Game detection',
        'Cannot read /proc/net on this Android build. Rejoins will not ' +
          'trigger for this instance.'
      );
    } else {
      ok(
        'Game detection',
        'Working - currently ' + (inGame ? 'in a game.' : 'not in a game.')
      );
    }

    ok('Reported state', await this.probe.getState(serial, pkg));

    return this.reportDiagnosis(steps);
  }

  reportDiagnosis(steps) {
    this.log('--- Self-check ---');

    for (const step of steps) {
      this.log(step.name + ': ' + step.detail, {
        level: step.status === 'ok' ? 'info' : step.status
      });
    }

    const broken = steps.filter((s) => s.status === 'bad');

    this.log(
      broken.length
        ? 'Self-check found ' + broken.length + ' problem(s).'
        : 'Self-check passed.',
      { level: broken.length ? 'error' : 'info' }
    );

    return steps;
  }
}

module.exports = { Watchdog, sleep };
