'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Directories we never descend into while scanning. */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.localgit',
  '.cache',
  '.Trash',
  '$RECYCLE.BIN',
  'System Volume Information',
]);

/**
 * True when `dir` looks like a git directory (bare repo or a `.git` folder):
 * it must contain HEAD, objects/ and refs/.
 * @param {string} dir
 * @returns {boolean}
 */
function isGitDir(dir) {
  try {
    return (
      fs.statSync(path.join(dir, 'HEAD')).isFile() &&
      fs.statSync(path.join(dir, 'objects')).isDirectory() &&
      fs.statSync(path.join(dir, 'refs')).isDirectory()
    );
  } catch {
    return false;
  }
}

/**
 * If `dir` is a work tree (contains a `.git` dir or a `.git` file pointing at
 * a real git dir), return the resolved absolute git directory, else null.
 * @param {string} dir
 * @returns {string|null}
 */
function resolveWorkTreeGitDir(dir) {
  const dotGit = path.join(dir, '.git');
  let stat;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) {
    return isGitDir(dotGit) ? dotGit : null;
  }
  if (stat.isFile()) {
    // gitfile: "gitdir: /path/to/real/gitdir"
    try {
      const contents = fs.readFileSync(dotGit, 'utf8').trim();
      const match = contents.match(/^gitdir:\s*(.+)$/i);
      if (!match) return null;
      const resolved = path.resolve(dir, match[1].trim());
      return isGitDir(resolved) ? resolved : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Pick a public name for a repository, preferring the path relative to the
 * scan root and falling back to the basename.
 * @param {string} root
 * @param {string} repoPath bare repo dir, or work tree dir
 * @returns {string}
 */
function toPublicName(root, repoPath) {
  const rel = path.relative(root, repoPath);
  const name = !rel ? path.basename(repoPath) : rel;
  return name.split(path.sep).join('/');
}

/**
 * The alternate spelling of a repo name (with/without the `.git` suffix).
 * @param {string} name
 * @returns {string}
 */
function aliasFor(name) {
  return name.endsWith('.git') ? name.slice(0, -4) : `${name}.git`;
}

/**
 * Recursively discover git repositories below `root`.
 *
 * Both bare repositories (`project.git/` or any git dir) and work trees
 * (`project/.git`) are discovered. Scanning stops descending once a repo is
 * found and never enters ignored directories.
 *
 * @param {string} root absolute path to scan
 * @param {{depth?: number}} [options]
 * @returns {{repos: Array<object>, warnings: string[], root: string}}
 */
function discover(root, options = {}) {
  const depth = Number.isFinite(options.depth) ? options.depth : 3;
  const warnings = [];
  /** @type {Map<string, object>} primary key -> repo */
  const repos = new Map();

  const register = (repo) => {
    const keys = [repo.name];
    const alias = aliasFor(repo.name);
    if (alias !== repo.name) keys.push(alias);
    // Also allow referring to a nested repo by its basename when unambiguous.
    const base = repo.name.split('/').pop();
    if (base && !keys.includes(base)) keys.push(base);

    for (const key of keys) {
      if (repos.has(key)) {
        if (repos.get(key).gitDir !== repo.gitDir) {
          warnings.push(
            `Name collision for "${key}", keeping ${path.relative(root, repos.get(key).gitDir)}`,
          );
        }
        continue;
      }
      repos.set(key, repo);
    }
  };

  const makeRepo = (repoPath, gitDir, bare) => ({
    name: toPublicName(root, repoPath),
    alias: aliasFor(toPublicName(root, repoPath)),
    path: repoPath,
    gitDir,
    bare,
    relGitDir: path.relative(root, gitDir).split(path.sep).join('/'),
  });

  const visit = (dir, level) => {
    // A git directory itself (bare repo, or a stray .git directory).
    if (isGitDir(dir)) {
      // If the parent is a work tree we will have handled it from the parent.
      if (!(path.basename(dir) === '.git' && resolveWorkTreeGitDir(path.dirname(dir)))) {
        register(makeRepo(dir, dir, true));
        return;
      }
    }

    const workGitDir = resolveWorkTreeGitDir(dir);
    if (workGitDir) {
      register(makeRepo(dir, workGitDir, false));
      return;
    }

    if (level >= depth) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      warnings.push(`Could not read ${dir}: ${error.message}`);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.')) continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      // Follow symlinks only if they resolve to a directory.
      try {
        if (!fs.statSync(child).isDirectory()) continue;
      } catch {
        continue;
      }
      visit(child, level + 1);
    }
  };

  visit(root, 0);

  const list = [];
  const seenGitDirs = new Set();
  for (const repo of repos.values()) {
    if (seenGitDirs.has(repo.gitDir)) continue;
    seenGitDirs.add(repo.gitDir);
    list.push(repo);
  }
  list.sort((a, b) => a.name.localeCompare(b.name));

  return { repos: list, warnings, root };
}

/**
 * Build a lookup that resolves a URL path segment (or joined segments) to a
 * repo. Supports the primary name, the `.git` alias and the basename.
 * @param {Array<object>} repos
 * @returns {Map<string, object>}
 */
function buildIndex(repos) {
  const index = new Map();
  for (const repo of repos) {
    const keys = [repo.name, repo.alias, repo.name.split('/').pop()];
    for (const key of keys) {
      if (key && !index.has(key)) index.set(key, repo);
    }
  }
  return index;
}

module.exports = {
  IGNORED_DIRS,
  isGitDir,
  resolveWorkTreeGitDir,
  toPublicName,
  aliasFor,
  discover,
  buildIndex,
};
