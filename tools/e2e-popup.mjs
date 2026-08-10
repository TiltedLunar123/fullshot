/**
 * End-to-end checks for the popup, which had no coverage of any kind.
 *
 * Two things it does are invisible from the popup itself and only observable
 * from outside, which is why they went wrong quietly:
 *
 *   1. The alarm badge. A capture started from the keyboard has no popup to
 *      fail in front of, so the background flags the toolbar icon and parks the
 *      message for the next popup to read. Taking the badge down again is the
 *      popup's job, and it was clearing the DEFAULT badge while the alarm had
 *      been set against a specific tab. A per-tab badge wins, so the "!" stayed
 *      up after the message it referred to had been read and deleted.
 *   2. The keyboard shortcut it advertises. A manifest only SUGGESTS a key; the
 *      browser is free to drop it and the user is free to rebind it. The popup
 *      printed the suggestion regardless.
 *
 * The popup is opened as an ordinary background tab, so `tabs.query({active})`
 * inside it answers with the page tab, exactly as it does when the real popup
 * is open over a page.
 *
 *   node tools/e2e-popup.mjs
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CDP, buildTestVariant, httpJson, launch, shutdown, sleep, waitFor } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function serveFixtures() {
  const dir = path.join(ROOT, 'test-pages');
  const server = http.createServer(async (req, res) => {
    const name = path.basename(new URL(req.url, 'http://localhost').pathname) || 'plain.html';
    try {
      const body = await fs.readFile(path.join(dir, name));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const results = [];
const check = (ok, passMsg, failMsg) => results.push({ ok, msg: ok ? passMsg : failMsg });

/** Read what the popup is showing, once it has finished its opening reads. */
const POPUP_STATE = `(() => {
  const status = document.querySelector('.status');
  return {
    status: status?.textContent ?? '',
    isError: status?.classList.contains('error') ?? false,
    offering: !document.getElementById('open-capture').hidden,
    modes: [...document.querySelectorAll('.mode')].map((b) => ({
      mode: b.dataset.mode,
      kbd: b.querySelector('kbd')?.textContent ?? null,
      title: b.title || null,
    })),
  };
})()`;

/**
 * Open the popup in a BACKGROUND tab and read it once its opening reads have
 * settled. Background, because a popup that is itself the active tab would ask
 * the browser about its own chrome-extension:// address and answer that the
 * page is restricted.
 */
async function openPopup(cdp, sw, extensionId, port) {
  const tabId = await cdp.evaluate(
    sw,
    `FS.api.tabs.create({ url: FS.api.runtime.getURL('popup/popup.html'), active: false }).then((t) => t.id)`
  );

  const target = await waitFor('popup target', async () => {
    const targets = await httpJson(port, '/json/list');
    return targets.find((t) => t.url.includes('popup/popup.html'));
  });
  const session = await cdp.attach(target.id);
  await waitFor('popup script', async () =>
    (await cdp.evaluate(session, `!!document.querySelector('.status')`)) === true
  );
  // The opening reads are three independent async blocks; give them a beat to
  // land before deciding what the popup is showing.
  await sleep(600);
  return { session, tabId };
}

async function closePopup(cdp, sw, tabId) {
  await cdp.evaluate(sw, `FS.api.tabs.remove(${tabId}).then(() => true, () => true)`);
  await sleep(200);
}

async function attachWorker(cdp, port) {
  const worker = await waitFor('service worker', async () => {
    const targets = await httpJson(port, '/json/list');
    return targets.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
  });
  return cdp.attach(worker.id);
}

