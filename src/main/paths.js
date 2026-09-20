'use strict';

const fs = require('fs');
const path = require('path');

const DEVICE_DIR = 'nx_device';
const MANAGER_RELATIVE = path.join('nx_main', 'MuMuManager.exe');

// The version folder under nx_device tracks the emulator build, not the
// app: MuMuPlayer 12 ships 12.0, newer builds ship 15.0. Never assume one.
// This constant is only the shape of the path, used when no install is
// readable so messages can still name a plausible file.
const ADB_RELATIVE = path.join(DEVICE_DIR, '12.0', 'shell', 'adb.exe');

function adbRelativeFor(version) {
  return path.join(DEVICE_DIR, version, 'shell', 'adb.exe');
}

/**
 * Rank version folders numerically so 15.0 beats 9.0 - a plain string
 * sort gets that backwards - and anything unparseable sorts last.
 */
function versionRank(name) {
  const parts = name.split('.').map((part) => Number.parseInt(part, 10));

  if (Number.isNaN(parts[0])) {
    return -1;
  }

  return parts[0] * 1000 + (Number.isNaN(parts[1]) ? 0 : parts[1]);
}

/**
 * Locate adb.exe under nx_device whatever the version folder is called.
 * Returns '' when this root holds no adb at all.
 */
function findAdb(root) {
  let entries;

  try {
    entries = fs.readdirSync(path.join(root, DEVICE_DIR), { withFileTypes: true });
  } catch (err) {
    return '';
  }

  const versions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => versionRank(b) - versionRank(a));

  for (const version of versions) {
    const candidate = path.join(root, adbRelativeFor(version));

    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return '';
}

/**
 * The emulator version behind a root, e.g. "12.0" or "15.0".
 * Empty when adb could not be found.
 */
function versionFor(root) {
  const adb = findAdb(root);

  return adb ? path.basename(path.dirname(path.dirname(adb))) : '';
}

function adbPathFor(root) {
  return findAdb(root) || path.join(root, ADB_RELATIVE);
}

function managerPathFor(root) {
  return path.join(root, MANAGER_RELATIVE);
}

function isMuMuRoot(root) {
  try {
    return Boolean(findAdb(root));
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
 * Find where MuMuPlayer is installed.
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
      path.join(drive, 'MuMuPlayer'),
      path.join(drive, 'MuMuPlayerGlobal'),
      path.join(drive, 'Games', 'MuMuPlayer'),
      path.join(drive, 'Program Files', 'MuMuPlayer')
    );
  }

  for (const candidate of direct) {
    if (isMuMuRoot(candidate)) {
      return candidate;
    }
  }

  // Nothing obvious. Sweep the vendor folders for anything MuMu-shaped.
  // The global build has shipped under Netease, MuMuGlobal and MuMu.
  const vendors = ['Netease', 'MuMuGlobal', 'MuMu'];

  for (const drive of drives()) {
    for (const programs of ['Program Files', 'Program Files (x86)', '']) {
      for (const vendor of vendors) {
        const vendorDir = path.join(drive, programs, vendor);

        let entries;

        try {
          entries = fs.readdirSync(vendorDir, { withFileTypes: true });
        } catch (err) {
          continue;
        }

        for (const entry of entries) {
          if (!entry.isDirectory()) {
            continue;
          }

          const candidate = path.join(vendorDir, entry.name);

          if (isMuMuRoot(candidate)) {
            return candidate;
          }
        }
      }
    }
  }

  return '';
}

module.exports = {
  ADB_RELATIVE,
  MANAGER_RELATIVE,
  findAdb,
  versionFor,
  adbPathFor,
  managerPathFor,
  isMuMuRoot,
  detectMuMuRoot
};
