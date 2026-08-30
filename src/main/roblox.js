'use strict';

// Roblox hosts BOTH the home screen and the in-game view in this one
// activity, so its presence alone does not mean a game is running.
// See getState for how the two are told apart.
const GAME_ACTIVITY = 'ActivityNativeMain';

// The activity that handles roblox.com links. Naming it explicitly stops
// the launch intent from being swallowed by the built-in browser on
// instances where Roblox is not the default handler for web links.
const LAUNCH_COMPONENT = 'com.roblox.client/.ActivityProtocolLaunch';

const PACKAGE = 'com.roblox.client';

// Activities that mean Roblox is on its way up but not in-game yet.
const LOADING_ACTIVITIES = ['ActivitySplash', 'ActivityProtocolLaunch'];

// Filtering happens on the device: dumping the whole window service over
// ADB is slow and gets truncated.
const FOCUS_COMMANDS = [
  [
    'shell',
    "dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity'"
  ],
  ['shell', "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'"]
];

class RobloxProbe {
  constructor(adb) {
    this.adb = adb;
    this.uidCache = new Map();
  }

  forget(device) {
    this.uidCache.delete(device);
  }

  async getForegroundWindow(device) {
    for (const args of FOCUS_COMMANDS) {
      const { code, stdout } = await this.adb.run(args, {
        device,
        timeout: 15000
      });

      if (code === 0 && stdout.trim()) {
        return stdout.trim();
      }
    }

    return '';
  }

  /**
   * Android uid that owns the Roblox process. Cached, since it only
   * changes if Roblox is reinstalled.
   */
  async getUid(device, pkg) {
    const key = `${device}|${pkg}`;

    if (this.uidCache.has(key)) {
      return this.uidCache.get(key);
    }

    const { code, stdout } = await this.adb.run(
      ['shell', 'cmd', 'package', 'list', 'packages', '-U', pkg],
      { device, timeout: 15000 }
    );

    if (code !== 0) {
      return null;
    }

    const match = /uid:(\d+)/.exec(stdout);

    if (!match) {
      return null;
    }

    this.uidCache.set(key, match[1]);

    return match[1];
  }

  /**
   * True when Roblox holds an open connection to a game server.
   *
   * This is what separates "in a game" from "sitting on the home
   * screen" - both look identical to the activity manager, because
   * Roblox renders both from ActivityNativeMain.
   *
   * The game connection is an *unconnected* UDP socket (remote port 0)
   * owned by Roblox. Roblox's ordinary web traffic uses UDP too, but
   * over QUIC, which shows up as a socket connected to port 443 - so the
   * remote port is what tells them apart.
   *
   * Returns true, false, or null when the check could not be run.
   */
  async hasGameSocket(device, pkg) {
    const uid = await this.getUid(device, pkg);

    if (uid === null) {
      return null;
    }

    const { stdout } = await this.adb.run(
      ['shell', 'cat', '/proc/net/udp', '/proc/net/udp6'],
      { device, timeout: 15000 }
    );

    // "cat" exits non-zero when either file is missing but still prints
    // the one it could read, so judge by the output, not the exit code.
    if (!stdout.trim()) {
      return null;
    }

    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);

      // sl local_address rem_address st tx:rx tr:when retrnsmt uid
      if (parts.length < 8 || parts[7] !== uid) {
        continue;
      }

      const remote = parts[2].split(':');

      if (remote.length !== 2) {
        continue;
      }

      const remotePort = Number.parseInt(remote[1], 16);

      if (!Number.isNaN(remotePort) && remotePort === 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * One of:
   *   GAME    - actually in a game, the healthy state
   *   MENU    - Roblox is up but sitting on the home screen
   *   LOADING - Roblox is starting up or joining
   *   OTHER   - Roblox is not the focused app
   *   UNKNOWN - the device did not answer
   */
  async getState(device, pkg = PACKAGE) {
    const focus = await this.getForegroundWindow(device);

    if (!focus) {
      return 'UNKNOWN';
    }

    if (!focus.includes(pkg)) {
      return 'OTHER';
    }

    for (const activity of LOADING_ACTIVITIES) {
      if (focus.includes(activity)) {
        return 'LOADING';
      }
    }

    if (focus.includes(GAME_ACTIVITY)) {
      const inGame = await this.hasGameSocket(device, pkg);

      if (inGame === null) {
        // The probe is unavailable here. Assume the game is fine rather
        // than restarting it in a loop.
        return 'GAME';
      }

      return inGame ? 'GAME' : 'MENU';
    }

    // Some other Roblox screen (login, settings).
    return 'MENU';
  }

  async isRunning(device, pkg = PACKAGE) {
    const { code, stdout } = await this.adb.run(['shell', 'pidof', pkg], {
      device,
      timeout: 10000
    });

    return code === 0 && Boolean(stdout.trim());
  }

  async forceStop(device, pkg = PACKAGE) {
    await this.adb.run(['shell', 'am', 'force-stop', pkg], { device });
  }

  async sendLaunchIntent(device, url, component) {
    const args = [
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      url
    ];

    if (component) {
      args.push('-n', component);
    }

    const { code, stdout, stderr } = await this.adb.run(args, {
      device,
      timeout: 20000
    });

    if (code !== 0) {
      return { ok: false, stdout, stderr };
    }

    // "am start" exits 0 even when the intent resolved to nothing, so
    // treat an explicit error line as a failure.
    const ok = !stdout.includes('Error') && !stderr.includes('Error');

    return { ok, stdout, stderr };
  }
}

module.exports = {
  RobloxProbe,
  PACKAGE,
  GAME_ACTIVITY,
  LAUNCH_COMPONENT,
  LOADING_ACTIVITIES
};
