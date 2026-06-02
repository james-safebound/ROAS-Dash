/**
 * Granot (HelloMoving) scraper
 * Logs in via two-step auth (network → user), navigates to
 * Reports → Leads & Advertising → All Leads and Advertising,
 * scrapes the table for a given month, and upserts into Supabase.
 */
const puppeteer = require('puppeteer');
const fs = require('fs/promises');
const path = require('path');
const supabase = require('../db/supabase');

// Maps Granot advertiser names → our channel IDs.
// Multiple Granot rows can map to the same channel (they get aggregated).
const SOURCE_MAP = {
  'Google Ads':               'google_ads',

  'Google Guarantee':         'lsa_1',
  'USA Guarantee':            'lsa_2',
  'West Guarantee':           'lsa_3',
  'Forbes':                   'forbes',
  'Forbes Advisor':           'forbes',
  'Forbes Advisor Exclusive': 'forbes',
  'Forbes Local Exclusive':   'forbes',
  'ForbesAdvisor':            'forbes',
  'MoveBuddha':               'movebuddha',
  'Safeship Form Fills':      'safeship',
  'Facebook Paid':            'facebook_paid',
};

function firstOfMonth(year, month) {
  return `${String(month).padStart(2,'0')}/01/${year}`;
}

function lastOfMonth(year, month) {
  const last = new Date(year, month, 0).getDate();
  return `${String(month).padStart(2,'0')}/${last}/${year}`;
}

const BASE_URL = 'https://ant.hellomoving.com';
const WC_URL = process.env.GRANOT_WC_URL || 'https://ant.hellomoving.com/wc.dll?mp~hellonet~SAFEBOUND';
const DEBUG_DIR = process.env.GRANOT_DEBUG_DIR || '/tmp/granot-debug';
const DEBUG_ENABLED = process.env.GRANOT_DEBUG !== 'false';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeText(text = '') {
  return text.replace(/\s+/g, ' ').trim();
}

async function saveDebug(page, name) {
  if (!DEBUG_ENABLED) return;
  await fs.mkdir(DEBUG_DIR, { recursive: true });
  await page.screenshot({ path: path.join(DEBUG_DIR, `${name}.png`), fullPage: true });
  await fs.writeFile(path.join(DEBUG_DIR, `${name}.html`), await page.content());
  await fs.writeFile(path.join(DEBUG_DIR, `${name}.url.txt`), page.url());
}

async function waitForQuietNavigation(page, action, timeout = 30000) {
  const navigation = page.waitForNavigation({ waitUntil: 'networkidle2', timeout })
    .catch(err => {
      if (err.name !== 'TimeoutError') throw err;
      return null;
    });

  await action();
  await Promise.race([navigation, sleep(2500)]);
}

function sessionGuidFromUrl(url) {
  return url.match(/~([A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12})/i)?.[1] || null;
}

async function fillInput(page, selector, value) {
  await page.waitForSelector(selector, { timeout: 10000 });
  // Use native value setter to bypass React/autofill overrides
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, val);
    else el.value = val;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector, value);
}

async function networkLogin(page) {
  const networkInput = await page.$('input[placeholder="Enter Network ID"], input[name*="network" i], input[id*="network" i]');
  if (!networkInput) { console.log('[granot] No network login form found, skipping'); return; }

  await fillInput(page, 'input[placeholder="Enter Network ID"], input[name*="network" i], input[id*="network" i]', process.env.GRANOT_NETWORK_ID);
  await fillInput(page, 'input[type="password"]', process.env.GRANOT_NETWORK_PASSWORD);

  await saveDebug(page, '01-network-login-filled');

  await waitForQuietNavigation(page, () =>
    page.click('button[type="submit"], input[type="submit"], button::-p-text(Login)')
  );
}

