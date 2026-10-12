'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { serveCgi } = require('./cgi');

/**
 * cgit web interface support.
 *
 * cgit (https://git.zx2c4.com/cgit/) is a fast, dependency-free git browser
 * implemented as a CGI program, typically served from a web server with root
 * mappings like `/cgit/...`. We run it *as the root* (`virtual-root=/`) so the
 * URLs cgit generates (`/demo.git/tree/…`) land exactly in localgit's existing
 * URL space, next to the smart-HTTP git endpoints.
 *
 * Nothing is ever installed on the user's drive: the `cgitrc` is generated
 * into a fresh temporary directory on server start (and used via
 * `CGIT_CONFIG`), and caching is disabled so cgit never writes cache files.
 */

/** Well-known locations of the cgit CGI binary (Debian ships it as cgit.cgi). */
const BINARY_CANDIDATES = [
  'cgit',
  'cgit.cgi',
  '/usr/lib/cgit/cgit.cgi',
  '/usr/libexec/cgit/cgit.cgi',
  '/usr/lib/cgit/cgit',
  '/usr/bin/cgit',
  '/usr/local/lib/cgit/cgit.cgi',
  '/usr/local/libexec/cgit/cgit.cgi',
];

/** Well-known locations of cgit's static assets (css, logo, …). */
const ASSET_DIRS = [
  '/usr/share/cgit',
  '/usr/local/share/cgit',
  '/usr/share/webapps/cgit',
  '/usr/lib/cgit',
];

/** Static files cgit references that localgit hands out verbatim. */
const ASSET_TYPES = {
  'cgit.css': 'text/css; charset=utf-8',
  'cgit.js': 'text/javascript; charset=utf-8',
  'cgit.png': 'image/png',
  'cgit.svg': 'image/svg+xml',
  'favicon.ico': 'image/x-icon',
  'robots.txt': 'text/plain; charset=utf-8',
};

/**
 * Resolve a bare executable name against PATH.
 * @param {string} name
 * @returns {string|null}
 */
function which(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function isExecutableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the cgit binary. `explicit` (a config value, env or test option)
 * wins; otherwise well-known names and paths are tried.
 * @param {string} [explicit]
 * @returns {string|null}
 */
function findBinary(explicit) {
  const candidates = [explicit, process.env.CGIT_BINARY, ...BINARY_CANDIDATES].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (isExecutableFile(candidate)) return candidate;
    } else {
      const resolved = which(candidate);
      if (resolved) return resolved;
    }
  }
  return null;
}

/**
 * Locate the directory holding cgit's static assets.
 * @param {string} [explicit]
 * @returns {string|null}
 */
