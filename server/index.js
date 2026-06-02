require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');

const metricsRouter = require('./routes/metrics');
const syncRouter = require('./routes/sync');

const app = express();
app.use(cors());
app.use(express.json());

// Serve dashboard
app.use(express.static(path.join(__dirname, '../client')));

// API routes
app.use('/api/metrics', metricsRouter);
app.use('/api/sync', syncRouter);

// Scheduled syncs — run each night at 2am
cron.schedule('0 2 * * *', () => {
  console.log('[cron] Starting nightly sync...');
  const { sync: syncGoogleAds } = require('./services/googleAds');
  const { sync: syncLSA }       = require('./services/lsa');
  const { sync: syncGranot }    = require('./services/granot');
  const { sync: syncInvoices }  = require('./services/invoiceParser');

  Promise.allSettled([syncGoogleAds(), syncLSA(), syncGranot(), syncInvoices()])
    .then(results => {
      results.forEach((r, i) => {
        const name = ['google-ads', 'lsa', 'granot', 'invoices'][i];
        if (r.status === 'fulfilled') console.log(`[cron] ${name}: ${r.value.message}`);
        else console.error(`[cron] ${name} error:`, r.reason?.message);
      });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Safebound ROAS Dashboard running at http://localhost:${PORT}`);
});
