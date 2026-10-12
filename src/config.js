'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { configDir, configPath, expandPath } = require('./util');

/** @typedef {{
 *   dir: string,
 *   host: string,
 *   port: number,
 *   allowPush: boolean,
 *   web: boolean,
 *   webInterface: 'builtin'|'cgit',
 *   scanDepth: number,
 *   cgitCommand?: string,
 *   cgitAssets?: string,
 *   createdAt?: string,
 *   updatedAt?: string,
 * }} LocalgitConfig */

const DEFAULTS = {
  host: '127.0.0.1',
  port: 4000,
  allowPush: true,
  web: true,
  webInterface: 'builtin',
  scanDepth: 3,
};

/**
 * Coerce `webInterface`. Anything other than "cgit" is treated as the
 * built-in interface.
 * @param {string|undefined} value
 * @returns {'builtin'|'cgit'}
 */
function normalizeWebInterface(value) {
  return String(value || '').toLowerCase() === 'cgit' ? 'cgit' : 'builtin';
}

/**
 * Coerce and validate a partial config, filling in defaults.
 * @param {Partial<LocalgitConfig>} input
 * @returns {LocalgitConfig}
 */
function normalize(input = {}) {
  /** @type {LocalgitConfig} */
  const config = {
    dir: input.dir ? expandPath(String(input.dir)) : process.cwd(),
    host: input.host ? String(input.host) : DEFAULTS.host,
    port: Number.isFinite(Number(input.port)) ? Number(input.port) : DEFAULTS.port,
    allowPush: input.allowPush === undefined ? DEFAULTS.allowPush : Boolean(input.allowPush),
    web: input.web === undefined ? DEFAULTS.web : Boolean(input.web),
    webInterface: normalizeWebInterface(input.webInterface),
    scanDepth:
      input.scanDepth === undefined ? DEFAULTS.scanDepth : Number(input.scanDepth),
  };
  if (input.cgitCommand) config.cgitCommand = String(input.cgitCommand);
  if (input.cgitAssets) config.cgitAssets = String(input.cgitAssets);
  if (input.createdAt) config.createdAt = input.createdAt;
  if (input.updatedAt) config.updatedAt = input.updatedAt;
  return config;
}

/**
 * Path of the config file. `LOCALGIT_CONFIG` overrides the platform default.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function resolveConfigPath(env = process.env) {
  return env.LOCALGIT_CONFIG ? expandPath(env.LOCALGIT_CONFIG) : configPath(env);
}

/**
 * @param {string} [file]
 * @returns {LocalgitConfig|null}
 */
function load(file = resolveConfigPath()) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return normalize(JSON.parse(raw));
  } catch (error) {
    throw new Error(`Could not parse config at ${file}: ${error.message}`);
  }
}

/**
 * @param {Partial<LocalgitConfig>} config
 * @param {string} [file]
 * @returns {string} the file that was written
 */
function save(config, file = resolveConfigPath()) {
  const now = new Date().toISOString();
  const existing = load(file);
  const normalized = normalize(config);
  const payload = {
    ...normalized,
    createdAt: (existing && existing.createdAt) || config.createdAt || now,
    updatedAt: now,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

module.exports = {
  DEFAULTS,
  normalize,
  normalizeWebInterface,
  resolveConfigPath,
  configDir,
  load,
  save,
};