async function userLogin(page) {
  const userInput = await page.$('input[name*="user" i], input[id*="user" i], input[placeholder*="user" i]');
  if (!userInput) return;

  await fillInput(page, 'input[name*="user" i], input[id*="user" i], input[placeholder*="user" i]', process.env.GRANOT_USERNAME);
  await fillInput(page, 'input[type="password"]', process.env.GRANOT_PASSWORD);

  await saveDebug(page, '02-user-login-filled');
  await waitForQuietNavigation(page, () =>
    page.$eval('input[type="submit"], button[type="submit"]', el => el.click())
  );
}

async function findClickableByText(page, text) {
  return page.evaluateHandle((targetText) => {
    const wanted = targetText.toLowerCase();
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const candidates = [...document.querySelectorAll('a, button, input[type="button"], input[type="submit"], [onclick], td, div, span, li')]
      .filter(visible)
      .map(el => {
        const label = (el.innerText || el.value || el.textContent || '').replace(/\s+/g, ' ').trim();
        const clickable = el.closest('a, button, input[type="button"], input[type="submit"], [onclick]') || el;
        return { el: clickable, label };
      })
      .filter(item => item.label.toLowerCase().includes(wanted));

    return candidates[0]?.el || null;
  }, text);
}

async function clickByText(page, text, debugName) {
  const handle = await findClickableByText(page, text);
  const element = handle.asElement();
  if (!element) {
    await saveDebug(page, `missing-${debugName}`);
    throw new Error(`Could not find clickable text: ${text}`);
  }

  await waitForQuietNavigation(page, () => element.click());
  await saveDebug(page, debugName);
}

