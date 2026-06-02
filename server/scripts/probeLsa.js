require('dotenv').config();

const { probe } = require('../services/lsa');

const parsedMonthsBack = parseInt(process.argv[2], 10);
const monthsBack = Number.isNaN(parsedMonthsBack) ? 1 : parsedMonthsBack;

probe(monthsBack)
  .then(result => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch(err => {
    console.error('[lsa probe] failed:', err.message);
    process.exitCode = 1;
  });
