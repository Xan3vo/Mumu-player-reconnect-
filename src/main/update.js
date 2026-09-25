'use strict';

const https = require('https');

// The releases API for this repo. A GET here sends nothing about the
// user - no settings, no links, no machine details - and the response
// is public. It is the only outbound request the app ever makes.
const RELEASES_URL =
  'https://api.github.com/repos/Xan3vo/Mumu-player-reconnect-/releases/latest';

const TIMEOUT = 8000;

/**
 * Compare two "1.2.3" strings. Returns > 0 when a is newer than b.
 *
 * Anything unparseable counts as 0 so a malformed tag can never make a
 * current install look out of date.
 */
function compareVersions(a, b) {
  const parse = (value) =>
    String(value)
      .replace(/^v/i, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);

  const left = parse(a);
  const right = parse(b);

  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);

    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

function fetchLatest() {
  return new Promise((resolve) => {
    let settled = false;

    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const request = https.get(
      RELEASES_URL,
      {
        headers: {
          // GitHub rejects API requests without one.
          'User-Agent': 'MuMu-Reconnect',
          Accept: 'application/vnd.github+json'
        },
        timeout: TIMEOUT
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          done(null);
          return;
        }

        let body = '';

        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;

          // A sane release payload is a few KB. Anything larger is not
          // something worth parsing.
          if (body.length > 512 * 1024) {
            request.destroy();
            done(null);
          }
        });

        response.on('end', () => {
          try {
            done(JSON.parse(body));
          } catch (err) {
            done(null);
          }
        });
      }
    );

    // Offline, DNS failure, proxy, blocked by a firewall: all fine, the
    // app just does not know about updates this run.
    request.on('error', () => done(null));
    request.on('timeout', () => {
      request.destroy();
      done(null);
    });
  });
}

/**
 * Check whether a newer release exists.
 *
 * Resolves to null when the check could not run or the app is current,
 * so a failed check is indistinguishable from being up to date and can
 * never nag the user.
 */
async function checkForUpdate(currentVersion) {
  const release = await fetchLatest();

  if (!release || !release.tag_name || release.draft || release.prerelease) {
    return null;
  }

  const latest = String(release.tag_name).replace(/^v/i, '');

  if (compareVersions(latest, currentVersion) <= 0) {
    return null;
  }

  return {
    latest,
    current: currentVersion,
    url: release.html_url || 'https://github.com/Xan3vo/Mumu-player-reconnect-/releases/latest'
  };
}

module.exports = { checkForUpdate, compareVersions };
