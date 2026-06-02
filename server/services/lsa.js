/**
 * Google Local Services Ads (LSA) scraper
 * Uses Puppeteer to log into the LSA dashboard and extract monthly spend + leads per account.
 *
 * Required env vars:
 *   GOOGLE_ACCOUNT_EMAIL, GOOGLE_ACCOUNT_PASSWORD
 *
 * LSA has three accounts (lsa_1, lsa_2, lsa_3). Set their dashboard URLs in LSA_ACCOUNTS below.
 */
const puppeteer = require('puppeteer');
const supabase = require('../db/supabase');

const LSA_ACCOUNTS = [
  { channelId: 'lsa_1', name: 'LSA Account 1' },
  { channelId: 'lsa_2', name: 'LSA Account 2' },
  { channelId: 'lsa_3', name: 'LSA Account 3' },
];

const LSA_URL = 'https://ads.google.com/localservices/dashboard';

async function loginGoogle(page) {
  await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle2' });
  await page.type('input[type="email"]', process.env.GOOGLE_ACCOUNT_EMAIL);
  await page.click('#identifierNext');
  await page.waitForSelector('input[type="password"]', { visible: true });
  await page.type('input[type="password"]', process.env.GOOGLE_ACCOUNT_PASSWORD);
  await page.click('#passwordNext');
  await page.waitForNavigation({ waitUntil: 'networkidle2' });
}

async function scrapeAccount(page, account, month) {
  // Navigate to LSA dashboard and switch to the correct account if needed
  await page.goto(`${LSA_URL}`, { waitUntil: 'networkidle2' });

  // TODO: Select the correct account from the account picker.
  // The selector will depend on LSA dashboard structure — inspect the DOM and update this.
  // Example:
  //   await page.click('[data-account-id="..."]');

  // TODO: Navigate to the monthly report view and extract:
  //   spend  (total charges this month)
  //   leads  (total leads/calls this month)
  // Example extraction:
  //   const spend = await page.$eval('.total-spend', el => parseFloat(el.textContent.replace(/[^0-9.]/g,'')));
  //   const leads = await page.$eval('.total-leads', el => parseInt(el.textContent));

  // Placeholder values — replace with real extraction
  const spend = 0;
  const leads = 0;

  return { channelId: account.channelId, month, spend, leads };
}

async function sync() {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();

  try {
    await loginGoogle(page);

    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const rows = [];
    for (const account of LSA_ACCOUNTS) {
      const result = await scrapeAccount(page, account, month);

      // LSA doesn't report revenue directly — revenue flows through Granot bookings.
      // We store spend + leads here; Granot sync fills in revenue + booked.
      rows.push({
        channel_id: result.channelId,
        month: result.month,
        spend: result.spend,
        leads: result.leads,
        source: 'lsa',
        updated_at: new Date().toISOString(),
      });
    }

    // Upsert — only update spend + leads, preserve revenue + booked from Granot
    for (const row of rows) {
      const { error } = await supabase.rpc('upsert_lsa_metrics', row);
      if (error) {
        // Fallback: plain upsert (will overwrite revenue/booked)
        await supabase.from('channel_metrics').upsert(row, { onConflict: 'channel_id,month' });
      }
    }

    return { rowsAffected: rows.length, message: `Scraped ${rows.length} LSA accounts for ${month}` };
  } finally {
    await browser.close();
  }
}

module.exports = { sync };
