require('dotenv').config();

const { probe } = require('../services/granot');

const monthsBack = parseInt(process.argv[2], 10) || 1;

probe(monthsBack)
  .then(result => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch(err => {
    console.error('[granot probe] failed:', err.message);
    process.exitCode = 1;
  });
