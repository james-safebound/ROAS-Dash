const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const googleAds = require('../services/googleAds');
const lsa = require('../services/lsa');
const invoiceParser = require('../services/invoiceParser');

const SOURCES = { 'google-ads': googleAds, lsa, invoices: invoiceParser };

async function startLog(source) {
  const { data } = await supabase
    .from('sync_logs')
    .insert({ source, status: 'running' })
    .select('id')
    .single();
  return data?.id;
}

async function finishLog(id, status, message, rowsAffected = 0) {
  await supabase
    .from('sync_logs')
    .update({ status, message, rows_affected: rowsAffected, finished_at: new Date().toISOString() })
    .eq('id', id);
}

// POST /api/sync/:source
// Triggers a sync for the given source. Returns immediately with a log ID;
// the sync runs in the background. Poll GET /api/sync/logs for status.
router.post('/:source', async (req, res) => {
  const { source } = req.params;
  const service = SOURCES[source];
  if (!service) {
    return res.status(404).json({ error: `Unknown sync source: ${source}` });
  }

  const logId = await startLog(source);
  res.json({ logId, status: 'running' });

  // Run in background (non-blocking)
  service.sync()
    .then(({ rowsAffected, message }) => finishLog(logId, 'success', message, rowsAffected))
    .catch(err => finishLog(logId, 'error', err.message));
});

// GET /api/sync/logs
// Returns recent sync logs (last 50)
router.get('/logs', async (req, res) => {
  const { data, error } = await supabase
    .from('sync_logs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/sync/logs/:id
router.get('/logs/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('sync_logs')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
