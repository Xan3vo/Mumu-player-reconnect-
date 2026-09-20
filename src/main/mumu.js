'use strict';

const fs = require('fs');
const { execFile } = require('child_process');

// MuMuPlayer assigns instance N the ADB port 16384 + (32 * N).
// Only used as a fallback when MuMuManager cannot be queried.
const BASE_PORT = 16384;
const PORT_STRIDE = 32;
const MAX_INSTANCES = 16;

function portForIndex(index) {
  return BASE_PORT + PORT_STRIDE * index;
}

/**
 * Ask MuMuManager which instances exist and which ADB port each running
 * instance listens on. Returns null when MuMuManager is unavailable, so
 * the caller can tell "no instances" apart from "could not ask".
 */
function queryManager(managerPath) {
  return new Promise((resolve) => {
    if (!managerPath || !fs.existsSync(managerPath)) {
      resolve(null);
      return;
    }

    execFile(
      managerPath,
      ['info', '-v', 'all'],
      { timeout: 20000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error || !stdout || !stdout.trim()) {
          resolve(null);
          return;
        }

        let data;

        try {
          data = JSON.parse(stdout);
        } catch (err) {
          resolve(null);
          return;
        }

        // A single instance comes back as a bare object; several come
        // back as a mapping of index -> object.
        let records;

        if (Array.isArray(data)) {
          records = data;
        } else if (data && typeof data === 'object') {
          records = 'index' in data ? [data] : Object.values(data);
        } else {
          resolve(null);
          return;
        }

        const found = [];

        for (const record of records) {
          if (!record || typeof record !== 'object') {
            continue;
          }

          const index = Number.parseInt(record.index, 10);

          if (Number.isNaN(index)) {
            continue;
          }

          // Field names drift between MuMuManager builds, so accept any
          // of the spellings that have meant "Android is up", and treat
          // a published ADB port as proof on its own.
          const started = Boolean(
            record.is_android_started ||
              record.is_process_started ||
              record.player_state === 'start_finished' ||
              record.adb_port
          );
          const host = record.adb_host_ip || '127.0.0.1';

          // Android is up but the port has not been published yet.
          const port = record.adb_port || (started ? portForIndex(index) : null);

          found.push({
            index,
            name: record.name || `instance-${index}`,
            started,
            serial: port ? `${host}:${port}` : null
          });
        }

        resolve(found);
      }
    );
  });
}

/**
 * Fallback discovery: try the documented MuMu port for every possible
 * instance slot and keep whatever answers.
 */
async function probePorts(adb) {
  const found = [];

  for (let index = 0; index < MAX_INSTANCES; index += 1) {
    const serial = `127.0.0.1:${portForIndex(index)}`;

    if (await adb.connect(serial)) {
      found.push({
        index,
        name: `instance-${index}`,
        started: true,
        serial
      });
    } else {
      await adb.disconnect(serial);
    }
  }

  return found;
}

module.exports = {
  BASE_PORT,
  PORT_STRIDE,
  MAX_INSTANCES,
  portForIndex,
  queryManager,
  probePorts
};
