import { app, BrowserWindow, screen } from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/**
 * `npm run icons` — regenerate build/icon.icns and build/icon.ico from build/icon.svg.
 *
 * The icon has one source of truth (the SVG) and two binary containers derived from it,
 * so they can never drift. Rasterising is done by the Chromium that already ships in the
 * tree rather than a new image dependency: an offscreen window renders the SVG at each
 * target size and capturePage() hands back the pixels. `capturePage` takes a CSS rect and
 * returns device pixels, hence the divide by the display's scale factor.
 *
 * .icns is assembled by `iconutil`, which is part of macOS. .ico is written here: the
 * format is a 6-byte directory header, one 16-byte entry per image, then the images, and
 * Vista onward accepts PNG payloads verbatim — no encoder needed.
 *
 * Run it through Electron, not node: `npm run icons`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = resolve(HERE, '..', 'build');
const SVG = resolve(BUILD_DIR, 'icon.svg');

/** Sizes iconutil expects in an .iconset, keyed by the filename it looks for. */
const ICONSET_MEMBERS = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

/** Windows shows the icon at all of these; anything missing gets scaled badly. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const ALL_SIZES = [...new Set([...ICONSET_MEMBERS.map(([, s]) => s), ...ICO_SIZES])].sort(
  (a, b) => a - b,
);

/**
 * @param {Map<number, Buffer>} pngs
 * @returns {Buffer}
 */
function buildIco(pngs) {
  const entries = ICO_SIZES.map((size) => {
    const png = pngs.get(size);
    if (png === undefined) {
      throw new Error(`no ${size}px render available for the .ico`);
    }
    return { size, png };
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;

  entries.forEach((entry, index) => {
    const at = index * 16;
    // 256 is stored as 0: the field is a single byte.
    directory.writeUInt8(entry.size === 256 ? 0 : entry.size, at);
    directory.writeUInt8(entry.size === 256 ? 0 : entry.size, at + 1);
    directory.writeUInt8(0, at + 2); // palette size, 0 for truecolour
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)]);
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    const scaleFactor = screen.getPrimaryDisplay().scaleFactor || 1;
    const iconsetDir = resolve(BUILD_DIR, 'icon.iconset');
    rmSync(iconsetDir, { recursive: true, force: true });
    mkdirSync(iconsetDir, { recursive: true });

    const page = resolve(iconsetDir, 'render.html');
    writeFileSync(
      page,
      `<!doctype html><meta charset="utf-8"><style>
        html,body{margin:0;padding:0;background:transparent;overflow:hidden}
        img{display:block;position:absolute;top:0;left:0}
      </style><img id="mark" src="file://${SVG}">`,
    );

    const window = new BrowserWindow({
      width: 640,
      height: 640,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      useContentSize: true,
      webPreferences: { offscreen: true, backgroundThrottling: false },
    });
    await window.loadFile(page);

    /** @type {Map<number, Buffer>} */
    const pngs = new Map();
    for (const size of ALL_SIZES) {
      const css = size / scaleFactor;
      await window.webContents.executeJavaScript(
        `(() => { const m = document.getElementById('mark');
          m.style.width = '${css}px'; m.style.height = '${css}px';
          return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); })()`,
      );
      const image = await window.webContents.capturePage({
        x: 0,
        y: 0,
        width: Math.ceil(css),
        height: Math.ceil(css),
      });
      const { width, height } = image.getSize();
      if (width !== size || height !== size) {
        throw new Error(`expected a ${size}px render, got ${width}x${height}`);
      }
      pngs.set(size, image.toPNG());
    }
    window.destroy();

    for (const [name, size] of ICONSET_MEMBERS) {
      const png = pngs.get(size);
      if (png === undefined) {
        throw new Error(`no ${size}px render available for ${name}`);
      }
      writeFileSync(resolve(iconsetDir, name), png);
    }
    rmSync(page, { force: true });

    const icns = resolve(BUILD_DIR, 'icon.icns');
    execFileSync('iconutil', ['--convert', 'icns', '--output', icns, iconsetDir]);
    rmSync(iconsetDir, { recursive: true, force: true });

    const ico = resolve(BUILD_DIR, 'icon.ico');
    writeFileSync(ico, buildIco(pngs));

    // electron-builder falls back to build/icon.png for Linux and for its own previews.
    const largest = pngs.get(1024);
    if (largest === undefined) {
      throw new Error('no 1024px render available for icon.png');
    }
    writeFileSync(resolve(BUILD_DIR, 'icon.png'), largest);

    console.log(
      `[matchline:icons] wrote icon.icns, icon.ico (${ICO_SIZES.join('/')}) and icon.png`,
    );
    app.exit(0);
  } catch (error) {
    console.error(
      `[matchline:icons] ${error instanceof Error ? error.message : String(error)}`,
    );
    app.exit(1);
  }
});
