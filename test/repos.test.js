'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { discover, isGitDir, buildIndex } = require('../src/repos');

function tmpdir(prefix = 'localgit-repos-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('isGitDir recognises bare repositories', () => {
  const root = tmpdir();
  const bare = path.join(root, 'x.git');
  git(['init', '--bare', '-q', bare]);
  assert.equal(isGitDir(bare), true);
  assert.equal(isGitDir(root), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('discover finds bare and worktree repos, skips ignored/hidden dirs', () => {
  const root = tmpdir();
  git(['init', '--bare', '-q', path.join(root, 'a.git')]);
  git(['init', '-q', path.join(root, 'work')]);

  // these must be ignored
  git(['init', '--bare', '-q', path.join(root, 'node_modules', 'dep.git')]);
  git(['init', '--bare', '-q', path.join(root, '.hidden.git')]);

  const { repos } = discover(root, { depth: 3 });
  const names = repos.map((r) => r.name).sort();
  assert.deepEqual(names, ['a.git', 'work']);

  const bare = repos.find((r) => r.name === 'a.git');
  assert.equal(bare.bare, true);
  assert.equal(bare.gitDir, path.join(root, 'a.git'));
  assert.equal(bare.relGitDir, 'a.git');

  const work = repos.find((r) => r.name === 'work');
  assert.equal(work.bare, false);
  assert.equal(work.gitDir, path.join(root, 'work', '.git'));
  assert.equal(work.relGitDir, path.join('work', '.git'));

  fs.rmSync(root, { recursive: true, force: true });
});

test('discover respects the scan depth', () => {
  const root = tmpdir();
  git(['init', '--bare', '-q', path.join(root, 'one', 'two', 'deep.git')]);

  assert.equal(discover(root, { depth: 1 }).repos.length, 0);
  assert.equal(discover(root, { depth: 3 }).repos.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('buildIndex resolves names, aliases and basenames', () => {
  const repos = [
    { name: 'a.git', alias: 'a', gitDir: '/a' },
    { name: 'team/b', alias: 'team/b.git', gitDir: '/b' },
  ];
  const index = buildIndex(repos);
  assert.equal(index.get('a.git').gitDir, '/a');
  assert.equal(index.get('a').gitDir, '/a');
  assert.equal(index.get('team/b').gitDir, '/b');
  assert.equal(index.get('team/b.git').gitDir, '/b');
  assert.equal(index.get('b').gitDir, '/b');
});
