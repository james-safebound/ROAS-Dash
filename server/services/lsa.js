/**
 * Google Local Services Ads integration.
 *
 * Uses the official Local Services Ads accountReports endpoint for monthly
 * charged leads and total cost, then writes spend + leads into channel_metrics.
 */
const supabase = require('../db/supabase');

const ACCOUNT_REPORTS_URL = 'https://localservices.googleapis.com/v1/accountReports:search';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function normalizeCustomerId(value = '') {
  return String(value).replace(/[^0-9]/g, '');
}

function parseAccounts() {
  const raw = requireEnv('LSA_ACCOUNTS');
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('LSA_ACCOUNTS must be a JSON array');
    return parsed.map((account, index) => {
      const channelId = account.channelId || account.channel_id;
      const customerId = normalizeCustomerId(account.customerId || account.customer_id);
      if (!channelId || !customerId) {
        throw new Error(`LSA_ACCOUNTS[${index}] needs channelId and customerId`);
      }
      return {
        channelId,
        customerId,
        name: account.name || channelId,
      };
    });
  } catch (err) {
    throw new Error(`Invalid LSA_ACCOUNTS JSON: ${err.message}`);
  }
}

function monthRange(month) {
  const [year, mon] = month.split('-').map(Number);
  if (!year || !mon) throw new Error(`Invalid month: ${month}`);
  return {
    start: { year, month: mon, day: 1 },
    end: { year, month: mon, day: new Date(year, mon, 0).getDate() },
  };
}

function trailingMonths(n = 12) {
  const months = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() - 1);
  }
  return months;
}

function parseCost(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'object') {
    if (value.amountMicros !== undefined) return Number(value.amountMicros) / 1_000_000;
    if (value.amount_micros !== undefined) return Number(value.amount_micros) / 1_000_000;
    if (value.units !== undefined || value.nanos !== undefined) {
      return Number(value.units || 0) + Number(value.nanos || 0) / 1_000_000_000;
    }
  }
  const cleaned = String(value).replace(/[^0-9.-]/g, '');
  return cleaned ? Number(cleaned) : 0;
}

async function getAccessToken() {
  const params = new URLSearchParams({
    client_id: requireEnv('GOOGLE_ADS_CLIENT_ID'),
    client_secret: requireEnv('GOOGLE_ADS_CLIENT_SECRET'),
    refresh_token: requireEnv('GOOGLE_ADS_REFRESH_TOKEN'),
    grant_type: 'refresh_token',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Google OAuth token request failed (${res.status}): ${body.error_description || body.error || 'unknown error'}`);
  }
  return body.access_token;
}

async function fetchAccountReports({ accessToken, managerCustomerId, account, month }) {
  const range = monthRange(month);
  const params = new URLSearchParams({
    query: `manager_customer_id:${managerCustomerId};customer_id:${account.customerId}`,
    'startDate.year': String(range.start.year),
    'startDate.month': String(range.start.month),
    'startDate.day': String(range.start.day),
    'endDate.year': String(range.end.year),
    'endDate.month': String(range.end.month),
    'endDate.day': String(range.end.day),
    pageSize: '10000',
  });

  const reports = [];
  let pageToken = '';
  do {
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`${ACCOUNT_REPORTS_URL}?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`LSA accountReports failed for ${account.name} ${month} (${res.status}): ${body.error?.message || body.error || 'unknown error'}`);
    }

    reports.push(...(body.accountReports || body.account_reports || []));
    pageToken = body.nextPageToken || body.next_page_token || '';
  } while (pageToken);

  return reports;
}

function summarizeReport(account, month, reports) {
  const matchingReports = reports.filter(report => normalizeCustomerId(report.accountId || report.account_id) === account.customerId);
  const usableReports = matchingReports.length ? matchingReports : reports;

  let spend = 0;
  let leads = 0;
  for (const report of usableReports) {
    spend += parseCost(report.currentPeriodTotalCost ?? report.current_period_total_cost);
    leads += Number(report.currentPeriodChargedLeads ?? report.current_period_charged_leads ?? 0);
  }

  return {
    channelId: account.channelId,
    customerId: account.customerId,
    name: account.name,
    month,
    spend,
    leads,
    rawReports: reports.length,
  };
}

async function upsertLsaMetric(row) {
  const { data: existing, error: readError } = await supabase
    .from('channel_metrics')
    .select('revenue, booked')
    .eq('channel_id', row.channel_id)
    .eq('month', row.month)
    .maybeSingle();
  if (readError) throw new Error(readError.message);

  const { error } = await supabase
    .from('channel_metrics')
    .upsert({
      ...row,
      revenue: Number(existing?.revenue || 0),
      booked: Number(existing?.booked || 0),
    }, { onConflict: 'channel_id,month' });
  if (error) throw new Error(error.message);
}

async function collect(months = trailingMonths(Number(process.env.LSA_MONTHS_BACK || 12))) {
  const accessToken = await getAccessToken();
  const managerCustomerId = normalizeCustomerId(requireEnv('LSA_MANAGER_CUSTOMER_ID'));
  const accounts = parseAccounts();
  const results = [];

  for (const month of months) {
    for (const account of accounts) {
      const reports = await fetchAccountReports({ accessToken, managerCustomerId, account, month });
      results.push(summarizeReport(account, month, reports));
    }
  }

  return results;
}

async function sync(monthsBack = Number(process.env.LSA_MONTHS_BACK || 12)) {
  const results = await collect(trailingMonths(monthsBack));
  const rows = results.map(result => ({
    channel_id: result.channelId,
    month: result.month,
    spend: result.spend,
    leads: result.leads,
    source: 'lsa',
    updated_at: new Date().toISOString(),
  }));

  for (const row of rows) {
    await upsertLsaMetric(row);
  }

  return {
    rowsAffected: rows.length,
    message: `Synced ${rows.length} LSA channel-month rows`,
  };
}

async function probe(monthsBack = 1) {
  return collect(trailingMonths(monthsBack));
}

module.exports = { collect, probe, sync };
