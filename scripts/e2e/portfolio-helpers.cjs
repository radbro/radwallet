function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function moneyTextKind(text) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return {
    text: t,
    usd: /\$[0-9]/.test(t),
    eth: /\b[0-9][0-9,.]*\.?[0-9]*\s*ETH\b/i.test(t),
  };
}

function hasContradictoryDenomination(text, expected) {
  const kind = moneyTextKind(text);
  return expected === 'USD' ? kind.eth : kind.usd;
}

function hasExpectedPositiveDenomination(text, expected) {
  const kind = moneyTextKind(text);
  return expected === 'USD' ? kind.usd : kind.eth;
}

function normalizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

async function savePortfolioScreenshot(pg, path, label, options = {}) {
  await pg.locator('.portfolio-page').waitFor({ timeout: 10000 });
  await pg.waitForTimeout(150);
  await pg.screenshot({ path, fullPage: options.fullPage ?? true });
  console.log(`PORTFOLIO SCREENSHOT ${label}:`, path);
}

async function assertWalletHeaderVisible(pg, label) {
  await pg.evaluate(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  });
  const geometry = await pg.locator('.titlebar').evaluate((bar) => {
    const box = bar.getBoundingClientRect();
    const children = [...bar.children].map((child) => {
      const rect = child.getBoundingClientRect();
      return { text: child.textContent || child.tagName, top: rect.top, bottom: rect.bottom, height: rect.height };
    }).filter((child) => child.height > 0);
    const nav = bar.parentElement.querySelector('.portfolio-nav')?.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, height: box.height, children, navTop: nav?.top };
  });
  const clipped = geometry.children.filter((child) => child.top < geometry.top - 1 || child.bottom > geometry.bottom + 1);
  assert(clipped.length === 0 && (geometry.navTop === undefined || geometry.navTop >= geometry.bottom - 1),
    `${label}: wallet header is clipped or covered: ${JSON.stringify(geometry)}`);
  return geometry;
}

async function horizontalLayout(pg) {
  return pg.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
}

function assertNoHorizontalScroll(layout, label) {
  if (layout.html > layout.viewport + 1 || layout.body > layout.viewport + 1) {
    throw new Error(`${label} scrolls horizontally: ${JSON.stringify(layout)}`);
  }
}

async function selectedCurrency(pg) {
  const usd = await pg.locator('.portfolio-currency button', { hasText: 'USD' }).getAttribute('aria-pressed');
  const eth = await pg.locator('.portfolio-currency button', { hasText: 'ETH' }).getAttribute('aria-pressed');
  if (usd === 'true') return 'USD';
  if (eth === 'true') return 'ETH';
  return null;
}

async function assertPortfolioCurrency(pg, expected, label) {
  const selected = await selectedCurrency(pg);
  assert(selected === expected, `${label}: ${expected} currency is not selected (${selected})`);
  const totalText = await pg.locator('.portfolio-total').textContent();
  const values = await pg.locator('.portfolio-row-value').allTextContents();
  assert(values.length > 0, `${label}: portfolio has no visible value rows`);
  assert(hasExpectedPositiveDenomination(totalText, expected),
    `${label}: demo total does not show ${expected}: ${JSON.stringify(moneyTextKind(totalText))}`);
  assert(!hasContradictoryDenomination(totalText, expected),
    `${label}: total shows the opposite denomination: ${JSON.stringify(moneyTextKind(totalText))}`);
  const wrongRows = values.filter((v) => hasContradictoryDenomination(v, expected));
  assert(wrongRows.length === 0, `${label}: rows show the opposite denomination: ${JSON.stringify(wrongRows)}`);
  const pricedRows = values.filter((v) => hasExpectedPositiveDenomination(v, expected));
  assert(pricedRows.length > 0, `${label}: demo rows show no ${expected} values: ${JSON.stringify(values)}`);
}

async function assertPortfolioCurrencySelection(pg, expected, label) {
  const selected = await selectedCurrency(pg);
  assert(selected === expected, `${label}: ${expected} currency is not selected (${selected})`);
  const totalText = await pg.locator('.portfolio-total').textContent();
  const values = await pg.locator('.portfolio-row-value').allTextContents();
  assert(!hasContradictoryDenomination(totalText, expected),
    `${label}: total shows the opposite denomination: ${JSON.stringify(moneyTextKind(totalText))}`);
  const wrongRows = values.filter((v) => hasContradictoryDenomination(v, expected));
  assert(wrongRows.length === 0, `${label}: rows show the opposite denomination: ${JSON.stringify(wrongRows)}`);
}

async function openPortfolio(pg) {
  await pg.getByRole('button', { name: 'Portfolio', exact: true }).click();
  await pg.locator('.portfolio-page').waitFor({ timeout: 20000 });
}

