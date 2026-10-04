/** Focused wallet-list collapse and seed-order regressions. */
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright-core');

const PASSWORD = 'wallet list fixture password';
const FIRST_SEED = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const SECOND_SEED = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const THIRD_SEED = 'test test test test test test test test test test test junk';
const PRIVATE_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const url = process.env.WALLET_LIST_URL
  || pathToFileURL(resolve(__dirname, '../../apps/wallet/dist-demo/index.html')).href;
const screenshotDir = process.env.WALLET_LIST_SHOTS;

async function idbDump(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('radwallet', 1);
    request.onerror = () => reject(request.error || new Error('open failed'));
    request.onsuccess = () => {
      const tx = request.result.transaction('kv', 'readonly');
      const store = tx.objectStore('kv');
      const keys = store.getAllKeys();
      const values = store.getAll();
      tx.oncomplete = () => resolve(Object.fromEntries(keys.result.map((key, i) => [key, values.result[i]])));
      tx.onerror = () => reject(tx.error || new Error('read failed'));
      tx.onabort = () => reject(tx.error || new Error('read aborted'));
    };
  }));
}

(async () => {
  const browser = await chromium.launch({
    channel: process.env.E2E_CHANNEL || 'chromium',
    executablePath: process.env.CHROME_PATH || undefined,
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 372, height: 600 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    await context.route(/^https?:\/\//, (route) => {
      const target = new URL(route.request().url());
      if (['127.0.0.1', 'localhost'].includes(target.hostname)) return route.continue();
      return route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => { errors.push(error.message); console.error('PAGE ERROR:', error.message); });
    const drawer = page.locator('.drawerbox');
    const button = (name) => drawer.getByRole('button', { name, exact: true });
    const groups = () => drawer.locator('.walletgroup');
    const group = (label) => groups().filter({ has: page.locator(`.gname:text-is("${label}")`) }).first();
    const seedNames = () => drawer.locator('.walletgroup:not([data-group-id="imported"]) .gname').allTextContents();
    const groupIds = () => groups().evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-group-id')));
    const waitSeedOrder = async (expected) => {
      await page.waitForFunction((want) => JSON.stringify(
        [...document.querySelectorAll('.walletgroup:not([data-group-id="imported"]) .gname')]
          .map((node) => node.textContent),
      ) === JSON.stringify(want), expected);
    };
    const selectedIdentity = async () => ({
      wallet: ((await page.locator('.acctbar button.who').textContent()) || '').trim(),
      group: ((await page.locator('.acctsub').textContent().catch(() => '')) || '').trim(),
      address: ((await page.locator('.addrcopy').textContent().catch(() => '')) || '').trim(),
    });
    const snapshot = async (name) => {
      if (!screenshotDir) return;
      assert.equal(await page.locator('.secretbox').count(), 0, 'screenshots must not contain a revealed secret');
      await page.mouse.move(365, 5);
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      mkdirSync(screenshotDir, { recursive: true });
      await page.screenshot({ path: resolve(screenshotDir, `${name}.png`) });
    };
    const closeDrawer = async () => {
      await drawer.locator('.drawerhead .x').click();
      await drawer.waitFor({ state: 'detached' });
    };
    const dismissToast = async () => {
      const close = page.locator('.toast .x');
      if (await close.count()) await close.click();
    };
    const openDrawer = async () => {
      await dismissToast();
      await page.locator('.acctbar button.who').click();
      await drawer.waitFor();
    };
    const unlockIfNeeded = async () => {
      await page.waitForFunction(() =>
        document.querySelector('.acctbar') || document.querySelector('input[placeholder="password"]'));
      if (await page.locator('input[placeholder="password"]').count()) {
        await page.locator('input[placeholder="password"]').fill(PASSWORD);
        await page.getByRole('button', { name: 'UNLOCK', exact: true }).click();
      }
      await page.locator('.acctbar').waitFor();
    };
    const importWallet = async (kind, value, nickname) => {
      await openDrawer();
      await button('+ ADD WALLET').click();
      await button(kind).click();
      await drawer.locator('textarea').fill(value);
      await drawer.locator('input[placeholder="nickname (optional)"]').fill(nickname);
      await button('IMPORT').click();
      await drawer.waitFor({ state: 'detached' });
    };
    const makeFixture = async () => {
      await page.goto(url);
      await page.getByRole('button', { name: 'I ALREADY HAVE ONE', exact: true }).click();
      await page.locator('textarea').fill(FIRST_SEED);
      await page.locator('input[name=password]').fill(PASSWORD);
      await page.getByRole('button', { name: 'IMPORT', exact: true }).click();
      await page.locator('.acctbar').waitFor();
      await importWallet('IMPORT A SEED PHRASE', SECOND_SEED, 'second seed');
      await importWallet('IMPORT A SEED PHRASE', THIRD_SEED, 'third seed');
      await importWallet('IMPORT A PRIVATE KEY', PRIVATE_KEY, 'loose key');
      await openDrawer();
      const firstWallet = groups().first().locator('.walletrow').first();
      await firstWallet.locator('.more').click();
      await firstWallet.getByRole('button', { name: 'labels', exact: true }).click();
      await firstWallet.locator('.walletedit input').fill('keeper');
      await firstWallet.getByRole('button', { name: 'save', exact: true }).click();
      const firstSeedLabel = ((await groups().first().locator('.gname').textContent()) || '').trim();
      const firstSeedActions = await openSeedMenu(firstSeedLabel);
      for (let i = 0; i < 3; i++) {
        const before = await drawer.locator('.walletrow').count();
        await firstSeedActions.getByRole('button', { name: '+ new wallet', exact: true }).click();
        await page.waitForFunction(
          (count) => document.querySelectorAll('.drawerbox .walletrow').length === count + 1,
          before,
        );
      }
      await closeDrawer();
    };
    const clickToggle = async (label, expanded) => {
      const toggle = group(label).locator('.group-toggle');
      assert.equal(await toggle.getAttribute('aria-expanded'), expanded ? 'true' : 'false');
      await toggle.click();
      await page.waitForFunction(
        ({ name, value }) => [...document.querySelectorAll('.walletgroup')]
          .find((node) => node.querySelector('.gname')?.textContent === name)
          ?.querySelector('.group-toggle')?.getAttribute('aria-expanded') === value,
        { name: label, value: expanded ? 'false' : 'true' },
      );
    };
    const ensureCollapsed = async (label, collapsed) => {
      const toggle = group(label).locator('.group-toggle');
      const expanded = await toggle.getAttribute('aria-expanded');
      if (collapsed && expanded === 'true') await toggle.click();
      if (!collapsed && expanded === 'false') await toggle.click();
      await page.waitForFunction(
        ({ name, value }) => [...document.querySelectorAll('.walletgroup')]
          .find((node) => node.querySelector('.gname')?.textContent === name)
          ?.querySelector('.group-toggle')?.getAttribute('aria-expanded') === value,
        { name: label, value: collapsed ? 'false' : 'true' },
      );
    };
    const openSeedMenu = async (label) => {
      const handle = group(label).getByRole('button', { name: `reorder ${label}`, exact: true });
      await handle.click();
      return group(label).locator('.acts');
    };
    const openSeedMoreMenu = async (label) => {
      await group(label).locator('.ghead .more').click();
      return group(label).locator('.acts');
    };
    const nativeDragSeedBefore = async (sourceLabel, targetLabel) => {
      await page.evaluate(() => {
        window.__walletDragEvents = [];
        for (const type of ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend']) {
          document.addEventListener(type, (event) => window.__walletDragEvents.push({
            type,
            group: event.target?.closest?.('.walletgroup')?.dataset?.groupId,
            defaultPrevented: event.defaultPrevented,
          }), true);
        }
      });
      const positions = await page.evaluate(({ source, target }) => {
        const seedGroup = (label) => [...document.querySelectorAll('.walletgroup')]
          .find((node) => node.querySelector('.gname')?.textContent === label);
        const sourceGroup = seedGroup(source);
        const targetGroup = seedGroup(target);
        if (!sourceGroup || !targetGroup) throw new Error(`missing drag group: ${source} -> ${target}`);
        const handle = sourceGroup.querySelector('.group-drag');
        const heading = targetGroup.querySelector('.ghead');
        if (!handle || !heading) throw new Error(`missing drag handle or heading: ${source} -> ${target}`);
        handle.scrollIntoView({ block: 'center' });
        heading.scrollIntoView({ block: 'center' });
        const handleBox = handle.getBoundingClientRect();
        const headingBox = heading.getBoundingClientRect();
        return {
          start: {
            x: Math.round(handleBox.left + handleBox.width / 2),
            y: Math.round(handleBox.top + handleBox.height / 2),
          },
          target: {
            x: Math.round(headingBox.left + headingBox.width / 2),
            y: Math.round(headingBox.top + headingBox.height * 0.25),
          },
        };
      }, { source: sourceLabel, target: targetLabel });
      await page.mouse.move(positions.start.x, positions.start.y);
      await page.mouse.down();
      await page.mouse.move(positions.start.x, positions.start.y - 12, { steps: 4 });
      await page.mouse.move(positions.target.x, positions.target.y, { steps: 24 });
      await page.mouse.move(positions.target.x + 2, positions.target.y + 2, { steps: 4 });
      await page.waitForTimeout(200);
      await page.mouse.up();
      await page.waitForFunction(
        (label) => document.querySelector('.walletgroup .gname')?.textContent === label,
        sourceLabel,
      );
      return page.evaluate(() => window.__walletDragEvents.slice());
    };
    const dragGeometry = async (sourceLabel, targetLabel) => page.evaluate(({ source, target }) => {
      const seedGroup = (label) => [...document.querySelectorAll('.walletgroup')]
        .find((node) => node.querySelector('.gname')?.textContent === label);
      const scroller = document.querySelector('.drawerbody');
      const sourceBox = seedGroup(source)?.querySelector('.group-drag')?.getBoundingClientRect();
      const targetBox = seedGroup(target)?.querySelector('.ghead')?.getBoundingClientRect();
      const bodyBox = scroller?.getBoundingClientRect();
      const inside = (box) => !!box && !!bodyBox && box.top >= bodyBox.top && box.bottom <= bodyBox.bottom;
      return {
        bodyHeight: bodyBox?.height ?? 0,
        sourceVisible: inside(sourceBox),
        targetVisible: inside(targetBox),
        source: sourceBox && { top: sourceBox.top, bottom: sourceBox.bottom },
        target: targetBox && { top: targetBox.top, bottom: targetBox.bottom },
        body: bodyBox && { top: bodyBox.top, bottom: bodyBox.bottom },
      };
    }, { source: sourceLabel, target: targetLabel });
    const step = async (name, fn) => {
      await fn();
      console.log(`PASS: ${name}`);
    };

    let mainSeed;
    await makeFixture();
    await openDrawer();
    [mainSeed] = await seedNames();
    await closeDrawer();

    await step('collapse hides only the seed group rows and persists in walletList', async () => {
      await openDrawer();
      const first = group(mainSeed);
      await ensureCollapsed(mainSeed, false);
      assert.ok(await first.locator('.walletrow').count() > 0, 'fixture seed should start expanded');
      await clickToggle(mainSeed, true);
      await page.waitForFunction(() => document.querySelector('.walletgroup .group-toggle')?.getAttribute('aria-expanded') === 'false');
      assert.equal(await first.locator('.walletrow').count(), 0, 'collapsed seed rows should be hidden');
      assert.deepEqual(JSON.parse((await idbDump(page)).walletList).collapsed.length, 1);
      await clickToggle(mainSeed, false);
      assert.ok(await first.locator('.walletrow').count() > 0, 'expanded seed rows should return');
      assert.deepEqual(JSON.parse((await idbDump(page)).walletList).collapsed, []);
      await snapshot('01-collapse-expand');
      await closeDrawer();
    });

    let selectedBeforeCollapse;
    await step('collapsed selected seed stays visible as a marked header on reopen', async () => {
      await openDrawer();
      await group('second seed').locator('.walletrow .pick').first().click();
      await drawer.waitFor({ state: 'detached' });
      selectedBeforeCollapse = await selectedIdentity();
      await openDrawer();
      await clickToggle('second seed', true);
      await closeDrawer();
      await openDrawer();
      const selectedGroup = group('second seed');
      assert.equal(await selectedGroup.locator('.walletrow').count(), 0);
      assert.equal(await selectedGroup.locator('.ghead').evaluate((node) => node.classList.contains('group-selected')), true);
      assert.equal(await selectedGroup.locator('.ghead').evaluate((node) => {
        const box = node.getBoundingClientRect();
        const body = node.closest('.drawerbody').getBoundingClientRect();
        return box.top >= body.top && box.bottom <= body.bottom;
      }), true, 'selected collapsed header should be visible');
      assert.deepEqual(await selectedIdentity(), selectedBeforeCollapse, 'collapsing a selected seed must not switch accounts');
      await closeDrawer();
    });

    await step('label filtering temporarily expands matches and restores saved collapse when cleared', async () => {
      await openDrawer();
      await clickToggle(mainSeed, true);
      assert.equal(await group(mainSeed).locator('.walletrow').count(), 0);
      await drawer.locator('.filterrow .chip', { hasText: 'keeper' }).click();
      assert.equal(await group(mainSeed).locator('.walletrow').count(), 1, 'matching collapsed group should be visible while filtered');
      assert.equal(await group(mainSeed).locator('.group-toggle').isDisabled(), true, 'collapse toggle should be disabled while filtered');
      assert.equal(await group(mainSeed).locator('.group-drag').isDisabled(), true, 'drag handle should be disabled while label-filtered');
      assert.equal(await group(mainSeed).locator('.group-drag').getAttribute('draggable'), 'false');
      await drawer.locator('.filterrow .chip', { hasText: 'all' }).click();
      assert.equal(await group(mainSeed).locator('.walletrow').count(), 0, 'saved collapse should return after clearing the filter');
      await closeDrawer();
    });

    await step('search filtering disables seed reordering and restores collapse when cleared', async () => {
      await openDrawer();
      await ensureCollapsed(mainSeed, true);
      const actions = await openSeedMenu(mainSeed);
      await drawer.locator('input.search').fill('keeper');
      assert.equal(await group(mainSeed).locator('.walletrow').count(), 1, 'search should reveal the matching wallet inside a collapsed seed');
      assert.equal(await group(mainSeed).locator('.group-toggle').isDisabled(), true, 'collapse toggle should be disabled while searching');
      assert.equal(await group(mainSeed).locator('.group-drag').isDisabled(), true, 'drag handle should be disabled while searching');
      assert.equal(await group(mainSeed).locator('.group-drag').getAttribute('draggable'), 'false');
      assert.equal(await actions.getByRole('button', { name: 'move seed down', exact: true }).isDisabled(), true);
      await drawer.locator('input.search').fill('');
      assert.equal(await group(mainSeed).locator('.walletrow').count(), 0, 'saved collapse should return after clearing search');
      assert.deepEqual(await seedNames(), [mainSeed, 'second seed', 'third seed'], 'clearing search should keep the full seed order');
      await closeDrawer();
    });

    await step('dragging a seed header reorders only seed groups and keeps imported keys last', async () => {
      await page.setViewportSize({ width: 372, height: 760 });
      await openDrawer();
      await ensureCollapsed(mainSeed, true);
      await ensureCollapsed('second seed', true);
      await ensureCollapsed('third seed', true);
      await drawer.locator('.drawerbody').evaluate((node) => {
        node.scrollTop = 0;
        return new Promise((resolve) => requestAnimationFrame(resolve));
      });
      const geometry = await dragGeometry('third seed', mainSeed);
      assert.equal(geometry.sourceVisible && geometry.targetVisible, true, `native drag endpoints should be visible: ${JSON.stringify(geometry)}`);
      const before = await groupIds();
      assert.equal(before.at(-1), 'imported', 'imported keys fixture should start last');
      const events = await nativeDragSeedBefore('third seed', mainSeed);
      for (const type of ['dragstart', 'dragover', 'drop', 'dragend']) {
        assert.ok(events.some((event) => event.type === type), `native drag should emit ${type}: ${JSON.stringify(events)}`);
      }
      assert.deepEqual(await seedNames(), ['third seed', mainSeed, 'second seed']);
      assert.equal((await groupIds()).at(-1), 'imported', 'imported keys must remain last after seed drag');
      const saved = JSON.parse((await idbDump(page)).walletList);
      assert.deepEqual(saved.order.length, 3, 'walletList order should persist seed ids only');
      assert.equal(saved.order.includes('imported'), false, 'walletList order must not persist the imported group');
      await drawer.locator('.drawerbody').evaluate((node) => {
        node.scrollTop = 0;
        return new Promise((resolve) => requestAnimationFrame(resolve));
      });
      await snapshot('02-drag-reorder');
      await closeDrawer();
      await page.setViewportSize({ width: 372, height: 600 });
    });

    await step('seed menu moves one seed at a time and disables moves at the ends', async () => {
      await openDrawer();
      let actions = await openSeedMenu('third seed');
      assert.equal(await actions.getByRole('button', { name: 'move seed up', exact: true }).isDisabled(), true);
      assert.equal(await actions.getByRole('button', { name: 'move seed down', exact: true }).isDisabled(), false);
      await actions.getByRole('button', { name: 'move seed down', exact: true }).click();
      await waitSeedOrder([mainSeed, 'third seed', 'second seed']);
      assert.deepEqual(await seedNames(), [mainSeed, 'third seed', 'second seed']);
      actions = await openSeedMenu('second seed');
      assert.equal(await actions.getByRole('button', { name: 'move seed down', exact: true }).isDisabled(), true);
      await closeDrawer();
    });

    await step('saved seed order and collapsed state survive reload and unlock without changing the selected account', async () => {
      await openDrawer();
      await ensureCollapsed(mainSeed, true);
      const before = await selectedIdentity();
      await page.reload();
      await unlockIfNeeded();
      await openDrawer();
      assert.deepEqual(await seedNames(), [mainSeed, 'third seed', 'second seed']);
      assert.equal(await group(mainSeed).locator('.walletrow').count(), 0, 'collapse should survive reload');
      assert.deepEqual(await selectedIdentity(), before, 'reload should not switch the selected account');
      await drawer.locator('.lockbtn').click();
      await page.locator('input[placeholder="password"]').fill(PASSWORD);
      await page.getByRole('button', { name: 'UNLOCK', exact: true }).click();
      await page.locator('.acctbar').waitFor();
      await openDrawer();
      assert.deepEqual(await seedNames(), [mainSeed, 'third seed', 'second seed']);
      assert.equal(await group(mainSeed).locator('.walletrow').count(), 0, 'collapse should survive lock and unlock');
      assert.deepEqual(await selectedIdentity(), before, 'unlock should not switch the selected account');
      await closeDrawer();
    });

    await step('filtering disables seed reordering and preserves hidden seed groups in the complete saved order', async () => {
      await openDrawer();
      await drawer.locator('.filterrow .chip', { hasText: 'keeper' }).click();
      assert.deepEqual(await seedNames(), [mainSeed], 'fixture filter should hide the other seed groups');
      const actions = await openSeedMoreMenu(mainSeed);
      assert.equal(await actions.getByRole('button', { name: 'move seed down', exact: true }).isDisabled(), true);
      await drawer.locator('.filterrow .chip', { hasText: 'all' }).click();
      assert.deepEqual(await seedNames(), [mainSeed, 'third seed', 'second seed'], 'hidden groups should return in the saved order');
      await closeDrawer();
    });

    await step('a seed imported after a saved reorder appears after existing seeds and before imported keys', async () => {
      await importWallet('IMPORT A SEED PHRASE', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 'new seed');
      await openDrawer();
      assert.deepEqual(await seedNames(), [mainSeed, 'third seed', 'second seed', 'new seed']);
      assert.equal((await groupIds()).at(-1), 'imported');
      await closeDrawer();
    });

    await step('a forgotten seed is pruned from the saved order without moving imported keys', async () => {
      await openDrawer();
      const removedId = await group('second seed').getAttribute('data-group-id');
      const actions = await openSeedMenu('second seed');
      await actions.getByRole('button', { name: 'forget', exact: true }).click();
      await group('second seed').getByRole('button', { name: 'FORGET IT', exact: true }).click();
      await page.waitForFunction(() => ![...document.querySelectorAll('.walletgroup .gname')]
        .some((node) => node.textContent === 'second seed'));
      assert.deepEqual(await seedNames(), [mainSeed, 'third seed', 'new seed']);
      assert.equal((await groupIds()).at(-1), 'imported');
      const saved = JSON.parse((await idbDump(page)).walletList);
      const liveSeedIds = (await groupIds()).filter((id) => id !== 'imported');
      assert.equal(saved.order.includes(removedId), false, 'forgotten seed id should be removed from walletList order');
      assert.equal(saved.order.every((id) => liveSeedIds.includes(id)), true, 'walletList order should only contain live seed ids');
      await closeDrawer();
    });

    assert.deepEqual(errors, []);
    console.log('PASS: wallet list collapse, reorder, filtering, persistence, and imported-group ordering.');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
