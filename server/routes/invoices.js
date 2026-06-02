const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const invoiceInbox = require('../services/invoiceInbox');

async function writeInvoiceSpend(channelId, month, spend) {
  const { data: existing, error: readError } = await supabase
    .from('channel_metrics')
    .select('revenue, leads, booked')
    .eq('channel_id', channelId)
    .eq('month', month)
    .maybeSingle();
  if (readError) throw new Error(readError.message);

  const { error: writeError } = await supabase
    .from('channel_metrics')
    .upsert({
      channel_id: channelId,
      month,
      spend,
      revenue: Number(existing?.revenue || 0),
      leads: Number(existing?.leads || 0),
      booked: Number(existing?.booked || 0),
      source: 'invoice',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'channel_id,month' });
  if (writeError) throw new Error(writeError.message);
}

async function reconcileApprovedInvoiceSpend() {
  const invoices = await invoiceInbox.listInvoices();
  const approved = invoices.filter(invoice => invoice.status === 'approved');
  const spendByChannelMonth = new Map();

  for (const invoice of approved) {
    if (!invoice.channelId || !invoice.month || invoice.amount === null || invoice.amount === undefined) {
      throw new Error(`Approved invoice ${invoice.invoiceNumber || invoice.id} is missing channel, month, or amount`);
    }

    const key = `${invoice.channelId}__${invoice.month}`;
    spendByChannelMonth.set(key, (spendByChannelMonth.get(key) || 0) + Number(invoice.amount || 0));
  }

  for (const [key, spend] of spendByChannelMonth.entries()) {
    const [channelId, month] = key.split('__');
    await writeInvoiceSpend(channelId, month, spend);
  }

  const marked = [];
  for (const invoice of approved) {
    marked.push(await invoiceInbox.updateInvoice(invoice.id, {
      metricsAppliedAt: new Date().toISOString(),
    }));
  }

  return {
    applied: spendByChannelMonth.size,
    invoices: marked,
  };
}

router.get('/', async (req, res) => {
  try {
    res.json(await invoiceInbox.listInvoices());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const invoice = await invoiceInbox.createInvoice(req.body);
    res.status(201).json(invoice);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    res.json(await invoiceInbox.updateInvoice(req.params.id, req.body));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.post('/reconcile', async (req, res) => {
  try {
    res.json(await reconcileApprovedInvoiceSpend());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/approve', async (req, res) => {
  try {
    const current = await invoiceInbox.getInvoice(req.params.id);
    if (current.status === 'approved' && current.metricsAppliedAt) {
      return res.json(current);
    }

    const draft = { ...current, ...req.body };
    const invoice = await invoiceInbox.updateInvoice(req.params.id, {
      ...draft,
      status: 'approved',
      approvedAt: draft.approvedAt || new Date().toISOString(),
    });
    await reconcileApprovedInvoiceSpend();

    res.json(invoice);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id/file', async (req, res) => {
  try {
    const invoice = await invoiceInbox.getInvoice(req.params.id);
    res.download(invoiceInbox.filePathFor(invoice), invoice.originalFileName);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

module.exports = router;