async function assertPortfolioShell(pg, label) {
  await pg.locator('.portfolio-page').waitFor({ timeout: 20000 });
  assert(await pg.locator('.portfolio-total').count() === 1, `${label}: portfolio total missing`);
  for (const name of ['USD', 'ETH']) {
    assert(await pg.locator('.portfolio-currency button', { hasText: name }).count() === 1,
      `${label}: ${name} currency toggle missing`);
  }
  for (const name of ['Assets', 'Wallets', 'Seed groups']) {
    assert(await pg.locator('.portfolio-grouping button', { hasText: name }).count() === 1,
      `${label}: ${name} grouping toggle missing`);
  }
  assert(await pg.getByRole('button', { name: 'FILTERS', exact: true }).count() === 1,
    `${label}: filters button missing`);
}

async function assertPortfolioResponsive(pg, label) {
  const layout = await horizontalLayout(pg);
  if (layout.html > layout.viewport + 1 || layout.body > layout.viewport + 1) {
    const offenders = await pg.locator('body *').evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        cls: typeof el.className === 'string' ? el.className : '',
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        left: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      };
    }).filter((el) => el.right > document.documentElement.clientWidth + 1
      || el.left < -1 || el.scrollWidth > el.clientWidth + 1).slice(0, 20));
    throw new Error(`${label} scrolls horizontally: ${JSON.stringify({ layout, offenders })}`);
  }
  const boxes = await pg.locator('.portfolio-page button, .portfolio-page input').evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return {
      text: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim(),
      width: r.width,
      height: r.height,
    };
  }));
  const tiny = boxes.filter((b) => b.width < 44 || b.height < 44);
  assert(tiny.length === 0, `${label}: portfolio controls smaller than 44px: ${JSON.stringify(tiny)}`);
}

async function assertPortfolioFiltersDialog(pg, label) {
  await pg.getByRole('button', { name: 'FILTERS', exact: true }).click();
  const dialog = pg.getByRole('dialog', { name: 'Portfolio filters' });
  await dialog.waitFor({ timeout: 10000 });
  const a11y = await pg.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Portfolio filters"]');
    const underlay = [...document.querySelectorAll('#app > *')]
      .filter((el) => !el.contains(dialog));
    return {
      modal: dialog?.getAttribute('aria-modal'),
      focusInside: !!dialog?.contains(document.activeElement),
      underlayInert: underlay.length > 0 && underlay.every((el) => el.inert),
    };
  });
  assert(a11y.modal === 'true' && a11y.focusInside && a11y.underlayInert,
    `${label}: filters dialog is not an isolated modal: ${JSON.stringify(a11y)}`);
  for (const tab of ['Wallets', 'Assets', 'Networks']) {
    assert(await dialog.getByRole('button', { name: tab, exact: true }).count() === 1,
      `${label}: ${tab} filter tab missing`);
  }
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 10000 });
}

async function assertPortfolioGroupingAndDetails(pg, label) {
  for (const name of ['Assets', 'Wallets', 'Seed groups']) {
    await pg.locator('.portfolio-grouping button', { hasText: name }).click();
    await pg.waitForTimeout(200);
    assert(await pg.locator('.portfolio-grouping button', { hasText: name }).getAttribute('aria-pressed') === 'true',
      `${label}: ${name} grouping did not stay selected`);
    assert(await pg.locator('.portfolio-row-toggle').count() > 0,
      `${label}: ${name} grouping rendered no portfolio rows`);
  }
  const first = pg.locator('.portfolio-row-toggle').first();
  await first.click();
  await pg.waitForTimeout(200);
  const expanded = await first.getAttribute('aria-expanded');
  const details = await pg.locator('.portfolio-detail-row').evaluateAll((rows) => rows.map((row) => {
    const contribution = row.querySelector(':scope > span')?.textContent || '';
    const left = row.querySelector(':scope > div')?.textContent || '';
    return { left: left.replace(/\s+/g, ' ').trim(), contribution: contribution.replace(/\s+/g, ' ').trim() };
  }));
  assert(expanded === 'true', `${label}: portfolio row did not expose expanded state`);
  assert(details.length > 0, `${label}: expanded row rendered no detail rows`);
  assert(details.some((row) => /\b[0-9][0-9,.]*\.?[0-9]*\s+\$?[A-Z][A-Z0-9]*\b/.test(row.left)),
    `${label}: detail rows do not show quantity-shaped asset amounts: ${JSON.stringify(details)}`);
  assert(details.every((row) => /^(Unpriced|—|[$0-9.,<]+\s*(ETH)?)$/i.test(row.contribution)),
    `${label}: detail rows do not show numeric contribution values: ${JSON.stringify(details)}`);
}

async function resetPortfolioFilters(pg) {
  await pg.getByRole('button', { name: 'FILTERS', exact: true }).click();
  const dialog = pg.getByRole('dialog', { name: 'Portfolio filters' });
  await dialog.getByRole('button', { name: 'Reset filters', exact: true }).click();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 10000 });
  await pg.locator('.portfolio-page').waitFor({ timeout: 10000 });
}

