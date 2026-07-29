/**
 * Shared browser driving for the end-to-end harnesses.
 *
 * A very small Chrome DevTools Protocol client over Node's built-in WebSocket,
 * so the test tooling needs no dependencies either.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * Edge comes first on purpose.
 *
 * Branded Google Chrome now refuses --load-extension and
 * --disable-extensions-except ("--disable-extensions-except is not allowed in
 * Google Chrome, ignoring." in its own log), so the extension silently never
 * loads there. Edge and Chromium are the same engine and still honour the flag.
 */
export const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Chromium/Application/chrome.exe',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function httpJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`bad JSON from ${urlPath}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
  });
}

export async function waitFor(label, fn, { timeout = 30000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

export class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
    });
    return new CDP(socket);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }

  /** Evaluate in a target and return the value, surfacing thrown errors. */
  async evaluate(sessionId, expression) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      sessionId
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)
      );
    }
    return result.result.value;
  }

  /**
   * Drag with real synthesised input.
   *
   * Deliberately not synthetic PointerEvents dispatched from JS: those have no
   * active pointer, so `setPointerCapture` rejects them, and the editor's drag
   * handling depends on capture. Input.dispatchMouseEvent goes through the
   * browser's real input pipeline instead.
   */
  async drag(sessionId, from, to, { steps = 8 } = {}) {
    await this.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 },
      sessionId
    );
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await this.send(
        'Input.dispatchMouseEvent',
        {
          type: 'mouseMoved',
          x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t,
          button: 'left',
          buttons: 1,
        },
        sessionId
      );
    }
    await this.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 },
      sessionId
    );
  }

  async click(sessionId, at) {
    await this.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 },
      sessionId
    );
    await this.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 },
      sessionId
    );
  }

  async typeText(sessionId, text) {
    await this.send('Input.insertText', { text }, sessionId);
  }

  async pressEnter(sessionId) {
    for (const type of ['keyDown', 'keyUp']) {
      await this.send(
        'Input.dispatchKeyEvent',
        { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
        sessionId
      );
    }
  }
}

/**
 * Chrome derives an unpacked extension's id from its `key`, so embedding a
 * generated public key makes the id predictable. Without that the harness would
 * have to guess which of the browser's several service workers is ours.
 */
export function deriveExtensionId(derPublicKey) {
  const digest = crypto.createHash('sha256').update(derPublicKey).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (digest[i] >> 4));
    id += String.fromCharCode(97 + (digest[i] & 0x0f));
  }
  return id;
}

/**
 * Copy the built Chrome extension and give it host access plus a fixed id.
 *
 * The shipping build uses activeTab, which is granted only by a real toolbar
 * click or keyboard shortcut, and neither can be synthesised. This THROWAWAY
 * variant stands in for that gesture. It is never zipped and never gated as a
 * release artefact; `tools/build.mjs --check` verifies the real permission set.
 */
export async function buildTestVariant(root, outName = 'e2e') {
  const from = path.join(root, 'dist', 'chrome');
  const to = path.join(root, 'dist', outName);
  await fs.rm(to, { recursive: true, force: true });
  await fs.cp(from, to, { recursive: true });

  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });

  const manifestPath = path.join(to, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.name = 'Fullshot (E2E test build - do not ship)';
  manifest.host_permissions = ['<all_urls>'];
  manifest.key = der.toString('base64');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return { dir: to, extensionId: deriveExtensionId(der) };
}

export async function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  throw new Error('No Chromium-based browser found.');
}

export async function launch(extensionDir, { headless = true, port, window = '1400,1000' } = {}) {
  const binary = await findBrowser();
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'fullshot-e2e-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--load-extension=${extensionDir}`,
    `--disable-extensions-except=${extensionDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    `--window-size=${window}`,
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');

  const child = spawn(binary, args, { stdio: 'ignore' });
  await waitFor('devtools endpoint', () => httpJson(port, '/json/version'), { timeout: 20000 });
  return { child, profile };
}

export async function shutdown(session) {
  try {
    session?.child.kill();
  } catch {
    /* already exited */
  }
  await sleep(400);
  if (session?.profile) {
    await fs.rm(session.profile, { recursive: true, force: true }).catch(() => {});
  }
}
