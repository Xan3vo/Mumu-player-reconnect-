'use strict';

const { execFile } = require('child_process');

/**
 * Thin wrapper around MuMu's bundled adb.exe.
 *
 * Everything here is best-effort: a busy or restarting emulator makes
 * ADB fail in a dozen different ways, and none of them should take the
 * app down. Callers get a plain { code, stdout, stderr } and decide.
 */
class Adb {
  constructor(adbPath) {
    this.adbPath = adbPath;
  }

  setPath(adbPath) {
    this.adbPath = adbPath;
  }

  run(args, { device = null, timeout = 15000 } = {}) {
    const argv = [];

    if (device) {
      argv.push('-s', device);
    }

    argv.push(...args);

    return new Promise((resolve) => {
      execFile(
        this.adbPath,
        argv,
        { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          resolve({
            code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
            stdout: (stdout || '').trim(),
            stderr: (stderr || '').trim()
          });
        }
      );
    });
  }

  async startServer() {
    return this.run(['start-server'], { timeout: 30000 });
  }

  /**
   * Attach ADB to a MuMu instance.
   *
   * This is the piece a plain "adb devices" never does for you. Cloned
   * instances do not register themselves with the ADB server, so they
   * stay invisible until something connects to their port explicitly.
   */
  async connect(serial) {
    const { code, stdout, stderr } = await this.run(['connect', serial], {
      timeout: 10000
    });

    const output = `${stdout} ${stderr}`.toLowerCase();

    return code === 0 && output.includes('connected');
  }

  async disconnect(serial) {
    await this.run(['disconnect', serial], { timeout: 10000 });
  }

  /** { serial: state } for everything ADB currently knows about. */
  async devices() {
    const { code, stdout } = await this.run(['devices'], { timeout: 10000 });

    if (code !== 0) {
      return {};
    }

    const found = {};

    for (const raw of stdout.split(/\r?\n/)) {
      const line = raw.trim();

      if (!line || line.startsWith('List of devices')) {
        continue;
      }

      const parts = line.split(/\s+/);

      if (parts.length < 2) {
        continue;
      }

      found[parts[0]] = parts[1];
    }

    return found;
  }

  async onlineDevices() {
    const all = await this.devices();

    return new Set(
      Object.keys(all).filter((serial) => all[serial] === 'device')
    );
  }
}

module.exports = { Adb };
