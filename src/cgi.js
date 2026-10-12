'use strict';

const { spawn } = require('node:child_process');

/**
 * Bridge a Node request to an arbitrary CGI program (used for `git
 * http-backend` and for `cgit`).
 *
 * Both speak CGI: they read the request body from stdin and write CGI
 * response headers + body to stdout. We translate both directions:
 *
 * - requests without `Content-Length` (chunked bodies) are buffered first so
 *   the child always sees a real `CONTENT_LENGTH`,
 * - the child's stdout is streamed, with the first header block parsed as
 *   CGI response headers (`Status`, `Content-Type`, …) followed by the body.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{
 *   command: string,
 *   args?: string[],
 *   env: NodeJS.ProcessEnv,
 *   maxBodyBytes?: number,
 *   label?: string,
 *   onExit?: (code: number|null, stderr: string) => void,
 * }} options
 */
function serveCgi(req, res, options) {
  const {
    command,
    args = [],
    env,
    maxBodyBytes = 2 * 1024 * 1024 * 1024,
    label = command,
    onExit,
  } = options;

  const isBodyless = req.method === 'GET' || req.method === 'HEAD';
  const contentLength = Number(req.headers['content-length']);
  const hasContentLength = Number.isFinite(contentLength) && contentLength >= 0;

  /**
   * Spawn the CGI program and wire stdin/stdout once the body situation is
   * known.
   * @param {Buffer|null} bufferedBody set when the body was buffered first
   */
  const spawnAndPipe = (bufferedBody) => {
    if (bufferedBody) env.CONTENT_LENGTH = String(bufferedBody.length);

    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(command, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Failed to start ${label}: ${error.message}\n`);
      return;
    }

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
        res.end(stderr || `${label} produced no response\n`);
        return;
      }
      res.end();
    });

    child.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Failed to start ${label}: ${error.message}\n`);
      } else if (!res.writableEnded) {
        res.end();
      }
    });

    child.on('close', (code) => {
      if (onExit) onExit(code, stderr);
      if (!res.writableEnded) res.end();
    });

    // Feed the request body into the child.
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
  };

  if (!isBodyless && !hasContentLength) {
    // Chunked transfer encoding: buffer so we can hand the backend a
    // CONTENT_LENGTH, which CGI requires.
    readBody(req, maxBodyBytes)
      .then(spawnAndPipe)
      .catch((error) => {
        res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`${error.message}\n`);
      });
    return;
  }
  spawnAndPipe(null);
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

module.exports = { serveCgi, readBody };