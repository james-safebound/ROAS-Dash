const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const invoiceInbox = require('../services/invoiceInbox');

async function applyInvoiceSpend(invoice) {
  if (!invoice.channelId || !invoice.month || invoice.amount === null || invoice.amount === undefined) {
    throw new Error('Vendor invoice must have channel, month, and amount before approval');
  }

  if (invoice.metricsAppliedAt) {
    return invoice;
  }

  const { data: existing, error: readError } = await supabase
    .from('channel_metrics')
    .select('spend, revenue, leads, booked')
    .eq('channel_id', invoice.channelId)
    .eq('month', invoice.month)
    .maybeSingle();
  if (readError) throw new Error(readError.message);

  const currentSpend = Number(existing?.spend || 0);
  const { error: writeError } = await supabase
    .from('channel_metrics')
    .upsert({
      channel_id: invoice.channelId,
      month: invoice.month,
      spend: currentSpend + Number(invoice.amount || 0),
      revenue: Number(existing?.revenue || 0),
      leads: Number(existing?.leads || 0),
      booked: Number(existing?.booked || 0),
      source: 'invoice',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'channel_id,month' });
  if (writeError) throw new Error(writeError.message);

  return invoiceInbox.updateInvoice(invoice.id, {
    metricsAppliedAt: new Date().toISOString(),
  });
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
    const invoices = await invoiceInbox.listInvoices();
    const approved = invoices.filter(invoice => invoice.status === 'approved' && !invoice.metricsAppliedAt);
    const applied = [];

    for (const invoice of approved) {
      applied.push(await applyInvoiceSpend(invoice));
    }

    res.json({
      applied: applied.length,
      invoices: applied,
    });
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
    await applyInvoiceSpend(draft);

    const invoice = await invoiceInbox.updateInvoice(req.params.id, {
      ...draft,
      status: 'approved',
      approvedAt: draft.approvedAt || new Date().toISOString(),
    });

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
