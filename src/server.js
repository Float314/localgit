'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const path = require('node:path');

const { discover, buildIndex } = require('./repos');
const { serveGitHttp } = require('./git-http');
const web = require('./web');

/**
 * @typedef {{
 *   dir: string,
 *   host: string,
 *   port: number,
 *   allowPush: boolean,
 *   web: boolean,
 *   scanDepth: number,
 * }} ServerConfig
 */

/**
 * Repository registry with a small scan cache so pull/push requests stay fast
 * while newly created repositories still appear promptly.
 * @param {{dir:string, depth:number, ttl?:number}} options
 */
function createRegistry({ dir, depth, ttl = 2000 }) {
  let repos = [];
  let index = new Map();
  let warnings = [];
  let last = 0;

  return {
    refresh(force = false) {
      const now = Date.now();
      if (!force && now - last < ttl) return;
      const result = discover(dir, { depth });
      repos = result.repos;
      index = buildIndex(repos);
      warnings = result.warnings;
      last = now;
    },
    get repos() {
      return repos;
    },
    get index() {
      return index;
    },
    get warnings() {
      return warnings;
    },
  };
}

/**
 * Is this remainder a git smart- or dumb-protocol endpoint?
 * @param {string} rest path after the repository name, e.g. "/info/refs"
 */
function isGitEndpoint(rest) {
  if (
    rest === '/info/refs' ||
    rest === '/git-upload-pack' ||
    rest === '/git-receive-pack' ||
    rest === '/HEAD' ||
    rest === '/info/packs'
  ) {
    return true;
  }
  return rest.startsWith('/objects/') || rest.startsWith('/refs/');
}

/**
 * Split a pathname into decoded segments, ignoring empty ones.
 * @param {string} pathname
 */
function segmentsOf(pathname) {
  return pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/**
 * Create the localgit HTTP server.
 * @param {ServerConfig} config
 * @param {{ttl?:number, log?:(msg:string)=>void}} [options]
 * @returns {{server: http.Server, registry: object, close: () => Promise<void>}}
 */
function createServer(config, options = {}) {
  const registry = createRegistry({
    dir: config.dir,
    depth: config.scanDepth,
    ttl: options.ttl,
  });
  registry.refresh(true);

  const serve = (req, res) => handle(req, res).catch((error) => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end(`Internal error: ${error.message}\n`);
  });

  const handle = async (req, res) => {
    registry.refresh();

    const host = req.headers.host || `${config.host}:${config.port}`;
    const base = `http://${host}`;
    const requestUrl = new URL(req.url || '/', base);
    const pathname = requestUrl.pathname;

    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    const segments = segmentsOf(pathname);

    // Root: repository listing.
    if (segments.length === 0) {
      if (!config.web) return notFound(res, base, 'Web browser is disabled.');
      const html = await web.renderHome({
        repos: registry.repos,
        base,
        config,
        dir: config.dir,
      });
      return sendHtml(res, html);
    }

    // Resolve the repository by the longest matching prefix so nested names
    // such as "team/project.git" resolve too.
    let repo = null;
    let consumed = 0;
    for (let i = segments.length; i >= 1; i -= 1) {
      const candidate = segments.slice(0, i).join('/');
      const found = registry.index.get(candidate);
      if (found) {
        repo = found;
        consumed = i;
        break;
      }
    }

    if (!repo) {
      return notFound(res, base, `No repository named "${segments[0]}".`);
    }

    const rest = `/${segments.slice(consumed).join('/')}`;
    const restRaw = rest === '/' ? '/' : rest;

    if (isGitEndpoint(restRaw)) {
      const rel = repo.relGitDir ? `/${repo.relGitDir}` : '';
      const pathInfo = normalizePath(`${rel}${restRaw}`);
      await serveGitHttp(req, res, {
        projectRoot: config.dir,
        pathInfo,
        allowPush: config.allowPush,
        log: options.log,
      });
      return;
    }

    if (!config.web) {
      return notFound(res, base, 'Web browser is disabled.');
    }

    await routeWeb(req, res, requestUrl, repo, base, segments.slice(consumed));
  };

  /**
   * Route non-git requests to the web UI.
   */
  const routeWeb = async (req, res, requestUrl, repo, base, tail) => {
    const view = tail[0] || '';
    const ref = requestUrl.searchParams.get('ref') || undefined;
    const filePath = requestUrl.searchParams.get('path') || '';

    if (view === '') {
      return sendHtml(res, await web.renderRepo({ repo, base }));
    }

    if (view === 'tree') {
      return sendHtml(res, await web.renderTree({ repo, base, ref, path: filePath }));
    }

    if (view === 'blob') {
      const result = await web.renderBlob({ repo, base, ref, path: filePath });
      if (result.notFound) return notFound(res, base, `File not found: ${filePath}`);
      return sendHtml(res, result.html);
    }

    if (view === 'raw') {
      const resolvedRef = await web.resolveRef(repo.gitDir, ref);
      const content = await web.readBlob(repo.gitDir, resolvedRef, filePath);
      if (!content) return notFound(res, base, `File not found: ${filePath}`);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': content.length,
        'Content-Disposition': `inline; filename="${path.basename(filePath)}"`,
      });
      return res.end(content);
    }

    if (view === 'commit') {
      const id = requestUrl.searchParams.get('id') || '';
      const result = await web.renderCommit({ repo, base, id });
      if (result.notFound) return notFound(res, base, `Unknown commit: ${id}`);
      return sendHtml(res, result.html);
    }

    if (view === 'log') {
      return sendHtml(res, await web.renderLog({ repo, base, ref }));
    }

    if (view === 'branches' || view === 'tags') {
      return sendHtml(res, await web.renderRefs({ repo, base, kind: view }));
    }

    return notFound(res, base, `Unknown page "${view}".`);
  };

  const server = http.createServer(serve);

  // Support clients that use "Expect: 100-continue" (some large pushes).
  server.on('checkContinue', (req, res) => {
    res.writeContinue();
    serve(req, res);
  });

  return {
    server,
    registry,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // fetch()/undici keeps connections alive; drop them so close() resolves.
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      }),
  };
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} html
 */
function sendHtml(res, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} base
 * @param {string} message
 */
function notFound(res, base, message) {
  const body = Buffer.from(web.renderError({ base, message, status: 404 }), 'utf8');
  res.writeHead(404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

/**
 * Collapse duplicate slashes and guarantee a leading slash.
 * @param {string} p
 */
function normalizePath(p) {
  const withSlash = p.startsWith('/') ? p : `/${p}`;
  return withSlash.replace(/\/{2,}/g, '/');
}

module.exports = { createServer, createRegistry, isGitEndpoint, normalizePath };
