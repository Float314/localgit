'use strict';

const { spawn } = require('node:child_process');

/**
 * Bridge a Node request to `git http-backend` (CGI), giving clients the smart
 * HTTP protocol: clone, fetch, pull and push.
 *
 * `git http-backend` speaks CGI. It reads the request body from stdin and
 * writes CGI response headers + body to stdout. We translate both directions.
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
    maxBodyBytes = 2 * 1024 * 1024 * 1024,
  } = options;

  if (req.method === 'POST' && !allowPush) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Push is disabled on this server.\n');
    return;
  }

  const isBodyless = req.method === 'GET' || req.method === 'HEAD';
  const contentLength = Number(req.headers['content-length']);
  const hasContentLength = Number.isFinite(contentLength) && contentLength >= 0;

  let bufferedBody = null;
  if (!isBodyless && !hasContentLength) {
    // Chunked transfer encoding: buffer so we can hand the backend a
    // CONTENT_LENGTH, which CGI requires.
    try {
      bufferedBody = await readBody(req, maxBodyBytes);
    } catch (error) {
      res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`${error.message}\n`);
      return;
    }
  }

  const env = buildEnv(req, { projectRoot, pathInfo, allowPush, updateWorkTree });
  if (bufferedBody) env.CONTENT_LENGTH = String(bufferedBody.length);

  const child = spawn('git', ['http-backend'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  let headersDone = false;
  let headerBuffer = Buffer.alloc(0);

  const writeHeaders = (terminatorIndex, terminatorLength) => {
    const rawHeaders = headerBuffer.subarray(0, terminatorIndex).toString('utf8');
    const body = headerBuffer.subarray(terminatorIndex + terminatorLength);

    let status = 200;
    let statusMessage;
    /** @type {Record<string,string>} */
    const headers = {};

    for (const line of rawHeaders.split(/\r?\n/)) {
      if (!line) continue;
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (key.toLowerCase() === 'status') {
        const match = value.match(/^(\d{3})\s*(.*)$/);
        if (match) {
          status = Number(match[1]);
          if (match[2]) statusMessage = match[2];
        }
      } else {
        headers[key] = value;
      }
    }

    headersDone = true;
    res.writeHead(status, statusMessage, headers);
    if (body.length) res.write(body);
  };

  child.stdout.on('data', (chunk) => {
    if (headersDone) {
      res.write(chunk);
      return;
    }
    headerBuffer = Buffer.concat([headerBuffer, chunk]);
    let index = headerBuffer.indexOf('\r\n\r\n');
    let length = 4;
    if (index === -1) {
      index = headerBuffer.indexOf('\n\n');
      length = 2;
    }
    if (index === -1) return;
    writeHeaders(index, length);
  });

  child.stdout.on('end', () => {
    if (!headersDone) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(stderr || 'git http-backend produced no response\n');
      return;
    }
    res.end();
  });

  child.on('error', (error) => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Failed to start git http-backend: ${error.message}\n`);
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  child.on('close', (code) => {
    if (code !== 0 && stderr) process.stderr.write(`[localgit] git http-backend: ${stderr}`);
    if (!res.writableEnded) res.end();
  });

  // Feed the request body into the backend.
  if (isBodyless) {
    child.stdin.end();
  } else if (bufferedBody) {
    child.stdin.end(bufferedBody);
  } else {
    let written = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      written += chunk.length;
      if (written > maxBodyBytes) {
        aborted = true;
        req.destroy();
        child.kill();
        return;
      }
      child.stdin.write(chunk);
    });
    req.on('end', () => child.stdin.end());
    req.on('error', () => child.stdin.end());
  }

  res.on('close', () => {
    if (!child.killed && !res.writableEnded) child.kill();
  });
}

/**
 * Collect a request body, rejecting once `limit` bytes is exceeded.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Buffer>}
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
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
