/**
 * Invoice email parser
 * Connects to an IMAP inbox, finds vendor invoice emails from the last 3 months,
 * parses spend totals, and upserts into channel_metrics.
 *
 * Required env vars:
 *   IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASSWORD, IMAP_INVOICE_FOLDER
 *
 * Each vendor sends invoices with a different format. Update VENDOR_PATTERNS below
 * with the sender email + a regex to extract the dollar amount from the body.
 */
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const supabase = require('../db/supabase');

// Map vendor email sender → { channelId, amountRegex }
const VENDOR_PATTERNS = [
  {
    channelId: 'safeship',
    fromMatch: /safeship/i,
    // Update regex to match the exact format in Safeship invoices
    amountRegex: /Total[:\s]+\$?([\d,]+\.?\d*)/i,
  },
  {
    channelId: 'movebuddha',
    fromMatch: /movebuddha/i,
    amountRegex: /Amount Due[:\s]+\$?([\d,]+\.?\d*)/i,
  },
  {
    channelId: 'forbes',
    fromMatch: /forbes/i,
    amountRegex: /Invoice Total[:\s]+\$?([\d,]+\.?\d*)/i,
  },
  {
    channelId: 'homeadvisor',
    fromMatch: /homeadvisor|angi/i,
    amountRegex: /Total Charged[:\s]+\$?([\d,]+\.?\d*)/i,
  },
];

function connectImap() {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user:     process.env.IMAP_USER,
      password: process.env.IMAP_PASSWORD,
      host:     process.env.IMAP_HOST,
      port:     parseInt(process.env.IMAP_PORT) || 993,
      tls:      true,
    });
    imap.once('ready', () => resolve(imap));
    imap.once('error', reject);
    imap.connect();
  });
}

function fetchMessages(imap, folder, sinceDate) {
  return new Promise((resolve, reject) => {
    imap.openBox(folder, true, (err) => {
      if (err) return reject(err);

      const since = sinceDate.toDateString();
      imap.search(['ALL', ['SINCE', since]], (err, uids) => {
        if (err) return reject(err);
        if (!uids.length) return resolve([]);

        const messages = [];
        const fetch = imap.fetch(uids, { bodies: '' });

        fetch.on('message', (msg) => {
          messages.push(new Promise((res) => {
            let buffer = '';
            msg.on('body', (stream) => {
              stream.on('data', (chunk) => { buffer += chunk.toString(); });
              stream.once('end', () => res(buffer));
            });
          }));
        });

        fetch.once('error', reject);
        fetch.once('end', () => resolve(Promise.all(messages)));
      });
    });
  });
}

function parseAmount(text, pattern) {
  const match = text.match(pattern.amountRegex);
  if (!match) return null;
  return parseFloat(match[1].replace(/,/g, ''));
}

function monthFromDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

async function sync() {
  const imap = await connectImap();
  const since = new Date();
  since.setMonth(since.getMonth() - 3);

  let rawMessages;
  try {
    rawMessages = await fetchMessages(imap, process.env.IMAP_INVOICE_FOLDER || 'INBOX', since);
  } finally {
    imap.end();
  }

  // Accumulate spend per channel per month
  const spendByChannelMonth = {};
  let parsed = 0;

  for (const raw of rawMessages) {
    const mail = await simpleParser(raw);
    const from = mail.from?.text || '';
    const date = mail.date || new Date();
    const body = mail.text || mail.html || '';

    const vendor = VENDOR_PATTERNS.find(v => v.fromMatch.test(from));
    if (!vendor) continue;

    const amount = parseAmount(body, vendor);
    if (!amount) continue;

    const month = monthFromDate(date);
    const key = `${vendor.channelId}__${month}`;
    spendByChannelMonth[key] = (spendByChannelMonth[key] || 0) + amount;
    parsed++;
  }

  // Upsert into Supabase (only spend column — leaves revenue/leads/booked intact)
  const rows = Object.entries(spendByChannelMonth).map(([key, spend]) => {
    const [channelId, month] = key.split('__');
    return { channel_id: channelId, month, spend, source: 'invoice', updated_at: new Date().toISOString() };
  });

  if (rows.length > 0) {
    const { error } = await supabase
      .from('channel_metrics')
      .upsert(rows, { onConflict: 'channel_id,month' });
    if (error) throw new Error(error.message);
  }

  return {
    rowsAffected: rows.length,
    message: `Parsed ${parsed} invoices → ${rows.length} channel-month spend totals updated`,
  };
}

module.exports = { sync };
