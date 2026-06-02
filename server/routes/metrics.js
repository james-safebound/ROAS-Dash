const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');

// GET /api/metrics
// Returns { [channelId]: { [YYYY-MM]: { spend, revenue, leads, booked } } }
// Optional ?month=YYYY-MM to filter to one month
router.get('/', async (req, res) => {
  const { month } = req.query;

  let query = supabase
    .from('channel_metrics')
    .select('channel_id, month, spend, revenue, leads, booked, source, updated_at');

  if (month) query = query.eq('month', month);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Shape: { [channelId]: { [month]: {...} } }
  const result = {};
  for (const row of data) {
    if (!result[row.channel_id]) result[row.channel_id] = {};
    result[row.channel_id][row.month] = {
      spend:    parseFloat(row.spend),
      revenue:  parseFloat(row.revenue),
      leads:    row.leads,
      booked:   row.booked,
      source:   row.source,
      updatedAt: row.updated_at,
    };
  }
  res.json(result);
});

// GET /api/metrics/channels
// Returns the channels list
router.get('/channels', async (req, res) => {
  const { data, error } = await supabase
    .from('channels')
    .select('*')
    .order('display_order');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PUT /api/metrics/:channelId/:month
// Upserts a single month row for a channel
// Body: { spend, revenue, leads, booked }
router.put('/:channelId/:month', async (req, res) => {
  const { channelId, month } = req.params;
  const { spend, revenue, leads, booked } = req.body;

  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month must be YYYY-MM format' });
  }

  const { data, error } = await supabase
    .from('channel_metrics')
    .upsert(
      {
        channel_id: channelId,
        month,
        spend:   parseFloat(spend)   || 0,
        revenue: parseFloat(revenue) || 0,
        leads:   parseInt(leads)     || 0,
        booked:  parseInt(booked)    || 0,
        source: 'manual',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'channel_id,month' }
    )
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/metrics/:channelId/:month
router.delete('/:channelId/:month', async (req, res) => {
  const { channelId, month } = req.params;
  const { error } = await supabase
    .from('channel_metrics')
    .delete()
    .eq('channel_id', channelId)
    .eq('month', month);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
