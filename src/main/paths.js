'use strict';

const fs = require('fs');
const path = require('path');

const ADB_RELATIVE = path.join('nx_device', '12.0', 'shell', 'adb.exe');
const MANAGER_RELATIVE = path.join('nx_main', 'MuMuManager.exe');

function adbPathFor(root) {
  return path.join(root, ADB_RELATIVE);
}

function managerPathFor(root) {
  return path.join(root, MANAGER_RELATIVE);
}

function isMuMuRoot(root) {
  try {
    return fs.existsSync(adbPathFor(root));
  } catch (err) {
    return false;
  }
}

function drives() {
  const found = [];

  for (let code = 'C'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
    const letter = String.fromCharCode(code) + ':' + path.sep;

    try {
      if (fs.existsSync(letter)) {
        found.push(letter);
      }
    } catch (err) {
      /* unreadable drive, skip */
    }
  }

  return found;
}

/**
 * Find where MuMuPlayer 12 is installed.
 *
 * Checks the usual install locations first, then looks for any Netease
 * folder on every drive - people move the emulator off C: constantly
 * because the instances are large.
 */
function detectMuMuRoot() {
  const direct = [];

  for (const drive of drives()) {
    direct.push(
      path.join(drive, 'Program Files', 'Netease', 'MuMuPlayer'),
      path.join(drive, 'Program Files', 'Netease', 'MuMuPlayerGlobal-12.0'),
      path.join(drive, 'Program Files (x86)', 'Netease', 'MuMuPlayer'),
      path.join(drive, 'Netease', 'MuMuPlayer'),
      path.join(drive, 'MuMuPlayer')
    );
  }

  for (const candidate of direct) {
    if (isMuMuRoot(candidate)) {
      return candidate;
    }
  }

  // Nothing obvious. Sweep the Netease folders for anything MuMu-shaped.
  for (const drive of drives()) {
    for (const programs of ['Program Files', 'Program Files (x86)', '']) {
      const neteaseDir = path.join(drive, programs, 'Netease');

      let entries;

      try {
        entries = fs.readdirSync(neteaseDir, { withFileTypes: true });
      } catch (err) {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const candidate = path.join(neteaseDir, entry.name);

        if (isMuMuRoot(candidate)) {
          return candidate;
        }
      }
    }
  }

  return '';
}

module.exports = {
  ADB_RELATIVE,
  MANAGER_RELATIVE,
  adbPathFor,
  managerPathFor,
  isMuMuRoot,
  detectMuMuRoot
};
