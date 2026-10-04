/**
 * Firefox extension e2e — the real Firefox, the real add-on, no Playwright.
 *
 * Playwright's Firefox is a patched build that cannot install extensions, so
 * this suite talks raw WebDriver to geckodriver instead (zero deps, same
 * spirit as the hand-rolled zip writer).
 *
 * The moz-extension:// origin is normally a random per-profile UUID, which
 * would be unguessable from out here — so we pin it with the
 * `extensions.webextensions.uuids` pref before launch and address the popup
 * directly.
 *
 * Needs: geckodriver on PATH or GECKODRIVER_PATH, Firefox 140+ (FIREFOX_PATH
 * to override the default macOS/Linux locations). No network beyond the RPC
 * pool — the wallet screens exercised here are the offline ones.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const EXT_DIR = path.resolve(__dirname, '../../apps/extension/dist-firefox');
const EXT_UUID = '3f5b1a2c-9d47-4e18-b6a1-9c4d7e18b6a1';
const ADDON_ID = 'radwallet@radbro.xyz';
const PORT = 4446;
const DAPP_PORT = 18928;
const NODE_PORT = 18930;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOT_DIR = path.resolve(__dirname, '../../design/app-shots');
const FIREFOX_ADDRESS_BOOK_CONTACT = '0xfacefacefacefacefacefacefacefacefaceface';

const GECKODRIVER =
  process.env.GECKODRIVER_PATH ||
  'geckodriver';
const FIREFOX =
  process.env.FIREFOX_PATH ||
  (process.platform === 'darwin' ? '/Applications/Firefox.app/Contents/MacOS/firefox' : 'firefox');

// ---------------------------------------------------------------- webdriver --
async function wd(method, route, body) {
  const res = await fetch(BASE + route, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json.value || {};
    throw new Error(`${method} ${route} -> ${res.status} ${e.error || ''}: ${(e.message || '').split('\n')[0]}`);
  }
  return json.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { last = e; }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (${last.message})` : ''}`);
}

let sessionId;
const S = () => `/session/${sessionId}`;

/** find one element by CSS, or null */
async function $(css) {
  try {
    return await wd('POST', `${S()}/element`, { using: 'css selector', value: css });
  } catch {
    return null;
  }
}
const ref = (el) => el[Object.keys(el)[0]];

async function click(css) {
  const el = await waitFor(() => $(css), `element ${css}`);
  await wd('POST', `${S()}/element/${ref(el)}/click`, {});
}

async function type(css, text) {
  const el = await waitFor(() => $(css), `input ${css}`);
  await wd('POST', `${S()}/element/${ref(el)}/value`, { text });
}

/** click the first element whose text contains `needle` */
async function clickText(needle, tag = '*') {
  const script = `
    const els = [...document.querySelectorAll(${JSON.stringify(tag)})];
    const hit = els.reverse().find((e) => e.textContent.trim().includes(${JSON.stringify(needle)})
      && e.children.length === 0 || (e.tagName === 'BUTTON' && e.textContent.includes(${JSON.stringify(needle)})));
    if (!hit) return false;
    hit.click();
    return true;`;
  const ok = await waitFor(
    () => wd('POST', `${S()}/execute/sync`, { script, args: [] }),
    `clickable text "${needle}"`,
  );
  return ok;
}

const text = () =>
  wd('POST', `${S()}/execute/sync`, { script: 'return document.body.innerText', args: [] });

async function saveScreenshot(name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await waitFor(() => wd('POST', `${S()}/execute/sync`, {
    script: `const busy = document.querySelector('.busy');
      return !busy || !(busy.textContent || '').trim();`,
    args: [],
  }), 'busy overlay to clear before screenshot');
  const png = await wd('GET', `${S()}/screenshot`);
  const file = path.join(SHOT_DIR, name);
  fs.writeFileSync(file, Buffer.from(png, 'base64'));
  console.log('SCREENSHOT:', file);
}

async function setContentViewport(width, height) {
  let final = null;
  for (let i = 0; i < 5; i++) {
    const rect = await wd('GET', `${S()}/window/rect`);
    const current = await wd('POST', `${S()}/execute/sync`, {
      script: `return {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      };`,
      args: [],
    });
    final = { rect, current };
    const dx = width - current.width;
    const dy = height - current.height;
    if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) return current;
    await wd('POST', `${S()}/window/rect`, {
      width: Math.max(1, rect.width + dx),
      height: Math.max(1, rect.height + dy),
    });
    await sleep(200);
  }
  const current = await wd('POST', `${S()}/execute/sync`, {
    script: `return {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    };`,
    args: [],
  });
  if (Math.abs(width - current.width) <= 1 && Math.abs(height - current.height) <= 1) return current;
  throw new Error(`Firefox could not size content viewport to ${width}x${height}: ${JSON.stringify({ final, current })}`);
}

async function titlebarGeometry() {
  return wd('POST', `${S()}/execute/sync`, {
    script: `const box = (el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          cls: typeof el.className === 'string' ? el.className : '',
          text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
          left: r.left, top: r.top, right: r.right, bottom: r.bottom,
          width: r.width, height: r.height,
        };
      };
      const titlebar = document.querySelector('.titlebar');
      if (!titlebar) return { ok: false, reason: 'missing titlebar' };
      const title = box(titlebar);
      const children = [...titlebar.children]
        .filter((el) => {
          const style = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        })
        .map(box);
      const siblings = [...titlebar.parentElement.children];
      const next = siblings.slice(siblings.indexOf(titlebar) + 1)
        .find((el) => {
          const style = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        });
      const childOverflow = children.filter((child) =>
        child.left < title.left - 1 || child.right > title.right + 1 ||
        child.top < title.top - 1 || child.bottom > title.bottom + 1);
      const nextBox = next ? box(next) : null;
      const navClearsHeader = !nextBox || nextBox.top >= title.bottom - 1;
      return {
        ok: childOverflow.length === 0 && navClearsHeader,
        title,
        children,
        childOverflow,
        next: nextBox,
        navClearsHeader,
        viewport: {
          width: document.documentElement.clientWidth,
          height: document.documentElement.clientHeight,
          scrollWidth: document.documentElement.scrollWidth,
        },
      };`,
    args: [],
  });
}

async function captureTitlebarGeometry(screenshotName) {
  const geometry = await titlebarGeometry();
  if (screenshotName) await saveScreenshot(screenshotName);
  return geometry;
}