async function portfolioSnapshot(pg) {
  await pg.locator('.portfolio-page').waitFor({ timeout: 10000 });
  return {
    total: normalizeText(await pg.locator('.portfolio-total').textContent()),
    chart: normalizeText(await pg.locator('.portfolio-chart svg').getAttribute('aria-label')),
    scope: normalizeText(await pg.locator('.portfolio-scope').textContent()),
    rows: await pg.locator('.portfolio-row-toggle').evaluateAll((rows) => rows.map((row) => ({
      label: (row.querySelector('.portfolio-row-name b')?.textContent || '').replace(/\s+/g, ' ').trim(),
      value: (row.querySelector('.portfolio-row-value')?.textContent || '').replace(/\s+/g, ' ').trim(),
      share: (row.querySelector('.portfolio-share')?.textContent || '').replace(/\s+/g, ' ').trim(),
    }))),
  };
}

function assertPortfolioListMatchesChart(snapshot, label) {
  for (const row of snapshot.rows.filter((r) => r.value !== 'Unpriced' && r.value !== '—').slice(0, 5)) {
    assert(snapshot.chart.includes(row.label),
      `${label}: chart omits visible priced row ${row.label}: ${JSON.stringify(snapshot)}`);
  }
}

async function assertDemoPortfolioTotalRestores(pg, before, label) {
  await resetPortfolioFilters(pg);
  await pg.waitForTimeout(200);
  const restored = await portfolioSnapshot(pg);
  assert(restored.total === before.total,
    `${label}: reset did not restore demo total: ${JSON.stringify({ before, restored })}`);
  assert(JSON.stringify(restored.rows) === JSON.stringify(before.rows),
    `${label}: reset did not restore demo row values: ${JSON.stringify({ before, restored })}`);
  assertPortfolioListMatchesChart(restored, `${label} after reset`);
  return restored;
}

async function assertPortfolioEmptyFilterAndReset(pg, label) {
  const beforeTotal = (await pg.locator('.portfolio-total').textContent()).trim();
  await pg.getByRole('button', { name: 'FILTERS', exact: true }).click();
  const dialog = pg.getByRole('dialog', { name: 'Portfolio filters' });
  await dialog.getByRole('button', { name: 'Wallets', exact: true }).click();
  await dialog.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 10000 });
  const emptyText = (await pg.locator('.portfolio-page').textContent()).replace(/\s+/g, ' ');
  assert(/no balances|nothing selected|0(\.0+)?\s*(ETH)?|\$0/i.test(emptyText),
    `${label}: clearing all wallet filters did not show an empty state`);
  await resetPortfolioFilters(pg);
  await pg.locator('.portfolio-row-value').first().waitFor({ timeout: 10000 });
  const afterTotal = (await pg.locator('.portfolio-total').textContent()).trim();
  assert(afterTotal === beforeTotal,
    `${label}: reset filters did not restore the demo total: ${JSON.stringify({ beforeTotal, afterTotal })}`);
}

async function withPortfolioFilters(pg, tabName, fn) {
  await pg.getByRole('button', { name: 'FILTERS', exact: true }).click();
  const dialog = pg.getByRole('dialog', { name: 'Portfolio filters' });
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByRole('button', { name: tabName, exact: true }).click();
  await fn(dialog);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 10000 });
  await pg.waitForTimeout(200);
}

async function assertDemoFilterChangesTotal(pg, label, tabName, fn) {
  await resetPortfolioFilters(pg);
  await pg.waitForTimeout(200);
  const before = await portfolioSnapshot(pg);
  await withPortfolioFilters(pg, tabName, fn);
  const after = await portfolioSnapshot(pg);
  assert(after.total !== before.total,
    `${label}: filter did not change the demo total: ${JSON.stringify({ before, after })}`);
  assert(JSON.stringify(after.rows) !== JSON.stringify(before.rows) || after.chart !== before.chart || after.scope !== before.scope,
    `${label}: filter did not change chart/list/scope coherently: ${JSON.stringify({ before, after })}`);
  assertPortfolioListMatchesChart(after, `${label} after filtering`);
  await assertDemoPortfolioTotalRestores(pg, before, label);
}

async function setPortfolioCurrency(pg, currency) {
  await pg.locator('.portfolio-currency button', { hasText: currency }).click();
  await pg.waitForTimeout(250);
  await assertPortfolioCurrency(pg, currency, `after choosing ${currency}`);
}

async function setPortfolioCurrencySelection(pg, currency) {
  await pg.locator('.portfolio-currency button', { hasText: currency }).click();
  await pg.waitForTimeout(250);
  await assertPortfolioCurrencySelection(pg, currency, `after choosing ${currency}`);
}

module.exports = {
  assert,
  assertWalletHeaderVisible,
  assertNoHorizontalScroll,
  assertPortfolioCurrency,
  assertPortfolioCurrencySelection,
  assertPortfolioEmptyFilterAndReset,
  assertPortfolioFiltersDialog,
  assertPortfolioGroupingAndDetails,
  assertPortfolioResponsive,
  assertPortfolioShell,
  assertDemoFilterChangesTotal,
  assertDemoPortfolioTotalRestores,
  assertPortfolioListMatchesChart,
  horizontalLayout,
  openPortfolio,
  portfolioSnapshot,
  resetPortfolioFilters,
  savePortfolioScreenshot,
  selectedCurrency,
  setPortfolioCurrency,
  setPortfolioCurrencySelection,
  withPortfolioFilters,
};
