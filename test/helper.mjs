/**
 * Loads the shipped library files into a sandbox.
 *
 * The libs are plain classic scripts that attach to a `FS` global (so the same
 * files can be concatenated into the background script and loaded by script tag
 * in the editor). Running them in a vm context lets the tests exercise exactly
 * the bytes that ship, with no build step or parallel copy to drift out of sync.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function loadLibs(names) {
  // runInThisContext, not createContext: a separate vm realm has its own
  // Array and Object intrinsics, so arrays returned from the libs would fail
  // assert.deepStrictEqual on prototype identity alone. Running in the host
  // realm keeps intrinsics shared, which is also what a browser actually does.
  for (const name of names) {
    const file = path.join(ROOT, 'src', 'lib', `${name}.js`);
    const code = await fs.readFile(file, 'utf8');
    vm.runInThisContext(code, { filename: file });
  }
  return globalThis.FS;
}