async function clickPortfolio() {
  const ok = await waitFor(
    () => wd('POST', `${S()}/execute/sync`, {
      script: `const b = [...document.querySelectorAll('button')]
        .find((button) => button.textContent.trim() === 'Portfolio');
        if (!b) return false;
        b.click();
        return true;`,
      args: [],
    }),
    'Portfolio navigation button',
  );
  return ok;
}

async function portfolioState() {
  return wd('POST', `${S()}/execute/sync`, {
    script: `const moneyKind = (text) => {
        const t = (text || '').replace(/\\s+/g, ' ').trim();
        return {
          text: t,
          usd: /\\$[0-9]/.test(t),
          eth: /\\b[0-9][0-9,.]*\\.?[0-9]*\\s*ETH\\b/i.test(t),
        };
      };
      const page = document.querySelector('.portfolio-page');
      const total = moneyKind(document.querySelector('.portfolio-total')?.textContent || '');
      const usd = document.querySelector('.portfolio-currency button:nth-child(1)')?.getAttribute('aria-pressed');
      const eth = document.querySelector('.portfolio-currency button:nth-child(2)')?.getAttribute('aria-pressed');
      return {
        page: !!page,
        total,
        selected: usd === 'true' ? 'USD' : eth === 'true' ? 'ETH' : null,
        groupings: [...document.querySelectorAll('.portfolio-grouping button')].map((b) => b.textContent.trim()),
        filters: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'FILTERS'),
        layout: {
          viewport: document.documentElement.clientWidth,
          html: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
        },
        smallControls: [...document.querySelectorAll('.portfolio-page button, .portfolio-page input')]
          .map((el) => {
            const r = el.getBoundingClientRect();
            return {
              text: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim(),
              width: r.width,
              height: r.height,
            };
          })
          .filter((b) => b.width < 44 || b.height < 44),
        overflowElements: [...document.querySelectorAll('body *')]
          .map((el) => {
            const r = el.getBoundingClientRect();
            return {
              tag: el.tagName,
              cls: typeof el.className === 'string' ? el.className : '',
              text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
              left: Math.round(r.left),
              right: Math.round(r.right),
              width: Math.round(r.width),
              scrollWidth: el.scrollWidth,
              clientWidth: el.clientWidth,
            };
          })
          .filter((el) => el.right > document.documentElement.clientWidth + 1 ||
            el.left < -1 || el.scrollWidth > el.clientWidth + 1)
          .slice(0, 20),
      };`,
    args: [],
  });
}

async function setPortfolioCurrency(currency) {
  await wd('POST', `${S()}/execute/sync`, {
    script: `const wanted = arguments[0];
      const b = [...document.querySelectorAll('.portfolio-currency button')]
        .find((button) => button.textContent.trim() === wanted);
      if (!b) return false;
      b.click();
      return true;`,
    args: [currency],
  });
  await sleep(250);
}

async function openAndClosePortfolioFilters(screenshotName) {
  await clickText('FILTERS', 'button');
  const dialog = await waitFor(
    () => wd('POST', `${S()}/execute/sync`, {
      script: `const d = document.querySelector('[role="dialog"][aria-label="Portfolio filters"]');
        if (!d) return null;
        const underlay = [...document.querySelectorAll('#app > *')].filter((el) => !el.contains(d));
        return {
          modal: d.getAttribute('aria-modal'),
          focusInside: d.contains(document.activeElement),
          underlayInert: underlay.length > 0 && underlay.every((el) => el.inert),
          tabs: [...d.querySelectorAll('button')].map((b) => b.textContent.trim()),
        };`,
      args: [],
    }),
    'portfolio filter dialog',
  );
  if (screenshotName) await saveScreenshot(screenshotName);
  await clickText('Done', 'button');
  await waitFor(
    () => wd('POST', `${S()}/execute/sync`, {
      script: `return !document.querySelector('[role="dialog"][aria-label="Portfolio filters"]');`,
      args: [],
    }),
    'portfolio filter dialog to close',
  );
  return dialog;
}

/**
 * geckodriver refuses to navigate the content context to a privileged
 * moz-extension:// URL, so drive the load from the parent (chrome) context
 * with a system principal — the same thing typing it in the URL bar does.
 */
async function gotoExtensionPage(url) {
  const previousDocument = await wd('POST', `${S()}/execute/sync`, {
    script: 'return performance.timeOrigin;', args: [],
  });
  await wd('POST', `${S()}/moz/context`, { context: 'chrome' });
  await wd('POST', `${S()}/execute/sync`, {
    script: `const url = arguments[0];
      const b = gBrowser.selectedBrowser;
      const principal = Services.scriptSecurityManager.getSystemPrincipal();
      if (b.fixupAndLoadURIString) b.fixupAndLoadURIString(url, { triggeringPrincipal: principal });
      else b.loadURI(Services.io.newURI(url), { triggeringPrincipal: principal });
      return true;`,
    args: [url],
  });
  await wd('POST', `${S()}/moz/context`, { context: 'content' });
  // The parent-context load is asynchronous. On a same-URL reload, the old
  // document still contains RADWALLET and can satisfy a text-only wait, then
  // unload under the next execute/async command.
  await waitFor(() => wd('POST', `${S()}/execute/sync`, {
    script: `return location.href === arguments[0]
      && performance.timeOrigin !== arguments[1] && document.readyState === 'complete';`,
    args: [url, previousDocument],
  }), 'the new extension document to finish loading');
}

