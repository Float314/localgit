'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

/**
 * Escape a string for safe inclusion in HTML text/attributes.
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Return the per-user configuration directory for localgit.
 * Honours XDG_CONFIG_HOME on Linux and the platform equivalents elsewhere.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 * @returns {string}
 */
function configDir(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const base = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'localgit');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'localgit');
  }
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'localgit');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 * @returns {string}
 */
function configPath(env = process.env, platform = process.platform) {
  return path.join(configDir(env, platform), 'config.json');
}

/**
 * Expand a leading `~` and resolve to an absolute path.
 * @param {string} input
 * @returns {string}
 */
function expandPath(input) {
  if (!input) return input;
  let out = input;
  if (out === '~') out = os.homedir();
  else if (out.startsWith('~/') || out.startsWith('~\\')) {
    out = path.join(os.homedir(), out.slice(2));
  }
  return path.resolve(out);
}

/**
 * @param {string} p
 * @returns {boolean}
 */
function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Minimal colour helper. Disabled when not attached to a TTY or when
 * NO_COLOR is set.
 * @param {NodeJS.WriteStream} stream
 */
function colors(stream = process.stdout) {
  const enabled =
    stream.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  const wrap = (code) => (s) => (enabled ? `\u001b[${code}m${s}\u001b[0m` : String(s));
  return {
    enabled,
    bold: wrap('1'),
    dim: wrap('2'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    blue: wrap('34'),
    cyan: wrap('36'),
  };
}

module.exports = {
  escapeHtml,
  configDir,
  configPath,
  expandPath,
  isDirectory,
  colors,
};