/** The popup, against a build whose commands the browser really did bind. */
async function withCommands(fixturePort) {
  const PORT = 9351;
  const { dir, extensionId } = await buildTestVariant(ROOT, 'e2e-popup');
  const session = await launch(dir, { headless: true, port: PORT });

  try {
    const cdp = await CDP.connect((await httpJson(PORT, '/json/version')).webSocketDebuggerUrl);
    const sw = await attachWorker(cdp, PORT);

    const { targetId: pageTarget } = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${fixturePort}/plain.html`,
    });
    await cdp.attach(pageTarget);
    await sleep(500);

    const pageTabId = await cdp.evaluate(
      sw,
      `FS.api.tabs.query({ active: true, currentWindow: true }).then((t) => t[0].id)`
    );

    /* ---- a parked failure is shown, and takes its badge down ------- */
    await cdp.evaluate(
      sw,
      `Promise.all([
         FS.api.action.setBadgeText({ tabId: ${pageTabId}, text: '!' }),
         FS.api.storage.local.set({ lastError: { message: 'Kaboom on this page.', at: Date.now() } }),
       ]).then(() => true)`
    );

    let popup = await openPopup(cdp, sw, extensionId, PORT);
    let state = await cdp.evaluate(popup.session, POPUP_STATE);
    let badge = await cdp.evaluate(sw, `FS.api.action.getBadgeText({ tabId: ${pageTabId} })`);

    check(
      state.status === 'Kaboom on this page.' && state.isError,
      'A failure parked by a keyboard capture is shown the next time the popup opens',
      `Popup showed ${JSON.stringify(state.status)} (error styling: ${state.isError})`
    );
    check(
      badge === '',
      'Reading the parked failure takes the alarm badge off the tab it was set on',
      `Badge on the page tab is ${JSON.stringify(badge)} after the popup read the failure`
    );

    /* ---- the shortcut shown is the one the browser bound ----------- */
    const bound = await cdp.evaluate(
      sw,
      `new Promise((r) => FS.api.commands.getAll((c) => r(Object.fromEntries(c.map((x) => [x.name, x.shortcut])))))`
    );
    const wanted = { full: bound['capture-full-page'], visible: bound['capture-visible'] };
    const shown = Object.fromEntries(state.modes.map((m) => [m.mode, m.kbd]));
    check(
      shown.full === (wanted.full || null) && shown.visible === (wanted.visible || null),
      `The popup shows the shortcuts the browser actually bound (${wanted.full}, ${wanted.visible})`,
      `Popup shows ${JSON.stringify(shown)}, browser bound ${JSON.stringify(wanted)}`
    );
    check(
      state.modes.filter((m) => m.kbd === null).length === 2,
      'Only the two modes with a command advertise a key',
      `${state.modes.filter((m) => m.kbd === null).length} modes have no key, expected 2`
    );

    await closePopup(cdp, sw, popup.tabId);

    /* ---- a stale failure is discarded, badge included -------------- */
    await cdp.evaluate(
      sw,
      `Promise.all([
         FS.api.action.setBadgeText({ tabId: ${pageTabId}, text: '!' }),
         FS.api.storage.local.set({
           lastError: { message: 'Yesterday.', at: Date.now() - 60 * 60 * 1000 },
         }),
       ]).then(() => true)`
    );

    popup = await openPopup(cdp, sw, extensionId, PORT);
    state = await cdp.evaluate(popup.session, POPUP_STATE);
    badge = await cdp.evaluate(sw, `FS.api.action.getBadgeText({ tabId: ${pageTabId} })`);

    check(
      !state.status.includes('Yesterday'),
      'A failure old enough to have been forgotten is not repeated',
      `Popup showed the stale message: ${JSON.stringify(state.status)}`
    );
    check(
      badge === '',
      'A discarded failure does not leave its alarm badge behind either',
      `Badge is ${JSON.stringify(badge)} after a stale failure was dropped`
    );

    await closePopup(cdp, sw, popup.tabId);

    /* ---- a capture waiting with the editor switched off ------------ */
    await cdp.evaluate(
      sw,
      `FS.api.storage.local.set({ pendingCapture: { id: 'nope', at: Date.now() } }).then(() => true)`
    );
    popup = await openPopup(cdp, sw, extensionId, PORT);
    state = await cdp.evaluate(popup.session, POPUP_STATE);
    check(
      state.offering,
      'A capture taken with the editor switched off is offered the next time the popup opens',
      'The popup did not offer the waiting capture'
    );
    await closePopup(cdp, sw, popup.tabId);
  } finally {
    await shutdown(session);
  }
}

/**
 * The popup against a build whose commands are declared but bound to nothing.
 *
 * This is the shape of the real failure, and it is reached by dropping the
 * suggested keys rather than the commands: an extension always declares its
 * commands, and what varies is whether the browser bound one. A command with no
 * binding comes back from getAll() with an empty shortcut, which is also what a
 * refused suggestion and a user who cleared the key both look like.
 *
 * Deleting the commands outright would test a state the shipping build cannot
 * be in, and it passes for the wrong reason: `chrome.commands` is not there at
 * all, so nothing can be asked.
 */
async function withoutCommands() {
  const PORT = 9352;
  const { dir } = await buildTestVariant(ROOT, 'e2e-popup-nokeys');
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  for (const command of Object.values(manifest.commands ?? {})) delete command.suggested_key;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const session = await launch(dir, { headless: true, port: PORT });
  try {
    const cdp = await CDP.connect((await httpJson(PORT, '/json/version')).webSocketDebuggerUrl);
    const sw = await attachWorker(cdp, PORT);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    await cdp.attach(targetId);
    await sleep(300);

    const popup = await openPopup(cdp, sw, null, PORT);
    const state = await cdp.evaluate(popup.session, POPUP_STATE);
    const withKey = state.modes.filter((m) => m.kbd !== null);

    check(
      withKey.length === 0,
      'With nothing bound, the popup advertises no keyboard shortcut at all',
      `The popup still shows ${withKey.map((m) => `${m.mode}=${m.kbd}`).join(', ')} with no command bound`
    );
    check(
      state.modes.filter((m) => m.title?.includes('shortcut')).length === 2,
      'The two modes that can have a shortcut say where one is set',
      'Neither mode explains that no shortcut is set'
    );
  } finally {
    await shutdown(session);
  }
}

async function run() {
  const { server, port } = await serveFixtures();
  console.log(`serving fixtures on 127.0.0.1:${port}`);
  try {
    console.log('--- popup, commands bound ---');
    await withCommands(port);
    console.log('--- popup, nothing bound ---');
    await withoutCommands();
  } finally {
    server.close();
  }

  console.log('\n--- popup results ---');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.msg}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
