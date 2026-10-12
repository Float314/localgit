'use strict';

const { execFile } = require('node:child_process');

const MAX_BUFFER = 128 * 1024 * 1024;

/**
 * Run a git command and resolve with stdout.
 * @param {string[]} args
 * @param {{cwd?: string, maxBuffer?: number, rejectOnError?: boolean}} [opts]
 * @returns {Promise<string>}
 */
function git(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: opts.cwd,
        maxBuffer: opts.maxBuffer || MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          if (opts.rejectOnError === false) return resolve(stdout);
          return reject(error);
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Run a git command and resolve with a raw Buffer (for binary-safe reads).
 * @param {string[]} args
 * @param {{cwd?: string, maxBuffer?: number}} [opts]
 * @returns {Promise<Buffer>}
 */
function gitBuffer(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: opts.cwd,
        maxBuffer: opts.maxBuffer || MAX_BUFFER,
        encoding: 'buffer',
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr ? stderr.toString('utf8') : '';
          return reject(error);
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * git log in a machine friendly, delimiter separated format.
 * @param {string} gitDir
 * @param {string} ref
 * @param {number} limit
 * @returns {Promise<Array<{hash:string,short:string,author:string,email:string,date:string,relative:string,subject:string}>>}
 */
async function log(gitDir, ref, limit = 25) {
  const format = '%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%ar%x1f%s%x1e';
  let out;
  try {
    out = await git(
      ['-C', gitDir, 'log', `--max-count=${limit}`, `--format=${format}`, ref || 'HEAD'],
      { rejectOnError: false },
    );
  } catch {
    return [];
  }
  return out
    .split('\x1e')
    .map((entry) => entry.replace(/^\s+/, ''))
    .filter(Boolean)
    .map((entry) => {
      const [hash, short, author, email, date, relative, subject] = entry.split('\x1f');
      return { hash, short, author, email, date, relative, subject };
    });
}

/**
 * List branches or tags.
 * @param {string} gitDir
 * @param {'refs/heads'|'refs/tags'} namespace
 * @returns {Promise<Array<{name:string,short:string,hash:string,relative:string,subject:string}>>}
 */
async function refs(gitDir, namespace) {
  const format = '%(refname)%1f%(refname:short)%1f%(objectname:short)%1f%(committerdate:relative)%1f%(subject)';
  const out = await git(
    ['-C', gitDir, 'for-each-ref', `--format=${format}`, namespace],
    { rejectOnError: false },
  );
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, short, hash, relative, subject] = line.split('\x1f');
      return { name, short, hash, relative, subject };
    });
}

/**
 * The symbolic ref HEAD points at, or null when detached.
 * @param {string} gitDir
 * @returns {Promise<string|null>}
 */
async function currentBranch(gitDir) {
  try {
    const out = await git(['-C', gitDir, 'symbolic-ref', '--short', 'HEAD'], {
      rejectOnError: false,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve any revision-ish string to a full commit hash.
 * @param {string} gitDir
 * @param {string} rev
 * @returns {Promise<string|null>}
 */
async function revParse(gitDir, rev) {
  try {
    const out = await git(['-C', gitDir, 'rev-parse', '--verify', `${rev}^{commit}`], {
      rejectOnError: false,
    });
    const hash = out.trim();
    return /^[0-9a-f]{7,40}$/.test(hash) ? hash : null;
  } catch {
    return null;
  }
}

module.exports = {
  git,
  gitBuffer,
  log,
  refs,
  currentBranch,
  revParse,
};
