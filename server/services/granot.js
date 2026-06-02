/**
 * Granot (HelloMoving) scraper
 * Logs in via two-step auth (network → user), navigates to
 * Reports → Leads & Advertising → All Leads and Advertising,
 * scrapes the table for a given month, and upserts into Supabase.
 */
const puppeteer = require('puppeteer');
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

const WC_URL = 'https://ant.hellomoving.com/wc.dll?mp~hellonet~SAFEBOUND';

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

  // Log actual field values and screenshot right before clicking Login
  const fieldValues = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')];
    return inputs.map(i => ({ type: i.type, name: i.name, id: i.id, placeholder: i.placeholder, value: i.value }));
  });
  console.log('[granot] Fields before login click:', JSON.stringify(fieldValues, null, 2));
  await page.screenshot({ path: '/tmp/granot_before_login_click.png', fullPage: true });

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
    page.click('button[type="submit"], input[type="submit"], button::-p-text(Login)'),
  ]);
}

async function userLogin(page) {
  const userInput = await page.$('input[name*="user" i], input[id*="user" i], input[placeholder*="user" i]');
  if (!userInput) return;

  await fillInput(page, 'input[name*="user" i], input[id*="user" i], input[placeholder*="user" i]', process.env.GRANOT_USERNAME);
  await fillInput(page, 'input[type="password"]', process.env.GRANOT_PASSWORD);

  await page.$eval('input[type="submit"], button[type="submit"]', el => el.click());
  await new Promise(r => setTimeout(r, 2000));
}

async function scrapeMonth(page, year, month) {
  // Extract session GUID from the post-login URL
  const guid = page.url().match(/~([A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12})/i)?.[1];
  if (!guid) throw new Error('Could not extract session GUID from URL: ' + page.url());
  console.log('[granot] Session GUID:', guid);

  const base = 'https://ant.hellomoving.com';

  // Navigate directly to Reports menu
  await page.goto(`${base}/wc.dll?mprep~repmenuwc~${guid}`, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.screenshot({ path: '/tmp/granot_reports_page.png', fullPage: true });
  console.log('[granot] Reports page screenshot saved');

  // Log all elements with text + onclick to find Leads & Advertising
  const allClickable = await page.evaluate(() =>
    [...document.querySelectorAll('[onclick], a')].map(el => ({
      tag: el.tagName,
      text: el.textContent.trim().slice(0, 60),
      href: el.href || '',
      onclick: el.getAttribute('onclick') || '',
    }))
  );
  console.log('[granot] Clickable elements on reports page:', JSON.stringify(allClickable));

  // submitFunction(10) = Leads & Advertising — extract the URL from the JS source
  const leadsUrl = await page.evaluate(() => {
    const scripts = [...document.querySelectorAll('script')].map(s => s.textContent).join('\n');
    // Match: if (i==10) window.open('/wc.dll?...')
    const match = scripts.match(/if\s*\(i\s*==\s*10\)\s*window\.open\(['"]([^'"]+)['"]/);
    return match ? match[1] : null;
  });
  if (!leadsUrl) throw new Error('Could not find submitFunction(10) URL in page scripts');
  const fullLeadsUrl = leadsUrl.startsWith('http') ? leadsUrl : `https://ant.hellomoving.com${leadsUrl}`;
  console.log('[granot] Leads & Advertising URL:', fullLeadsUrl);

  await page.goto(fullLeadsUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.screenshot({ path: '/tmp/granot_leads_page.png', fullPage: true });
  console.log('[granot] Leads page screenshot saved');

  // Set date range
  const fromDate = firstOfMonth(year, month);
  const toDate   = lastOfMonth(year, month);

  const fromInput = await page.waitForSelector('input[name*="from" i], input[id*="from" i]', { timeout: 10000 });
  await fromInput.click({ clickCount: 3 });
  await fromInput.type(fromDate);

  const toInput = await page.$('input[name*="to" i], input[id*="to" i]');
  await toInput.click({ clickCount: 3 });
  await toInput.type(toDate);

  // Click "All Leads and Advertising"
  const allLeadsUrl = await page.evaluate(() => {
    const link = [...document.querySelectorAll('a')].find(a => a.textContent.trim().includes('All Le'));
    return link ? link.href : null;
  });
  if (!allLeadsUrl) throw new Error('All Leads link not found');

  await page.goto(allLeadsUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.screenshot({ path: '/tmp/granot_all_leads.png', fullPage: true });
  console.log('[granot] All leads screenshot saved');

  // Scrape the table
  const rows = await page.evaluate(() => {
    const results = [];
    const table = document.querySelector('table');
    if (!table) return results;

    const headers = [...table.querySelectorAll('thead th, tr:first-child th')]
      .map(th => th.textContent.trim().toLowerCase());

    // Find column indices
    const col = name => headers.findIndex(h => h.includes(name));
    const adverIdx    = col('adver');
    const entryIdx    = col('entry');
    const bookedIdx   = col('booked');
    const jobTotalIdx = col('job_total');

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

  return rows;
}

async function sync(monthsBack = 3) {
  console.log('[granot] NETWORK_ID:', process.env.GRANOT_NETWORK_ID);
  console.log('[granot] USERNAME:', process.env.GRANOT_USERNAME);

  const browser = await puppeteer.launch({
    headless: false,
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
    await page.screenshot({ path: '/tmp/granot_step1.png', fullPage: true });
    console.log('[granot] Step 1 screenshot: /tmp/granot_step1.png');

    // Step 1: Network login
    await networkLogin(page);
    await page.screenshot({ path: '/tmp/granot_step2.png', fullPage: true });
    console.log('[granot] Step 2 screenshot: /tmp/granot_step2.png');

    // Step 2: User login
    await userLogin(page);
    await page.screenshot({ path: '/tmp/granot_step3.png', fullPage: true });
    console.log('[granot] Step 3 screenshot: /tmp/granot_step3.png');

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


      // Aggregate by channel (multiple Granot rows → same channel)
      const byChannel = {};
      for (const row of rows) {
        const channelId = SOURCE_MAP[row.adver];
        if (!channelId) continue;
        if (!byChannel[channelId]) byChannel[channelId] = { leads: 0, booked: 0, revenue: 0 };
        byChannel[channelId].leads   += row.entry;
        byChannel[channelId].booked  += row.booked;
        byChannel[channelId].revenue += row.jobTotal;
      }

      for (const [channelId, data] of Object.entries(byChannel)) {
        allRows.push({
          channel_id: channelId,
          month: monthKey,
          revenue: data.revenue,
          leads:   data.leads,
          booked:  data.booked,
          source:  'granot',
          updated_at: new Date().toISOString(),
        });
      }
    }

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
  } finally {
    await browser.close();
  }
}

module.exports = { sync };
