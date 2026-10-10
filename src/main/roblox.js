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

// Roblox game servers answer on ephemeral ports. Everything the client
// talks to below this is ordinary traffic - QUIC on 443, DNS on 53 -
// and must not be mistaken for a live game.
const MIN_GAME_REMOTE_PORT = 1024;

// A connected game socket is not enough on its own: after a kick ("You
// have been kicked... Error Code 267") Roblox keeps the socket open behind
// its dialog. What stops is the traffic. Measured on a live instance:
// roughly 100 inbound UDP packets a second in a game, exactly 0 with the
// kick dialog up. Anything under this rate over a check interval counts
// as disconnected.
const MIN_GAME_PACKET_RATE = 5;

// Packet counts are compared between consecutive checks. An older
// reading than this would average across whatever happened in between,
// so it is replaced instead of used.
const MAX_SAMPLE_AGE = 30000;

// How long to wait for Roblox to actually die after force-stop before
// giving up and launching anyway.
const STOP_TIMEOUT = 15000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

    // Last UDP packet-count reading per device, for the traffic rate.
    this.traffic = new Map();

    // Devices where the in-game check could not run at all. Tracked so
    // the app can say so out loud instead of quietly calling every
    // session healthy - see the null branch in getState.
    this.degraded = new Set();
  }

  forget(device) {
    // getUid keys by device AND package, so deleting the bare device
    // would leave every real entry behind and keep serving a stale uid
    // after Roblox is reinstalled.
    const prefix = device + '|';

    for (const key of [...this.uidCache.keys()]) {
      if (key.startsWith(prefix)) {
        this.uidCache.delete(key);
      }
    }

    this.degraded.delete(device);
    this.traffic.delete(device);
  }

  /**
   * Total UDP packets this instance has received, IPv4 and IPv6.
   *
   * These counters are kernel-wide, but every MuMu instance is its own VM
   * with its own kernel, and Roblox is the only app moving real UDP
   * traffic on it, so this tracks the game connection closely. Readable
   * by the shell user without root. Null when unavailable.
   */
  async readUdpIn(device) {
    const { stdout } = await this.adb.run(
      ['shell', 'cat', '/proc/net/snmp', '/proc/net/snmp6'],
      { device, timeout: 10000 }
    );

    // As with /proc/net/udp, judge by output: cat exits non-zero if one
    // of the two files is missing but still prints the other.
    if (!stdout) {
      return null;
    }

    const lines = stdout.split(/\r?\n/).map((line) => line.trim());
    let total = 0;
    let found = false;

    // /proc/net/snmp: a "Udp:" header line, then a "Udp:" values line.
    const udp = lines.filter((line) => line.startsWith('Udp:'));

    if (udp.length >= 2) {
      const names = udp[0].split(/\s+/);
      const values = udp[1].split(/\s+/);
      const column = names.indexOf('InDatagrams');
      const value = Number(values[column]);

      if (column > 0 && Number.isFinite(value)) {
        total += value;
        found = true;
      }
    }

    // /proc/net/snmp6: "Udp6InDatagrams   1234".
    for (const line of lines) {
      const match = /^Udp6InDatagrams\s+(\d+)/.exec(line);

      if (match) {
        total += Number(match[1]);
        found = true;
      }
    }

    return found ? total : null;
  }

  /**
   * Inbound UDP packets per second since the previous reading.
   *
   * Null when there is nothing fair to compare against yet - no earlier
   * reading, one too old to mean anything, or a counter that went
   * backwards because the instance rebooted.
   */
  async packetRate(device) {
    const count = await this.readUdpIn(device);

    if (count === null) {
      return null;
    }

    const now = Date.now();
    const previous = this.traffic.get(device);

    // Too soon for a meaningful rate: keep the older baseline and reuse
    // the last answer rather than measuring over a sliver of time.
    if (previous && now - previous.at < 1000) {
      return previous.rate;
    }

    let rate = null;

    if (previous && now - previous.at <= MAX_SAMPLE_AGE && count >= previous.count) {
      rate = (count - previous.count) / ((now - previous.at) / 1000);
    }

    this.traffic.set(device, { at: now, count, rate });

    return rate;
  }

  /** True when the in-game check is unavailable on this device. */
  isDegraded(device) {
    return this.degraded.has(device);
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
   * The game connection is a UDP socket *connected* to a Roblox game
   * server on a high port, e.g. 128.116.56.33:60806. Measured against a
   * live instance: on the home screen Roblox holds exactly one UDP
   * socket and it is unconnected (remote 0.0.0.0:0); in a game it holds
   * four, one of which carries that remote address.
   *
   * So an unconnected socket proves nothing - it is present in both
   * states - and matching on one is what used to report the home screen
   * as a live game and stop the watchdog from ever rejoining.
   *
   * Anything below MIN_GAME_REMOTE_PORT is Roblox's ordinary traffic
   * rather than a game: QUIC on 443, DNS on 53.
   *
   * Returns true, false, or null when the check could not be run.
   */
  async hasGameSocket(device, pkg) {
    const uid = await this.getUid(device, pkg);

    if (uid === null) {
      this.degraded.add(device);
      return null;
    }

    const { stdout } = await this.adb.run(
      ['shell', 'cat', '/proc/net/udp', '/proc/net/udp6'],
      { device, timeout: 15000 }
    );

    // "cat" exits non-zero when either file is missing but still prints
    // the one it could read, so judge by the output, not the exit code.
    // Newer Android builds can hide /proc/net entirely from the shell
    // user, which is why this path has to stay survivable.
    if (!stdout.trim()) {
      this.degraded.add(device);
      return null;
    }

    this.degraded.delete(device);

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

      // An all-zero remote address is an unconnected socket, which
      // Roblox keeps on the home screen too.
      if (/^0+$/.test(remote[0])) {
        continue;
      }

      const remotePort = Number.parseInt(remote[1], 16);

      if (!Number.isNaN(remotePort) && remotePort >= MIN_GAME_REMOTE_PORT) {
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

      if (!inGame) {
        return 'MENU';
      }

      // The socket is there; is the server still talking? A kicked or
      // dropped client keeps the socket but goes silent. With no fair
      // comparison yet, give it the benefit of the doubt until the next
      // check can measure.
      const rate = await this.packetRate(device);

      if (rate !== null && rate < MIN_GAME_PACKET_RATE) {
        return 'DISCONNECTED';
      }

      return 'GAME';
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

  /**
   * Force-stop Roblox and wait until the process is genuinely gone.
   *
   * force-stop returns immediately, long before Android has finished
   * tearing the process down. Launching into a half-dead Roblox is how
   * a rejoin "succeeds" and still lands on the home screen, so wait for
   * the pid to disappear rather than guessing at a sleep.
   *
   * Returns true when it died, false when it outlasted the timeout.
   */
  async forceStopAndWait(device, pkg = PACKAGE, timeout = STOP_TIMEOUT) {
    await this.forceStop(device, pkg);

    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      if (!(await this.isRunning(device, pkg))) {
        // The process is gone, but Android still needs a moment to
        // release its slot before an intent will start it cleanly.
        await sleep(750);
        return true;
      }

      await sleep(500);
    }

    return false;
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
  LOADING_ACTIVITIES,
  MIN_GAME_REMOTE_PORT,
  MIN_GAME_PACKET_RATE
};
