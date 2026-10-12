'use strict';

/**
 * Programmatic entry point for localgit.
 *
 * @example
 * const { createServer, discover } = require('localgit');
 * const { server } = createServer({ dir: '/media/usb', port: 4000, host: '127.0.0.1', allowPush: true, web: true, scanDepth: 3 });
 * server.listen(4000);
 */

const config = require('./config');
const repos = require('./repos');
const { createServer } = require('./server');
const web = require('./web');

module.exports = {
  ...config,
  discover: repos.discover,
  buildIndex: repos.buildIndex,
  isGitDir: repos.isGitDir,
  createServer,
  web,
};