async function gotoReportsMenu(page) {
  const guid = sessionGuidFromUrl(page.url());
  if (guid) {
    await page.goto(`${BASE_URL}/wc.dll?mprep~repmenuwc~${guid}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await saveDebug(page, '04-reports-menu-direct');
    return;
  }

  await clickByText(page, 'Reports', '04-reports-menu-clicked');
}

async function gotoLeadsAdvertising(page) {
  await clickByText(page, 'Leads & Advertising', '05-leads-advertising');
}

async function setInputValue(page, selector, value) {
  const handle = await page.$(selector);
  if (!handle) return false;
  await handle.click({ clickCount: 3 });
  await handle.type(value);
  return true;
}

async function setDateRange(page, fromDate, toDate) {
  const setFrom = await setInputValue(page, 'input[name*="from" i], input[id*="from" i], input[name*="start" i], input[id*="start" i]', fromDate);
  const setTo = await setInputValue(page, 'input[name*="to" i], input[id*="to" i], input[name*="end" i], input[id*="end" i]', toDate);

  if (!setFrom || !setTo) {
    await saveDebug(page, 'missing-date-inputs');
    throw new Error(`Could not set Granot date range. from=${setFrom}, to=${setTo}`);
  }
}

async function scrapeMonth(page, year, month) {
  await gotoReportsMenu(page);
  await gotoLeadsAdvertising(page);

  const fromDate = firstOfMonth(year, month);
  const toDate   = lastOfMonth(year, month);
  await setDateRange(page, fromDate, toDate);
  await saveDebug(page, '06-date-range-set');

  await clickByText(page, 'All Leads', '07-all-leads-report');

  // Scrape the table
  const rows = await page.evaluate(() => {
    const results = [];
    const tables = [...document.querySelectorAll('table')];
    const table = tables.find(t => /adver|advertis|booked|job/i.test(t.innerText)) || tables[tables.length - 1];
    if (!table) return results;

    const normalize = text => (text || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const headerCells = [...table.querySelectorAll('thead th, tr:first-child th, tr:first-child td')];
    const headers = headerCells.map(th => normalize(th.textContent));

    // Find column indices
    const col = names => headers.findIndex(h => names.some(name => h.includes(name)));
    const adverIdx    = col(['adver', 'advertis', 'source']);
    const entryIdx    = col(['entry', 'lead', 'calls']);
    const bookedIdx   = col(['booked', 'book']);
    const jobTotalIdx = col(['jobtotal', 'total', 'revenue', 'amount']);

    if ([adverIdx, entryIdx, bookedIdx, jobTotalIdx].some(i => i < 0)) {
      return [{ __headerError: true, headers }];
    }

    const bodyRows = [...table.querySelectorAll('tbody tr, tr:not(:first-child)')];
    for (const tr of bodyRows) {
      const cells = [...tr.querySelectorAll('td')];
      if (cells.length < 4) continue;

      const adver    = cells[adverIdx]?.textContent?.trim();
      const entry    = parseInt(cells[entryIdx]?.textContent?.trim()) || 0;
      const booked   = parseInt(cells[bookedIdx]?.textContent?.trim()) || 0;
      const jobTotal = parseFloat(cells[jobTotalIdx]?.textContent?.replace(/[$,]/g, '')) || 0;

      if (adver) results.push({ adver, entry, booked, jobTotal });
    }
    return results;
  });

  if (rows[0]?.__headerError) {
    await saveDebug(page, 'bad-table-headers');
    throw new Error(`Could not identify Granot report columns: ${JSON.stringify(rows[0].headers)}`);
  }

  await saveDebug(page, '08-report-scraped');
  return rows;
}

function aggregateRows(rows, monthKey) {
  const byChannel = {};
  for (const row of rows) {
    const channelId = SOURCE_MAP[row.adver];
    if (!channelId) continue;
    if (!byChannel[channelId]) byChannel[channelId] = { leads: 0, booked: 0, revenue: 0 };
    byChannel[channelId].leads   += row.entry;
    byChannel[channelId].booked  += row.booked;
    byChannel[channelId].revenue += row.jobTotal;
  }

  return Object.entries(byChannel).map(([channelId, data]) => ({
    channel_id: channelId,
    month: monthKey,
    revenue: data.revenue,
    leads:   data.leads,
    booked:  data.booked,
    source:  'granot',
    updated_at: new Date().toISOString(),
  }));
}

async function collectMetrics(monthsBack = 3) {
  const browser = await puppeteer.launch({
    headless: process.env.GRANOT_HEADLESS === 'true' ? 'new' : false,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    userDataDir: '/tmp/granot-chrome-profile',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-extensions', '--disable-features=AutofillEnableAccountWalletStorage', '--password-store=basic'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  try {
    // Step 1: Network login
    // Navigate directly to the app (login form lives here, not in admin.htm)
    console.log('[granot] Navigating to app...');
    await page.goto(WC_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await saveDebug(page, '00-app');

    // Step 1: Network login
    await networkLogin(page);
    await saveDebug(page, '03-after-network-login');

    // Step 2: User login
    await userLogin(page);
    await saveDebug(page, '03-after-user-login');

    // Step 3: Scrape last N months
    const allRows = [];
    const now = new Date();

    for (let i = 0; i < monthsBack; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const year  = d.getFullYear();
      const month = d.getMonth() + 1;
      const monthKey = `${year}-${String(month).padStart(2, '0')}`;

      console.log(`[granot] Scraping ${monthKey}...`);
      const rows = await scrapeMonth(page, year, month);
      allRows.push(...aggregateRows(rows, monthKey));
    }

    return allRows;
  } finally {
    await browser.close();
  }
}

async function probe(monthsBack = 1) {
  console.log('[granot] Starting probe');
  const rows = await collectMetrics(monthsBack);
  return {
    rowsAffected: rows.length,
    rows,
    message: `Probed ${rows.length} channel-month rows from Granot (${monthsBack} months)`,
  };
}

async function sync(monthsBack = 3) {
  console.log('[granot] Starting sync');
  const allRows = await collectMetrics(monthsBack);

  try {
    // Upsert all rows (preserves spend from other sources)
    if (allRows.length > 0) {
      const { error } = await supabase
        .from('channel_metrics')
        .upsert(allRows, { onConflict: 'channel_id,month' });
      if (error) throw new Error(error.message);
    }

    return {
      rowsAffected: allRows.length,
      message: `Synced ${allRows.length} channel-month rows from Granot (${monthsBack} months)`,
    };
  } catch (err) {
    throw err;
  }
}

module.exports = { sync, probe, collectMetrics };
