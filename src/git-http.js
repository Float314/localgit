'use strict';

const { serveCgi } = require('./cgi');

/**
 * Bridge a Node request to `git http-backend` (CGI), giving clients the smart
 * HTTP protocol: clone, fetch, pull and push.
 *
 * `git http-backend` speaks CGI. It reads the request body from stdin and
 * writes CGI response headers + body to stdout. The translation lives in
 * `src/cgi.js`; this module only decides whether the request may push and
 * builds the CGI environment.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{
 *   projectRoot: string,
 *   pathInfo: string,
 *   allowPush: boolean,
 *   updateWorkTree?: boolean,
 *   maxBodyBytes?: number,
 *   log?: (...args: unknown[]) => void,
 * }} options
 * @returns {Promise<void>}
 */
async function serveGitHttp(req, res, options) {
  const {
    projectRoot,
    pathInfo,
    allowPush,
    updateWorkTree = true,
  } = options;

  if (req.method === 'POST' && !allowPush) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Push is disabled on this server.\n');
    return;
  }

  const env = buildEnv(req, { projectRoot, pathInfo, allowPush, updateWorkTree });

  serveCgi(req, res, {
    command: 'git',
    args: ['http-backend'],
    env,
    label: 'git http-backend',
    maxBodyBytes: options.maxBodyBytes,
    onExit: (code, stderr) => {
      if (code !== 0 && stderr) process.stderr.write(`[localgit] git http-backend: ${stderr}`);
    },
  });
}

/**
 * Build the CGI environment for git http-backend. Push is enabled per request
 * through git's environment config so we never have to mutate repo configs on
 * the (possibly read-only / removable) drive.
 * @param {import('node:http').IncomingMessage} req
 * @param {{projectRoot:string, pathInfo:string, allowPush:boolean, updateWorkTree:boolean}} ctx
 * @returns {NodeJS.ProcessEnv}
 */
function buildEnv(req, ctx) {
  const { projectRoot, pathInfo, allowPush, updateWorkTree } = ctx;
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    GIT_PROJECT_ROOT: projectRoot,
    GIT_HTTP_EXPORT_ALL: '1',
    GIT_HTTP_MAX_REQUEST_BUFFER: process.env.GIT_HTTP_MAX_REQUEST_BUFFER || '256M',
    PATH_INFO: pathInfo,
    REQUEST_METHOD: req.method || 'GET',
    QUERY_STRING: req.url && req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '',
    CONTENT_TYPE: req.headers['content-type'] || '',
    CONTENT_LENGTH: req.headers['content-length'] || '',
    REMOTE_ADDR: req.socket.remoteAddress || '',
    REMOTE_USER: '',
    SERVER_PROTOCOL: `HTTP/${req.httpVersion}`,
    SERVER_SOFTWARE: 'localgit',
    GATEWAY_INTERFACE: 'CGI/1.1',
  };

  // Feed push settings through git's environment configuration. This keeps
  // repositories untouched (important for read-only or removable drives).
  const configPairs = [['http.receivepack', allowPush ? 'true' : 'false']];
  if (updateWorkTree) {
    configPairs.push(['receive.denyCurrentBranch', 'updateInstead']);
  }
  env.GIT_CONFIG_COUNT = String(configPairs.length);
  configPairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });

  if (req.headers['content-encoding']) {
    env.HTTP_CONTENT_ENCODING = req.headers['content-encoding'];
  }

  return env;
}

module.exports = { serveGitHttp, buildEnv };
