/**
 * Rasterise src/icons/icon.svg into the PNG sizes the stores and browsers ask
 * for.
 *
 * The generated PNGs are committed, so a normal build never needs this and
 * ImageMagick is not a build dependency. Run it only after editing the SVG.
 *
 *   node tools/icons.mjs
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = path.join(ROOT, 'src', 'icons');
const SVG = path.join(ICONS, 'icon.svg');

// 16/32/48/128 are Chrome's set; Firefox additionally uses 96 for the add-ons
// manager, and 256 is handy for store artwork.
const SIZES = [16, 32, 48, 96, 128, 256];

async function haveMagick() {
  try {
    await run('magick', ['-version']);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await haveMagick())) {
    console.error(
      'ImageMagick ("magick") was not found. The committed PNGs in src/icons are\n' +
        'still valid; you only need this tool if you changed icon.svg.'
    );
    process.exit(1);
  }

  for (const size of SIZES) {
    const out = path.join(ICONS, `icon-${size}.png`);
    await run('magick', [
      '-background',
      'none',
      SVG,
      '-resize',
      `${size}x${size}`,
      // 8-bit RGBA keeps the files small and avoids 16-bit PNGs, which some
      // store validators flag.
      '-depth',
      '8',
      '-define',
      'png:color-type=6',
      '-strip',
      out,
    ]);
    const { size: bytes } = await fs.stat(out);
    console.log(`icon-${size}.png  ${bytes} bytes`);
  }

  // Remove any scratch renders so they cannot end up in a build.
  for (const entry of await fs.readdir(ICONS)) {
    if (/^(test|zoom|inspect)-?\d*\.png$/.test(entry)) {
      await fs.unlink(path.join(ICONS, entry));
      console.log(`removed scratch file ${entry}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
