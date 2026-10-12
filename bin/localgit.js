#!/usr/bin/env node
'use strict';

const { main } = require('../src/cli');

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`localgit: ${error.message}\n`);
  process.exit(1);
});
