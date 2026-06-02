const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '../../data');
const UPLOAD_DIR = path.join(__dirname, '../../uploads/invoices');
const STORE_PATH = path.join(DATA_DIR, 'invoices.json');

function monthFromDate(dateString) {
  if (!dateString) return '';
  const date = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function moneyFromText(text = '') {
  const patterns = [
    /(?:invoice\s+total|amount\s+due|total\s+due|total|amount)[:\s$]*\$?\s*([\d,]+(?:\.\d{2})?)/i,
    /\$\s*([\d,]+(?:\.\d{2})?)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1].replace(/,/g, ''));
  }
  return null;
}

function dateFromText(text = '') {
  const patterns = [
    /(?:invoice\s+date|date)[:\s]*([01]?\d[/-][0-3]?\d[/-]\d{2,4})/i,
    /\b([01]?\d[/-][0-3]?\d[/-]\d{2,4})\b/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const parsed = new Date(match[1]);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }
  return '';
}

function invoiceNumberFromText(text = '') {
  const match = text.match(/(?:invoice|inv)[\s#:.-]*([A-Z0-9-]{3,})/i);
  return match?.[1] || '';
}

function vendorFromName(name = '') {
  const cleaned = name
    .replace(/\.[^.]+$/, '')
    .replace(/invoice|inv|receipt|bill|\d{4}[-_ ]?\d{0,2}[-_ ]?\d{0,2}/gi, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || '';
}

function parseHints(fileName, mimeType, buffer) {
  const isTexty = /csv|text|json|xml|html/i.test(mimeType || '') || /\.(csv|txt|json|xml|html?)$/i.test(fileName);
  const text = isTexty ? buffer.toString('utf8').slice(0, 20000) : fileName;
  const invoiceDate = dateFromText(text);
  return {
    vendor: vendorFromName(fileName),
    invoiceNumber: invoiceNumberFromText(text),
    invoiceDate,
    month: monthFromDate(invoiceDate),
    amount: moneyFromText(text),
  };
}

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  try {
    await fs.access(STORE_PATH);
  } catch {
    await fs.writeFile(STORE_PATH, '[]');
  }
}

async function listInvoices() {
  await ensureStore();
  const raw = await fs.readFile(STORE_PATH, 'utf8');
  return JSON.parse(raw).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function writeInvoices(invoices) {
  await ensureStore();
  await fs.writeFile(STORE_PATH, JSON.stringify(invoices, null, 2));
}

function safeFileName(fileName) {
  return path.basename(fileName || 'invoice').replace(/[^a-z0-9_. -]/gi, '_');
}

async function createInvoice({ fileName, mimeType, contentBase64 }) {
  await ensureStore();
  if (!fileName || !contentBase64) {
    throw new Error('fileName and contentBase64 are required');
  }

  const id = crypto.randomUUID();
  const buffer = Buffer.from(contentBase64, 'base64');
  const storedName = `${id}-${safeFileName(fileName)}`;
  const storedPath = path.join(UPLOAD_DIR, storedName);
  await fs.writeFile(storedPath, buffer);

  const hints = parseHints(fileName, mimeType, buffer);
  const invoice = {
    id,
    status: 'needs_review',
    vendor: hints.vendor,
    invoiceNumber: hints.invoiceNumber,
    invoiceDate: hints.invoiceDate,
    month: hints.month,
    amount: hints.amount,
    channelId: '',
    notes: '',
    originalFileName: fileName,
    storedName,
    mimeType: mimeType || 'application/octet-stream',
    size: buffer.length,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    approvedAt: null,
  };

  const invoices = await listInvoices();
  invoices.unshift(invoice);
  await writeInvoices(invoices);
  return invoice;
}

async function updateInvoice(id, patch) {
  const invoices = await listInvoices();
  const index = invoices.findIndex(invoice => invoice.id === id);
  if (index === -1) throw new Error('Invoice not found');

  invoices[index] = {
    ...invoices[index],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  if (Object.prototype.hasOwnProperty.call(patch, 'amount')) {
    invoices[index].amount = patch.amount === '' || patch.amount === null || patch.amount === undefined
      ? null
      : Number(patch.amount);
  }
  await writeInvoices(invoices);
  return invoices[index];
}

async function getInvoice(id) {
  const invoice = (await listInvoices()).find(item => item.id === id);
  if (!invoice) throw new Error('Invoice not found');
  return invoice;
}

function filePathFor(invoice) {
  return path.join(UPLOAD_DIR, invoice.storedName);
}

module.exports = {
  createInvoice,
  filePathFor,
  getInvoice,
  listInvoices,
  updateInvoice,
};
