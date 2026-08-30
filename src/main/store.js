'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_GENERAL = {
  // How often to look for MuMu instances, in seconds.
  discoveryInterval: 5,
  // How often each instance is checked, in seconds.
  checkInterval: 5,
  // How long to wait between reconnect attempts for one instance.
  reconnectCooldown: 30,
  // How long Roblox may sit outside a game (loading, home screen)
  // before it counts as stuck. Joining a private server legitimately
  // takes 20-60s, so keep this comfortably above that.
  loadingGrace: 45,
  // How long to wait for a game after sending the launch intent.
  startTimeout: 90,
  // Launch attempts before backing off until the next cooldown.
  maxAttempts: 3,
  // Start watching as soon as the app opens.
  autoStart: false,
  // Keep running in the tray when the window is closed.
  minimizeToTray: true
};

const DEFAULT_INSTANCE = {
  enabled: false,
  joinUrl: '',
  package: 'com.roblox.client',
  launchComponent: 'com.roblox.client/.ActivityProtocolLaunch'
};

/**
 * Settings live in the user's app-data folder, never next to the .exe,
 * so an install or update never clobbers them - and so a private server
 * link is never bundled into anything shipped.
 */
class Store {
  constructor(dir) {
    this.file = path.join(dir, 'config.json');
    this.data = this.load();
  }

  load() {
    let raw = {};

    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      raw = {};
    }

    return {
      version: 1,
      mumuRoot: typeof raw.mumuRoot === 'string' ? raw.mumuRoot : '',
      general: { ...DEFAULT_GENERAL, ...(raw.general || {}) },
      instances:
        raw.instances && typeof raw.instances === 'object' ? raw.instances : {}
    };
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
      return true;
    } catch (err) {
      return false;
    }
  }

  getGeneral() {
    return { ...this.data.general };
  }

  setGeneral(patch) {
    this.data.general = { ...this.data.general, ...(patch || {}) };
    this.save();
    return this.getGeneral();
  }

  getMuMuRoot() {
    return this.data.mumuRoot;
  }

  setMuMuRoot(root) {
    this.data.mumuRoot = root || '';
    this.save();
    return this.data.mumuRoot;
  }

  /** Per-instance settings, keyed by the instance's MuMu name. */
  getInstance(key) {
    return { ...DEFAULT_INSTANCE, ...(this.data.instances[key] || {}) };
  }

  setInstance(key, patch) {
    this.data.instances[key] = { ...this.getInstance(key), ...(patch || {}) };
    this.save();
    return this.getInstance(key);
  }

  forgetInstance(key) {
    delete this.data.instances[key];
    this.save();
  }

  all() {
    return {
      mumuRoot: this.data.mumuRoot,
      general: this.getGeneral(),
      instances: { ...this.data.instances }
    };
  }
}

module.exports = { Store, DEFAULT_GENERAL, DEFAULT_INSTANCE };
