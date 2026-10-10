'use strict';

/**
 * Rasterise build/icon.svg into every PNG the app and installer use.
 *
 *   npm run icons
 *
 * Runs under Electron rather than adding an image library: Chromium is
 * already here and renders the SVG exactly as the app's own UI would.
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'build', 'icon.svg');

// Rendered once at MASTER and scaled down, so every size comes from the
// same pixels instead of each one being re-rasterised slightly differently.
const MASTER = 1024;

const OUTPUTS = [
  // electron-builder turns this into the installer and .exe icon.
  ['build/icon.png', 512],
  // Window and taskbar.
  ['src/assets/icon.png', 256],
  // Tray. Electron picks the @2x file on high-DPI displays.
  ['src/assets/tray.png', 16],
  ['src/assets/tray@2x.png', 32]
];

app.disableHardwareAcceleration();

// Capture returns physical pixels, so on a display scaled to 150% a 1024px
// window comes back 1536px - and taller than the screen, which Windows
// clamps, cropping the icon. Render at a 1:1 scale regardless of display.
app.commandLine.appendSwitch('force-device-scale-factor', '1');

async function renderMaster() {
  const svg = fs
    .readFileSync(SOURCE, 'utf8')
    .replace('<svg ', '<svg width="' + MASTER + '" height="' + MASTER + '" ');

  const html =
    '<!doctype html><html><head><style>' +
    'html,body{margin:0;background:transparent;overflow:hidden}' +
    'svg{display:block}' +
    '</style></head><body>' +
    svg +
    '</body></html>';

  const win = new BrowserWindow({
    width: MASTER,
    height: MASTER,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true }
  });

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  // Let the first frame paint before capturing it.
  await new Promise((resolve) => setTimeout(resolve, 300));

  const image = await win.webContents.capturePage();

  win.destroy();

  // A capture of the wrong size means part of the icon was cut off. Never
  // write that out - stop and say so instead.
  const { width, height } = image.getSize();

  if (width !== MASTER || height !== MASTER) {
    throw new Error(
      'Captured ' + width + 'x' + height + ', expected ' + MASTER + 'x' +
        MASTER + '. The icon would be cropped, so nothing was written.'
    );
  }

  return image;
}

app.whenReady().then(async () => {
  try {
    const master = await renderMaster();

    for (const [relative, size] of OUTPUTS) {
      const png = master
        .resize({ width: size, height: size, quality: 'best' })
        .toPNG();

      fs.writeFileSync(path.join(ROOT, relative), png);
      console.log('wrote ' + relative + ' (' + size + 'px)');
    }
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }

  app.quit();
});
