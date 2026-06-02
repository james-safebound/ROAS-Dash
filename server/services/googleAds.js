/**
 * Google Ads API integration
 * Pulls monthly spend + conversion data for search campaigns and upserts into Supabase.
 *
 * Required env vars:
 *   GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET,
 *   GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_REFRESH_TOKEN,
 *   GOOGLE_ADS_CUSTOMER_ID
 */
const { GoogleAdsApi } = require('google-ads-api');
const supabase = require('../db/supabase');

function getClient() {
  return new GoogleAdsApi({
    client_id:        process.env.GOOGLE_ADS_CLIENT_ID,
    client_secret:    process.env.GOOGLE_ADS_CLIENT_SECRET,
    developer_token:  process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  });
}

// Returns YYYY-MM strings for the trailing N months (including current)
function trailingMonths(n = 12) {
  const months = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    months.push(`${y}-${m}`);
    d.setMonth(d.getMonth() - 1);
  }
  return months;
}

async function sync() {
  const client = getClient();
  const customer = client.Customer({
    customer_id:   process.env.GOOGLE_ADS_CUSTOMER_ID,
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
  });

  // Pull monthly spend + all_conversions_value for last 12 months
  const months = trailingMonths(12);
  const rows = [];

  for (const month of months) {
    const [year, mon] = month.split('-');
    const firstDay = `${year}-${mon}-01`;
    const lastDay  = new Date(parseInt(year), parseInt(mon), 0).toISOString().slice(0, 10);

    const report = await customer.report({
      entity: 'campaign',
      attributes: ['campaign.id'],
      metrics: ['metrics.cost_micros', 'metrics.all_conversions_value'],
      constraints: { 'segments.date': { '>=' : firstDay, '<=': lastDay } },
      date_constant: 'CUSTOM_DATE',
    });

    let spend = 0, revenue = 0;
    for (const row of report) {
      spend   += (row.metrics.cost_micros || 0) / 1_000_000;
      revenue += row.metrics.all_conversions_value || 0;
    }
    rows.push({ channel_id: 'google_ads', month, spend, revenue, leads: 0, booked: 0, source: 'google_ads' });
  }

  // Upsert all rows
  const { error } = await supabase
    .from('channel_metrics')
    .upsert(rows, { onConflict: 'channel_id,month' });

  if (error) throw new Error(error.message);
  return { rowsAffected: rows.length, message: `Synced ${rows.length} months from Google Ads` };
}

module.exports = { sync };