function findAssetDir(explicit) {
  const candidates = [explicit, process.env.CGIT_ASSETS, ...ASSET_DIRS].filter(Boolean);
  for (const dir of candidates) {
    try {
      if (fs.statSync(path.join(dir, 'cgit.css')).isFile()) return dir;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Probe for cgit on this machine (used by `localgit setup` to hint the user).
 * @returns {{binary: string, assetDir: string|null}|null}
 */
function locate(explicit) {
  const binary = findBinary(explicit);
  if (!binary) return null;
  return { binary, assetDir: findAssetDir() };
}

/**
 * Resolve a single explicitly configured cgit binary. Unlike `findBinary`
 * this never falls back to auto-detection: if the caller pointed at a binary,
 * they meant that binary.
 * @param {string} candidate
 * @returns {string|null}
 */
function locateExplicit(candidate) {
  if (candidate.includes('/') || candidate.includes('\\')) {
    return isExecutableFile(candidate) ? candidate : null;
  }
  return which(candidate);
}

/**
 * Render the cgitrc content for a session.
 *
 * Rather than relying on cgit's `scan-path` (which discovers repositories
 * under different names than localgit, e.g. a work tree `plain/.git` instead
 * of `plain`), the rc lists explicit `repo.url` / `repo.path` entries built
 * from localgit's own discovery result. That keeps the URLs cgit generates
 * inside localgit's URL space, and localgit rewrites the rc whenever the
 * discovered repository set changes.
 *
 * For bare repositories `repo.path` is the repository directory itself; for
 * work trees it is the resolved git directory (`.git`), which is what cgit
 * needs to run its git commands.
 *
 * Caching is off so cgit touches only memory, and static asset paths point at
 * files localgit serves under `/cgit.css`, `/cgit.js`, `/cgit.png` and
 * `/favicon.ico`. When no asset directory is available the resource links are
 * blanked so cgit renders fine without any external files.
 *
 * @param {{assetDir?: string|null, repos?: Array<object>}} [options]
 * @returns {string}
 */
function renderCgitrc(options = {}) {
  const assetDir = options.assetDir || null;
  const repos = options.repos || [];
  const lines = [
    '# Generated by localgit. Do not edit; it is rewritten whenever the',
    '# discovered repository set changes.',
    '# Both the cgitrc and any cgit cache live outside the served drive.',
    'virtual-root=/',
    'root-title=localgit',
    'root-desc=Git repositories served by localgit',
    'enable-http-clone=1',
    `clone-url=http://$HTTP_HOST$SCRIPT_NAME/$CGIT_REPO_URL`,
    'snapshots=0',
    'cache-size=0',
    'robots=index, nofollow',
  ];
  if (assetDir) {
    lines.push('css=/cgit.css', 'js=/cgit.js', 'logo=/cgit.png', 'favicon=/favicon.ico');
  } else {
    lines.push('css=', 'js=', 'logo=', 'favicon=/favicon.ico');
  }
  lines.push('');
  for (const repo of repos) {
    lines.push(`repo.url=${repo.name}`, `repo.path=${repo.gitDir}`, '');
  }
  return `${lines.join('\n')}`;
}

/**
 * Build the CGI environment handed to the cgit binary.
 * @param {import('node:http').IncomingMessage} req
 * @param {{config: {host:string, port:number}, runtime: object}} ctx
 * @returns {NodeJS.ProcessEnv}
 */
function cgiEnv(req, ctx) {
  const { config, runtime } = ctx;
  const host = req.headers.host || `${config.host}:${config.port}`;
  const [serverName, serverPort = '80'] = host.split(':');
  const queryIndex = (req.url || '').indexOf('?');

  return {
    ...process.env,
    CGIT_CONFIG: runtime.configFile,
    PATH_INFO: new URL(req.url, `http://${host}`).pathname,
    SCRIPT_NAME: '',
    QUERY_STRING: queryIndex === -1 ? '' : (req.url || '').slice(queryIndex + 1),
    REQUEST_METHOD: req.method || 'GET',
    CONTENT_TYPE: req.headers['content-type'] || '',
    CONTENT_LENGTH: req.headers['content-length'] || '',
    REMOTE_ADDR: req.socket.remoteAddress || '',
    REMOTE_USER: '',
    SERVER_NAME: serverName,
    SERVER_PORT: serverPort,
    SERVER_PROTOCOL: `HTTP/${req.httpVersion}`,
    SERVER_SOFTWARE: 'localgit',
    GATEWAY_INTERFACE: 'CGI/1.1',
    HTTP_HOST: host,
  };
}

/**
 * Set up the per-process cgit runtime: locate the binary (throwing a helpful
 * error when missing), generate a temporary cgitrc and remember the asset dir.
 * @param {{dir:string, host:string, port:number}} config
 * @param {{command?:string, assetDir?:string, repos?:Array<object>}} [options] test/override hooks
 * @returns {object}
 */
function createRuntime(config, options = {}) {
  const explicit = options.command || config.cgitCommand || process.env.CGIT_BINARY;
  // An explicitly configured binary is honored strictly (no silent fallback);
  // otherwise cgit is auto-detected on PATH and at well-known locations.
  const binary = explicit ? locateExplicit(explicit) : findBinary();
  if (!binary) {
    throw new Error(
      `cgit web interface is enabled, but no cgit executable was found. ` +
        `${explicit ? `Configured binary "${explicit}" is not usable. ` : ''}` +
        `Install cgit, set CGIT_BINARY to its path, or use --web-ui builtin.`,
    );
  }
  const assetDir = findAssetDir(options.assetDir || config.cgitAssets || process.env.CGIT_ASSETS);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localgit-cgit-'));
  const configFile = path.join(workDir, 'cgitrc');

  /** Last cgitrc content written, so we only touch the file when it changes. */
  let cgitrcContent = '';
  const updateRepos = (repos) => {
    const next = renderCgitrc({ assetDir, repos });
    if (next === cgitrcContent) return;
    cgitrcContent = next;
    fs.writeFileSync(configFile, next, 'utf8');
  };
  updateRepos(options.repos || []);

  return {
    binary,
    assetDir,
    configFile,
    workDir,
    /** Keep the generated cgitrc in sync with the discovered repositories. */
    updateRepos,
    /** Proxy a request to the cgit CGI program. */
    serveRequest(req, res) {
      serveCgi(req, res, { command: binary, env: cgiEnv(req, { config, runtime: this }) });
    },
    /**
     * Serve one of cgit's static assets (`/cgit.css`, `/favicon.ico`, …).
     * Returns true when the response was written, false to fall through.
     * @param {string} pathname
     * @param {import('node:http').ServerResponse} res
     */
    assetRequest(pathname, res) {
      const name = pathname.slice(1);
      if (!assetDir || !name || name.includes('/') || !Object.hasOwn(ASSET_TYPES, name)) {
        return false;
      }
      let body;
      try {
        body = fs.readFileSync(path.join(assetDir, name));
      } catch {
        return false;
      }
      res.writeHead(200, {
        'Content-Type': ASSET_TYPES[name],
        'Content-Length': body.length,
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(body);
      return true;
    },
    /** Delete the temporary directory holding the generated cgitrc. */
    dispose() {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

module.exports = {
  BINARY_CANDIDATES,
  ASSET_DIRS,
  ASSET_TYPES,
  which,
  isExecutableFile,
  findBinary,
  findAssetDir,
  locate,
  locateExplicit,
  renderCgitrc,
  cgiEnv,
  createRuntime,
};