// --------------------------------------------------------------------- run --
(async () => {
  if (!fs.existsSync(EXT_DIR)) {
    console.error('build first: npm run build');
    process.exit(1);
  }

  const dapp = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<h1>fake dapp</h1>');
  });
  await new Promise((r) => dapp.listen(DAPP_PORT, '127.0.0.1', r));

  /**
   * A node on loopback, answering eth_chainId over PLAIN http with the same
   * permissive CORS anvil sends. The wallet holds no host permissions, so this
   * is exactly the shape of request a bring-your-own-node setup makes — and
   * Firefox is the browser most likely to refuse it, being the one this repo
   * has to keep honest.
   */
  const node = http.createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let id = 1;
      try { id = JSON.parse(body).id ?? 1; } catch { /* keep 1 */ }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: '0x1' }));
    });
  });
  await new Promise((r) => node.listen(NODE_PORT, '127.0.0.1', r));

  // --allow-system-access unlocks the chrome context, which is the only way to
  // navigate to a privileged moz-extension:// page. geckodriver 0.37 refuses
  // the equivalent -remote-allow-system-access browser arg via capabilities, so
  // it has to be a driver flag.
  const driver = spawn(GECKODRIVER, ['--port', String(PORT), '--allow-system-access'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  driver.on('error', (e) => {
    console.error(`could not start geckodriver (${GECKODRIVER}): ${e.message}`);
    console.error('install it with `brew install geckodriver`, or set GECKODRIVER_PATH');
    process.exit(1);
  });
  const bye = () => {
    try { driver.kill(); } catch { /* already gone */ }
    try { dapp.close(); } catch { /* already closed */ }
    try { node.close(); } catch { /* already closed */ }
  };
  process.on('exit', bye);

  await waitFor(async () => (await fetch(`${BASE}/status`)).ok, 'geckodriver to come up');

  let failures = 0;
  const check = (label, ok, extra = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`);
    if (!ok) failures++;
  };

  try {
    sessionId = (await wd('POST', '/session', {
      capabilities: {
        alwaysMatch: {
          'moz:firefoxOptions': {
            binary: FIREFOX,
            args: ['-headless'],
            // pin the extension origin so we can navigate straight to the popup
            prefs: {
              'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: EXT_UUID }),
            },
          },
        },
      },
    })).sessionId;

    const caps = await wd('GET', `${S()}`).catch(() => null);
    const addon = await wd('POST', `${S()}/moz/addon/install`, { path: EXT_DIR, temporary: true });
    check('add-on installs in real Firefox', typeof addon === 'string' && addon.includes('radwallet'), addon);

    const popup = `moz-extension://${EXT_UUID}/index.html`;
    await gotoExtensionPage(popup);
    await waitFor(async () => (await text()).includes('RADWALLET'), 'popup to render');
    check('popup page renders from the moz-extension origin', true);
    const notificationsOk = await wd('POST', `${S()}/execute/sync`, {
      script: `const permissions = chrome.runtime.getManifest().permissions || [];
        return permissions.includes('notifications')
          && !!chrome.notifications && typeof chrome.notifications.create === 'function';`,
      args: [],
    });
    check('firefox ships the transaction-notification permission and API', notificationsOk === true);

    // the background event page must be alive: the UI only takes this path
    // when session.ts has resolved to RemoteSession over runtime messaging
    const remote = await wd('POST', `${S()}/execute/async`, {
      script: `const done = arguments[0];
        try {
          chrome.runtime.sendMessage({ t: 'sess.status' }, (r) => {
            done({ ok: !!r && typeof r.locked === 'boolean', locked: r && r.locked,
                   err: chrome.runtime.lastError && chrome.runtime.lastError.message });
          });
        } catch (e) { done({ ok: false, err: e.message }); }`,
      args: [],
    });
    check('background event page answers sess.status', remote.ok, JSON.stringify(remote));

    // storage round-trip through the same callback path the app uses
    const stored = await wd('POST', `${S()}/execute/async`, {
      script: `const done = arguments[0];
        chrome.storage.local.set({ __e2e: 'radbro' }, () => {
          chrome.storage.local.get('__e2e', (r) => done(r && r.__e2e));
        });`,
      args: [],
    });
    check('storage.local round-trips with callbacks', stored === 'radbro', String(stored));

    // full wallet creation in the popup — vault seal, seed backup gate, HD keys
    await clickText('MAKE A NEW WALLET');
    await type('input[placeholder="password"]', 'hunter2hunter2rad');
    await type('input[placeholder="password again"]', 'hunter2hunter2rad');
    await clickText('GENERATE SEED', 'button');
    const seedWords = await waitFor(async () => {
      const n = await wd('POST', `${S()}/execute/sync`, {
        script: 'const b = document.querySelector(".seedbox"); return b ? b.innerText.trim().split(/\\s+/).length : 0',
        args: [],
      });
      return n > 0 ? n : false;
    }, 'seed to be generated', 40000);
    check('wallet creation generates a seed', seedWords >= 12, `${seedWords} words`);

    await click('label.row input[type=checkbox]');
    await clickText('ENTER THE WEBRING', 'button');
    const acct = await waitFor(async () => {
      const t = await text();
      return /0x[0-9a-fA-F]{4}/.test(t) ? t : false;
    }, 'home screen with an address', 40000);
    check('keyring derived an account (home screen)', /0x[0-9a-fA-F]{4}/.test(acct));
    // ---- address book: callback storage, saved-contact label, send surface --
    await clickText('SETTINGS', '.tabbar .tab');
    await waitFor(async () => (await text()).includes('ADDRESS BOOK'), 'the settings index with address book');
    await clickText('ADDRESS BOOK', '.setrowlink');
    await waitFor(async () => (await text()).includes('Saved on this device'), 'the address book section');
    await clickText('+ ADD ADDRESS', 'button');
    await type('input[aria-label="contact address"]', FIREFOX_ADDRESS_BOOK_CONTACT);
    await type('input[aria-label="address label"]', 'firefox friend');
    await clickText('SAVE ADDRESS', 'button');
    await waitFor(async () => (await text()).includes('firefox friend'), 'saved address label');
    const firefoxContacts = await wd('POST', `${S()}/execute/async`, {
      script: `const done = arguments[0];
        chrome.storage.local.get('addressBook', (r) => {
          try { done(JSON.parse(r.addressBook || '[]')); }
          catch (e) { done({ error: e.message, raw: r.addressBook }); }
        });`,
      args: [],
    });
    check('firefox address book saves through storage.local callbacks',
      Array.isArray(firefoxContacts) &&
        firefoxContacts.some((row) => row.address.toLowerCase() === FIREFOX_ADDRESS_BOOK_CONTACT && row.label === 'firefox friend'),
      JSON.stringify(firefoxContacts));
    await clickText('HOME', '.tabbar .tab');
    await waitFor(async () => (await text()).includes('RECEIVE'), 'home before address-book send check');
    await clickText('SEND', 'button');
    await waitFor(async () => (await text()).includes('ADDRESS BOOK'), 'send sheet with address book');
    await type('input[aria-label="recipient address"]', FIREFOX_ADDRESS_BOOK_CONTACT);
    const sendLabel = await wd('POST', `${S()}/execute/sync`, {
      script: `const row = document.querySelector('.send-recipient .labeled-address');
        return row ? {
          label: row.querySelector('.address-label')?.textContent || '',
          value: row.querySelector('.address-value')?.textContent || '',
          html: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
          viewport: document.documentElement.clientWidth,
        } : null;`,
      args: [],
    });
    check('firefox send recipient shows the saved address label',
      sendLabel?.label.includes('firefox friend') &&
        sendLabel?.value.toLowerCase() === FIREFOX_ADDRESS_BOOK_CONTACT &&
        sendLabel.html <= sendLabel.viewport + 1 &&
        sendLabel.body <= sendLabel.viewport + 1,
      JSON.stringify(sendLabel));
    await saveScreenshot('addressbook-firefox-send.png');
    await click('.drawerhead .x');
    await waitFor(async () => !(await text()).includes('recipient address'), 'send sheet to close');

    // ---- bring your own node: plaintext, but only to your own machine ----
    // The whole point of the RPC pool is that you can replace it. Chrome proves
    // this against a real anvil fork (scripts/e2e/anvil.e2e.cjs); here it is the
    // portability question — a moz-extension:// page fetching http://127.0.0.1
    // with no host permissions.
    const OWN_NODE = `http://127.0.0.1:${NODE_PORT}`;
    // SETTINGS is an index of rows now; the pool lives one level in
    await clickText('SETTINGS', '.tabbar .tab');
    await waitFor(async () => (await text()).includes('PRIVACY'), 'the settings index');
    await clickText('NETWORKS', '.setrowlink');
    await waitFor(async () => (await text()).includes('RPC POOL'), 'the networks section');
    // typing and clicking must be two turns: the input event only queues a
    // state update, so an ADD clicked in the same tick reads the old value
    const typeInPool = async (value) => {
      await wd('POST', `${S()}/execute/sync`, {
        script: `const panel = [...document.querySelectorAll('.panel')]
            .find((p) => p.querySelector('.hd') && p.querySelector('.hd').textContent.includes('RPC POOL'));
          if (!panel) return false;
          const inp = panel.querySelector('input.field');
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          set.call(inp, arguments[0]);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          return true;`,
        args: [value],
      });
      await sleep(300);
      return wd('POST', `${S()}/execute/sync`, {
        script: `const panel = [...document.querySelectorAll('.panel')]
            .find((p) => p.querySelector('.hd') && p.querySelector('.hd').textContent.includes('RPC POOL'));
          const add = [...panel.querySelectorAll('button')].find((b) => b.textContent.trim() === 'ADD');
          if (!add) return false;
          add.click();
          return true;`,
        args: [],
      });
    };
    const poolRows = () => wd('POST', `${S()}/execute/sync`, {
      script: `const panel = [...document.querySelectorAll('.panel')]
          .find((p) => p.querySelector('.hd') && p.querySelector('.hd').textContent.includes('RPC POOL'));
        return [...panel.querySelectorAll('.rpcrow .ep')].map((e) => e.textContent.trim());`,
      args: [],
    });
    const shipped = await poolRows();
    await typeInPool('http://an.example.com');
    await sleep(1500);
    check('firefox: plaintext http to the internet is refused',
      (await poolRows()).length === shipped.length);
    await typeInPool(OWN_NODE);
    const added = await waitFor(async () => {
      const rows = await poolRows();
      return rows.includes(OWN_NODE) ? rows : false;
    }, 'the local node to be accepted', 20000).catch(() => []);
    check('firefox: a node on your own machine is reachable and accepted',
      added.includes(OWN_NODE), JSON.stringify(added));
    // SETTINGS is a tab-bar screen: the bar is the way back, and the screen's
    // own "\u2190 back" was a second control for the same job
    await clickText('HOME', '.tabbar .tab');
    await waitFor(async () => !(await text()).includes('RPC POOL'), 'settings to close');

    // ---- docking: Firefox registers a sidebar, not a side panel ----
    // ask the browser itself what it registered, from the chrome context
    await wd('POST', `${S()}/moz/context`, { context: 'chrome' });
    const sidebar = await wd('POST', `${S()}/execute/sync`, {
      script: `const key = [...SidebarController.sidebars.keys()].find((k) => /radwallet/i.test(k));
        if (!key) return null;
        const d = SidebarController.sidebars.get(key);
        return { key, title: d.title, extensionId: d.extensionId, menuId: d.menuId };`,
      args: [],
    });
    await wd('POST', `${S()}/moz/context`, { context: 'content' });
    check('firefox registers the wallet as a sidebar', sidebar?.extensionId === ADDON_ID,
      sidebar ? `${sidebar.key} "${sidebar.title}"` : 'not registered');

    // and the docked page knows it is docked
    await gotoExtensionPage(`moz-extension://${EXT_UUID}/index.html?panel=1`);
    // both pages say RADWALLET, so waiting on the text can match the one we
    // just navigated AWAY from — wait for the URL that carries the flag
    // location.search is set the moment navigation commits, well before the
    // app module runs — wait for BOTH the flag and a rendered titlebar
    await waitFor(
      async () => wd('POST', `${S()}/execute/sync`, {
        script: `return location.search.includes('panel=1') && !!document.querySelector('.titlebar');`,
        args: [],
      }),
      'the docked page to render',
    );
    const dockState = await wd('POST', `${S()}/execute/sync`, {
      script: `const b = document.querySelector('.titlebar .dock');
        return { docked: document.body.classList.contains('docked'), btn: b && b.textContent };`,
      args: [],
    });
    check('docked page renders in undock mode', dockState?.docked === true && dockState?.btn === '[UNDOCK]',
      JSON.stringify(dockState));
    await setContentViewport(520, 900);
    let headerGeometry = await captureTitlebarGeometry('header-wallet-firefox-docked.png');
    check('firefox docked wallet header contains its visible children', headerGeometry.ok === true, JSON.stringify(headerGeometry));
    await clickPortfolio();
    await waitFor(async () => (await portfolioState()).page, 'docked portfolio for header check');
    headerGeometry = await captureTitlebarGeometry();
    check('firefox docked portfolio header contains its visible children', headerGeometry.ok === true, JSON.stringify(headerGeometry));
    await clickText('Wallet', '.portfolio-nav button');
    await waitFor(async () => (await text()).includes('RECEIVE'), 'docked wallet after portfolio header check');
    headerGeometry = await captureTitlebarGeometry();
    check('firefox docked wallet header still fits after portfolio round trip', headerGeometry.ok === true, JSON.stringify(headerGeometry));

    await gotoExtensionPage(popup);
    await waitFor(
      async () => wd('POST', `${S()}/execute/sync`, {
        script: `return !location.search.includes('panel=1') && !!document.querySelector('.titlebar');`,
        args: [],
      }),
      'the popup page to render',
    );
    const popState = await wd('POST', `${S()}/execute/sync`, {
      script: `const b = document.querySelector('.titlebar .dock'); return b && b.textContent;`,
      args: [],
    });
    check('popup offers to dock', popState === '[DOCK]', String(popState));
    await setContentViewport(372, 600);
    headerGeometry = await captureTitlebarGeometry('header-wallet-firefox-popup.png');
    check('firefox popup wallet header contains its visible children', headerGeometry.ok === true, JSON.stringify(headerGeometry));
    await clickPortfolio();
    await waitFor(async () => (await portfolioState()).page, 'popup portfolio for header check');
    headerGeometry = await captureTitlebarGeometry();
    check('firefox popup portfolio header contains its visible children', headerGeometry.ok === true, JSON.stringify(headerGeometry));
    await clickText('Wallet', '.portfolio-nav button');
    await waitFor(async () => (await text()).includes('RECEIVE'), 'popup wallet after portfolio header check');
    headerGeometry = await captureTitlebarGeometry();
    check('firefox popup wallet header still fits after portfolio round trip', headerGeometry.ok === true, JSON.stringify(headerGeometry));

    // ---- portfolio: popup and sidebar share the same read-only view prefs ---
    const popupViewport = await setContentViewport(372, 600);
    await clickPortfolio();
    await waitFor(async () => (await portfolioState()).page, 'portfolio page to render');
    let popPortfolio = await portfolioState();
    check('firefox popup portfolio renders the compact shell',
      popPortfolio.page && popPortfolio.filters &&
        ['Assets', 'Wallets', 'Seed groups'].every((g) => popPortfolio.groupings.includes(g)),
      JSON.stringify(popPortfolio));
    check('firefox popup portfolio has no horizontal overflow at 372x600',
      popPortfolio.layout.html <= popPortfolio.layout.viewport + 1 &&
        popPortfolio.layout.body <= popPortfolio.layout.viewport + 1 &&
        popPortfolio.smallControls.length === 0,
      JSON.stringify({ requested: { width: 372, height: 600 }, actual: popupViewport,
        layout: popPortfolio.layout, overflowElements: popPortfolio.overflowElements }));
    await saveScreenshot('portfolio-firefox-popup-usd.png');
    await setPortfolioCurrency('ETH');
    popPortfolio = await portfolioState();
    check('firefox portfolio ETH mode does not show USD values',
      popPortfolio.selected === 'ETH' && !popPortfolio.total.usd,
      JSON.stringify(popPortfolio.total));
    await saveScreenshot('portfolio-firefox-popup-eth.png');
    const filterDialog = await openAndClosePortfolioFilters('portfolio-firefox-filters.png');
    check('firefox portfolio filters are a solid modal sheet',
      filterDialog?.modal === 'true' && filterDialog.focusInside &&
        filterDialog.underlayInert &&
        ['Wallets', 'Assets', 'Networks', 'Select all', 'Clear selection', 'Reset filters', 'Done']
          .every((name) => filterDialog.tabs.includes(name)),
      JSON.stringify(filterDialog));
    await gotoExtensionPage(popup);
    await waitFor(async () => (await text()).includes('RADWALLET'), 'popup before portfolio reload check');
    await clickPortfolio();
    popPortfolio = await portfolioState();
    check('firefox portfolio display unit survives popup reload',
      popPortfolio.selected === 'ETH', JSON.stringify(popPortfolio));
    await gotoExtensionPage(`moz-extension://${EXT_UUID}/index.html?panel=1`);
    await waitFor(
      async () => wd('POST', `${S()}/execute/sync`, {
        script: `return location.search.includes('panel=1') && !!document.querySelector('.titlebar');`,
        args: [],
      }),
      'docked page before portfolio preference check',
    );
    const dockedViewport = await setContentViewport(520, 900);
    await clickPortfolio();
    const dockedPortfolio = await portfolioState();
    check('firefox docked portfolio shares the persisted display unit and reflows',
      dockedPortfolio.selected === 'ETH' &&
        dockedPortfolio.layout.html <= dockedPortfolio.layout.viewport + 1 &&
        dockedPortfolio.layout.body <= dockedPortfolio.layout.viewport + 1,
      JSON.stringify({ requested: { width: 520, height: 900 }, actual: dockedViewport,
        layout: dockedPortfolio.layout, overflowElements: dockedPortfolio.overflowElements }));
    await saveScreenshot('portfolio-firefox-docked900.png');
    await setPortfolioCurrency('USD');
    await gotoExtensionPage(popup);
    await waitFor(async () => (await text()).includes('RADWALLET'), 'popup after docked portfolio change');
    await clickPortfolio();
    popPortfolio = await portfolioState();
    check('firefox docked portfolio setting persists back to popup',
      popPortfolio.selected === 'USD' && !popPortfolio.total.eth,
      JSON.stringify(popPortfolio));
    await clickText('Wallet', '.portfolio-nav button');
    await clickText('HOME', '.tabbar .tab');
    await waitFor(async () => (await text()).includes('RECEIVE'), 'home after portfolio checks');
    await wd('POST', `${S()}/window/rect`, { width: 390, height: 740 }).catch(() => null);

    // ---- the dapp path: content script -> background -> approval window ----
    await wd('POST', `${S()}/url`, { url: `http://127.0.0.1:${DAPP_PORT}/` });
    const injected = await waitFor(
      () => wd('POST', `${S()}/execute/sync`, {
        script: 'return !!(window.ethereum && window.ethereum.isRadwallet)', args: [],
      }),
      'inpage provider injection',
    );
    check('content script injects the EIP-1193 provider into a page', injected === true);

    const announced = await wd('POST', `${S()}/execute/async`, {
      script: `const done = arguments[0];
        let seen = null;
        window.addEventListener('eip6963:announceProvider', (e) => { seen = e.detail.info.rdns; });
        window.dispatchEvent(new Event('eip6963:requestProvider'));
        setTimeout(() => done(seen), 300);`,
      args: [],
    });
    check('EIP-6963 announce reaches the page', announced === 'xyz.radbro.radwallet', String(announced));

    const chainHex = await wd('POST', `${S()}/execute/async`, {
      script: `const done = arguments[0];
        window.ethereum.request({ method: 'eth_chainId' }).then(done, (e) => done('ERR:' + e.message));`,
      args: [],
    });
    check('read-only RPC routes through the background', chainHex === '0x1', String(chainHex));

    // eth_requestAccounts opens the approval window: park the promise, drive
    // the approval in the other window, then come back for the result
    const dappWindow = await wd('GET', `${S()}/window`);
    await wd('POST', `${S()}/execute/sync`, {
      script: `window.__radReq = window.ethereum.request({ method: 'eth_requestAccounts' })
        .then((a) => 'OK:' + a[0]).catch((e) => 'ERR:' + e.message);
      return true;`,
      args: [],
    });
    const approvalWindow = await waitFor(async () => {
      const handles = await wd('GET', `${S()}/window/handles`);
      return handles.find((h) => h !== dappWindow) || false;
    }, 'the approval window to open');
    await wd('POST', `${S()}/window`, { handle: approvalWindow });
    await waitFor(async () => (await text()).includes('SITE WANTS TO SEE YOU'), 'the connect prompt');
    check('approval window opens with the connect prompt', true);
    await clickText('CONNECT', 'button');

    await wd('POST', `${S()}/window`, { handle: dappWindow });
    const connected = await wd('POST', `${S()}/execute/async`, {
      script: 'const done = arguments[0]; window.__radReq.then(done);', args: [],
    });
    check('dapp receives the approved account', /^OK:0x[0-9a-fA-F]{40}$/.test(connected), connected);

    // Closing the approval window itself is a refusal. Exercise the browser
    // window lifecycle rather than the REFUSE button, then continue into the
    // chain-switch approval below to prove the pending entry was removed.
    const connectedAddress = connected.slice(3);

    // The sitebar mismatch has two repairs: switch the owner view back to the
    // connected wallet, or switch the site connection to the selected wallet.
    await wd('POST', `${S()}/execute/sync`, {
      script: `window.__radAccountEvents = [];
        window.ethereum.on('accountsChanged', (value) => window.__radAccountEvents.push(value));
        return true;`,
      args: [],
    });
    const sitebarWindow = (await wd('POST', `${S()}/window/new`, { type: 'window' })).handle;
    await wd('POST', `${S()}/window`, { handle: sitebarWindow });
    await gotoExtensionPage(popup);
    await setContentViewport(390, 740);
    await waitFor(async () => (await text()).includes('RECEIVE'), 'sitebar popup home');
    await click('.acctbar button.who');
    await waitFor(() => $('.drawerbox'), 'wallet drawer for second wallet');
    await click('.ghead button.more');
    await clickText('+ new wallet', 'button');
    await sleep(1000);
    if (await $('.drawerhead .x')) await click('.drawerhead .x');
    await waitFor(async () => !(await $('.drawerbox')), 'wallet drawer to close after second wallet');
    await gotoExtensionPage(popup);
    const mismatchShown = await waitFor(() => wd('POST', `${S()}/execute/sync`, {
      script: `const b = document.querySelector('.sitebar .switch-wallet');
        if (!b) return false;
        return {
          text: b.textContent.trim(),
          tag: b.tagName,
          sitebar: !!b.closest('.sitebar'),
          use: [...document.querySelectorAll('.sitebar button')]
            .some((button) => button.textContent.trim().toLowerCase() === 'use wallet 2'),
        };`,
      args: [],
    }), 'connected-wallet switch in the sitebar');
    check('firefox sitebar shows the connected-wallet switch action',
      mismatchShown.text === 'switch to connected wallet' && mismatchShown.tag === 'BUTTON' &&
        mismatchShown.sitebar && mismatchShown.use,
      JSON.stringify(mismatchShown));
    await setContentViewport(372, 600);
    await saveScreenshot('sitebar-connected-wallet-firefox.png');
    await setContentViewport(390, 740);
    const beforeLocalSwitch = await wd('POST', `${S()}/execute/async`, {
      script: `const done = arguments[0];
        chrome.storage.local.get('connections', (r) => done(r.connections || null));`,
      args: [],
    });
    await click('.sitebar .switch-wallet');
    await waitFor(() => wd('POST', `${S()}/execute/sync`, {
      script: `return !!document.querySelector('.sitebar.on') && !document.querySelector('.sitebar .switch-wallet');`,
      args: [],
    }), 'local switch to connected wallet to settle');
    await sleep(400);
    const afterLocalSwitchStore = await wd('POST', `${S()}/execute/async`, {
      script: `const done = arguments[0];
        chrome.storage.local.get('connections', (r) => done(r.connections || null));`,
      args: [],
    });
    await wd('POST', `${S()}/window`, { handle: dappWindow });
    const afterLocalSwitchDapp = await wd('POST', `${S()}/execute/async`, {
      script: `const done = arguments[0];
        Promise.all([
          window.ethereum.request({ method: 'eth_accounts' }),
          Promise.resolve(window.__radAccountEvents),
        ]).then(([accounts, events]) => done({ accounts, events }));`,
      args: [],
    });
    check('firefox connected-wallet switch only changes the local selected wallet',
      afterLocalSwitchDapp.accounts?.[0]?.toLowerCase() === connectedAddress.toLowerCase() &&
        afterLocalSwitchDapp.events?.length === 0 &&
        afterLocalSwitchStore === beforeLocalSwitch,
      JSON.stringify({ beforeLocalSwitch, afterLocalSwitchStore, afterLocalSwitchDapp }));

    await wd('POST', `${S()}/window`, { handle: sitebarWindow });
    await click('.acctbar button.who');
    await waitFor(() => $('.drawerbox'), 'wallet drawer to select Wallet 2');
    await click('.walletrow:not(.sel) .pick');
    await waitFor(async () => !(await $('.drawerbox')), 'wallet drawer to close after selecting Wallet 2');
    await waitFor(() => $('.sitebar .switch-wallet'), 'sitebar mismatch after selecting Wallet 2');
    await wd('POST', `${S()}/execute/sync`, {
      script: `const b = [...document.querySelectorAll('.sitebar button')]
          .find((button) => button.textContent.trim().toLowerCase() === 'use wallet 2');
        if (!b) return false;
        b.click();
        return true;`,
      args: [],
    });
    await waitFor(() => wd('POST', `${S()}/execute/sync`, {
      script: `return !!document.querySelector('.sitebar.on') && !document.querySelector('.sitebar .switch-wallet');`,
      args: [],
    }), 'site switch to Wallet 2 to settle');
    await sleep(400);
    await wd('POST', `${S()}/window`, { handle: dappWindow });
    const afterSiteSwitch = await wd('POST', `${S()}/execute/async`, {
      script: `const done = arguments[0];
        Promise.all([
          window.ethereum.request({ method: 'eth_accounts' }),
          Promise.resolve(window.__radAccountEvents),
        ]).then(([accounts, events]) => done({ accounts, events }));`,
      args: [],
    });
    check('firefox use Wallet 2 still switches and notifies the site',
      afterSiteSwitch.accounts?.[0]?.toLowerCase() !== connectedAddress.toLowerCase() &&
        afterSiteSwitch.events?.some((event) => event?.[0]?.toLowerCase() === afterSiteSwitch.accounts[0].toLowerCase()),
      JSON.stringify(afterSiteSwitch));

    await wd('POST', `${S()}/window`, { handle: sitebarWindow });
    await click('.acctbar button.who');
    await waitFor(() => $('.drawerbox'), 'wallet drawer to restore Wallet 1');
    await click('.walletrow:not(.sel) .pick');
    await waitFor(async () => !(await $('.drawerbox')), 'wallet drawer to close after selecting Wallet 1');
    await waitFor(() => $('.sitebar .switch-wallet'), 'sitebar mismatch before restoring Wallet 1');
    await wd('POST', `${S()}/execute/sync`, {
      script: `const b = [...document.querySelectorAll('.sitebar button')]
          .find((button) => button.textContent.trim().toLowerCase() === 'use wallet 1');
        if (!b) return false;
        b.click();
        return true;`,
      args: [],
    });
    await waitFor(() => wd('POST', `${S()}/execute/async`, {
      script: `const expected = arguments[0];
        const done = arguments[1];
        chrome.storage.local.get('connections', (r) => {
          try {
            const map = JSON.parse(r.connections || '{}');
            done(map['http://127.0.0.1:18928']?.[0]?.toLowerCase() === expected.toLowerCase());
          } catch { done(false); }
        });`,
      args: [connectedAddress],
    }), 'site connection restored to Wallet 1');
    await wd('DELETE', `${S()}/window`);
    await wd('POST', `${S()}/window`, { handle: dappWindow });

    await wd('POST', `${S()}/execute/sync`, {
      script: `window.__radClosedApproval = window.ethereum.request({
          method: 'personal_sign', params: ['0x726164', arguments[0]]
        }).then(() => 'SIGNED').catch((e) => 'ERR:' + e.code + ':' + e.message);
        return true;`,
      args: [connectedAddress],
    });
    const closedApprovalWindow = await waitFor(async () => {
      const handles = await wd('GET', `${S()}/window/handles`);
      return handles.find((h) => h !== dappWindow) || false;
    }, 'the closable approval window to open');
    await wd('POST', `${S()}/window`, { handle: closedApprovalWindow });
    await waitFor(async () => (await text()).includes('SITE WANTS A SIGNATURE'), 'the closable signature prompt');
    await wd('DELETE', `${S()}/window`);
    await wd('POST', `${S()}/window`, { handle: dappWindow });
    const closedApproval = await wd('POST', `${S()}/execute/async`, {
      script: `const done = arguments[0]; Promise.race([
          window.__radClosedApproval,
          new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 5000))
        ]).then(done);`,
      args: [],
    });
    check('closing approval window refuses with 4001',
      closedApproval.startsWith('ERR:4001:') && closedApproval.includes('closed'), closedApproval);

    // A dapp can request Robinhood immediately after connecting. The switch is a
    // separate wallet decision: it must open a prompt and emit chainChanged,
    // not return 4001 before the user has seen anything.
    await waitFor(async () => {
      const handles = await wd('GET', `${S()}/window/handles`);
      return !handles.includes(approvalWindow);
    }, 'the connect approval to close');
    await wd('POST', `${S()}/execute/sync`, {
      script: `window.__radEvents = [];
        window.ethereum.on('chainChanged', (id) => window.__radEvents.push(id));
        window.__radSwitch = window.ethereum.request({
          method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1237' }]
        }).then((r) => r === null ? 'OK:null' : 'OK:' + String(r))
          .catch((e) => 'ERR:' + e.code + ':' + e.message);
        return true;`,
      args: [],
    });
    const switchWindow = await waitFor(async () => {
      const handles = await wd('GET', `${S()}/window/handles`);
      return handles.find((h) => h !== dappWindow) || false;
    }, 'the chain switch approval to open');
    await wd('POST', `${S()}/window`, { handle: switchWindow });
    await waitFor(async () => (await text()).includes('SITE WANTS TO SWITCH NETWORKS'), 'the chain switch prompt');
    check('chain switch opens a wallet prompt', true);
    await clickText('SWITCH', 'button');
    await wd('POST', `${S()}/window`, { handle: dappWindow });
    const switched = await wd('POST', `${S()}/execute/async`, {
      script: `const done = arguments[0]; window.__radSwitch.then(async (result) => done({
        result,
        chain: await window.ethereum.request({ method: 'eth_chainId' }),
        events: window.__radEvents,
      }));`,
      args: [],
    });
    check('approved chain switch lands and notifies the dapp',
      switched?.result === 'OK:null' && switched?.chain === '0x1237' && switched?.events?.includes('0x1237'),
      JSON.stringify(switched));

    await waitFor(async () => {
      const handles = await wd('GET', `${S()}/window/handles`);
      return !handles.includes(switchWindow);
    }, 'the chain switch approval to close');

    // Unsupported provider methods return 4200 without opening an approval.
    const handlesBefore = await wd('GET', `${S()}/window/handles`);
    for (const calls of [[], [{ to: connectedAddress, value: '0x1', data: '0x' }]]) {
      const unsupported = await wd('POST', `${S()}/execute/async`, {
        script: `const from = arguments[0], calls = arguments[1], done = arguments[2];
          window.ethereum.request({ method: 'wallet_sendCalls', params: [{
            version: '2.0.0', chainId: '0x1237', from, atomicRequired: false, calls
          }] }).then((r) => done('OK:' + JSON.stringify(r)))
            .catch((e) => done('ERR:' + e.code + ':' + e.message));`,
        args: [connectedAddress, calls],
      });
      check('unsupported provider call returns 4200', unsupported.startsWith('ERR:4200:'), unsupported);
    }
    const handlesAfter = await wd('GET', `${S()}/window/handles`);
    check('unsupported provider calls open no approval window', handlesAfter.length === handlesBefore.length);
    await gotoExtensionPage(popup);
    await waitFor(async () => (await text()).includes('RADWALLET'), 'popup before event-page idle');

    // Finish with the ordinary event-page idle path, after every approval
    // whose pending request intentionally lives in that page. Accelerate only
    // this final idle window: the browser default is ~30s, and one second gives
    // the suite the same restart without sleeping half a minute.
    await wd('POST', `${S()}/moz/context`, { context: 'chrome' });
    await wd('POST', `${S()}/execute/sync`, {
      script: `Services.prefs.setIntPref('extensions.background.idle.timeout', 1); return true;`,
      args: [],
    });
    await wd('POST', `${S()}/moz/context`, { context: 'content' });
    await sleep(2500);
    await gotoExtensionPage(popup);
    await waitFor(async () => (await text()).includes('RADWALLET'), 'popup after event-page idle');
    const resumedSession = await wd('POST', `${S()}/execute/async`, {
      script: `const done = arguments[0];
        chrome.runtime.sendMessage({ t: 'sess.signMessage', index: 0, message: 'firefox focus is not lock' }, (r) => {
          done({ sig: r && r.sig, error: (r && r.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) });
        });`,
      args: [],
    });
    check('firefox event-page restart resumes the configured session and signs',
      /^0x[0-9a-f]{130}$/i.test(resumedSession?.sig ?? ''), JSON.stringify(resumedSession));
    // Drawer layout uses callback-backed preferences, independently of vault
    // order. Re-unlock after the event-page restart to allow the fixture import.
    {
      const ui = (script, args = []) => wd('POST', `${S()}/execute/sync`, { script, args });
      await wd('POST', `${S()}/moz/context`, { context: 'chrome' });
      await wd('POST', `${S()}/execute/sync`, {
        script: "Services.prefs.setIntPref('extensions.background.idle.timeout', 30000); return true;", args: [],
      });
      await wd('POST', `${S()}/moz/context`, { context: 'content' });
      await gotoExtensionPage(popup);
      await waitFor(async () => (await $('.portfolio-nav')) || (await $('.pwform')), 'wallet before layout checks');
      if (!(await $('.pwform'))) {
        await clickText('Wallet', '.portfolio-nav button');
        await click('.acctbar button.who');
        await clickText('LOCK IT', 'button');
      }
      await type('input[name=password]', 'hunter2hunter2rad');
      await click('.pwform button[type=submit]');
      await click('.acctbar button.who');
      await clickText('+ ADD WALLET', 'button');
      await clickText('IMPORT A SEED PHRASE', 'button');
      await type('.drawerbox textarea', 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above');
      await type('.drawerbox input[placeholder="nickname (optional)"]', 'firefox layout seed');
      await click('.addform .btnrow .btn:not(.ghost)');
      await waitFor(async () => !(await $('.drawerbox')), 'import to finish');
      if (await $('.toast .x')) await click('.toast .x');
      await click('.acctbar button.who');
      const originalOrder = await ui('return [...document.querySelectorAll(".walletgroup")].map(g => g.dataset.groupId)');
      const original = originalOrder[0];
      const added = originalOrder[originalOrder.length - 1];
      const addedGroup = `.walletgroup[data-group-id="${added}"]`;
      const originalGroup = `.walletgroup[data-group-id="${original}"]`;
      const selectedAddress = await ui('return document.querySelector(".walletrow.sel .addr").firstChild.textContent.trim()');
      const clickGroupToggle = async (group) => {
        // Native WebDriver scrolling does not emit a wheel event. Stop the
        // drawer's initial selection centering as a user scroll would, then
        // keep the actual click under WebDriver's interactability checks.
        await wd('POST', `${S()}/execute/async`, {
          script: `const selector = arguments[0], done = arguments[1];
            const button = document.querySelector(selector);
            button.closest('.drawerbox').dispatchEvent(new WheelEvent('wheel', {
              bubbles: true, deltaY: 1,
            }));
            requestAnimationFrame(() => requestAnimationFrame(() => {
              button.scrollIntoView({ block: 'center' });
              done(true);
            }));`,
          args: [`${group} .group-toggle`],
        });
        await click(`${group} .group-toggle`);
      };
      await clickGroupToggle(addedGroup);
      await waitFor(async () => (await ui('return document.querySelector(arguments[0]).getAttribute("aria-expanded")', [`${addedGroup} .group-toggle`])) === 'false', 'seed collapse');
      check('firefox collapse keeps the selected seed identifiable', await ui('return !!document.querySelector(arguments[0] + " .group-selected") && !document.querySelector(arguments[0] + " .walletrow")', [addedGroup]));
      await clickGroupToggle(originalGroup);
      await waitFor(async () => !(await $('.walletrow')), 'both seeds to collapse');
      // Marionette does not complete native HTML5 drops reliably (Mozilla
      // bug 1515879). Exercise Firefox's actual handlers with DOM drag events;
      // native pointer dragging is covered separately by the Chromium suite.
      const dragAccepted = await ui(`
        const source = document.querySelector(arguments[0]);
        const target = document.querySelector(arguments[1]);
        const bounds = target.getBoundingClientRect();
        const dataTransfer = new DataTransfer();
        const init = { bubbles: true, cancelable: true, dataTransfer,
          clientX: bounds.left + 8, clientY: bounds.top + 2 };
        source.dispatchEvent(new DragEvent('dragstart', init));
        const over = new DragEvent('dragover', init);
        target.dispatchEvent(over);
        target.dispatchEvent(new DragEvent('drop', init));
        source.dispatchEvent(new DragEvent('dragend', init));
        return over.defaultPrevented && dataTransfer.effectAllowed === 'move';
      `, [`${addedGroup} .group-drag`, `${originalGroup} .ghead`]);
      await waitFor(async () => (await ui('return document.querySelector(".walletgroup").dataset.groupId')) === added, 'seed drop handlers to reorder');
      check('firefox drag/drop handlers reorder collapsed seeds (synthetic events)', dragAccepted);
      await click(`${addedGroup} .group-drag`);
      await clickText('move seed down', 'button');
      await waitFor(async () => (await ui('return document.querySelector(".walletgroup").dataset.groupId')) === original, 'move-down alternative');
      check('firefox move buttons provide a drag alternative', true);
      const savedLayout = await wd('POST', `${S()}/execute/async`, {
        script: 'const done = arguments[0]; chrome.storage.local.get("walletList", r => done(JSON.parse(r.walletList)));', args: [],
      });
      check('firefox saves order and collapses with callback storage',
        savedLayout.order.join() === originalOrder.join() && savedLayout.collapsed.includes(original) && savedLayout.collapsed.includes(added));
      await gotoExtensionPage(popup);
      await click('.acctbar button.who');
      await waitFor(async () => !!(await $(`${addedGroup} .group-selected`)), 'collapsed selection after reload');
      check('firefox reloaded drawer preserves collapsed groups', !(await $('.walletrow')));
      await clickGroupToggle(addedGroup);
      await waitFor(() => $('.walletrow.sel'), 'selected wallet after expansion');
      check('firefox reorder preserves the selected address',
        (await ui('return document.querySelector(".walletrow.sel .addr").firstChild.textContent.trim()')) === selectedAddress);
    }

    void caps;
  } catch (e) {
    console.error('FAIL', e.message);
    failures++;
  } finally {
    if (sessionId) await wd('DELETE', S()).catch(() => {});
    bye();
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nfirefox: all checks passed');
  process.exit(failures ? 1 : 0);
})();
