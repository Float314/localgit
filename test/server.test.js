'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { createServer } = require('../src/server');

const execFileP = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

/**
 * Run git asynchronously so the in-process HTTP server can keep responding
 * while git talks to it (execFileSync would deadlock).
 */
async function git(args, opts = {}) {
  const { stdout } = await execFileP('git', args, {
    encoding: 'utf8',
    env: GIT_ENV,
    ...opts,
  });
  return stdout;
}

function tmpdir(prefix = 'localgit-server-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function baseConfig(dir, overrides = {}) {
  return {
    dir,
    host: '127.0.0.1',
    port: 0,
    allowPush: true,
    web: true,
    scanDepth: 3,
    ...overrides,
  };
}

async function startServer(t, config) {
  const { server, registry, close } = createServer(config, { ttl: 0 });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  t.after(async () => {
    server.closeAllConnections?.();
    await close();
  });
  return { base: `http://127.0.0.1:${port}`, registry };
}

async function commitFile(workdir, file, contents, message) {
  await git(['-C', workdir, 'config', 'user.email', 'tester@example.com']);
  await git(['-C', workdir, 'config', 'user.name', 'Tester']);
  const full = path.join(workdir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  await git(['-C', workdir, 'add', '.']);
  await git(['-C', workdir, 'commit', '-qm', message]);
}

test('serves the web UI and supports clone + push + pull', { timeout: 30000 }, async (t) => {
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await git(['init', '--bare', '-q', path.join(root, 'demo.git')]);
  await git(['--git-dir', path.join(root, 'demo.git'), 'symbolic-ref', 'HEAD', 'refs/heads/main']);

  const { base } = await startServer(t, baseConfig(root));

  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /demo\.git/);

  // Clone the empty repository and push a commit.
  const parent = tmpdir();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const work = path.join(parent, 'work');
  await git(['clone', '-q', `${base}/demo.git`, work]);
  await commitFile(work, 'HELLO.md', '# hi\n', 'first commit');
  await git(['-C', work, 'push', '-q', 'origin', 'HEAD:refs/heads/main']);

  // Server-side state updated.
  assert.match(
    await git(['--git-dir', path.join(root, 'demo.git'), 'log', '--oneline']),
    /first commit/,
  );

  // Smart HTTP advertisement for fetch.
  const refs = await fetch(`${base}/demo.git/info/refs?service=git-upload-pack`);
  assert.equal(refs.status, 200);
  assert.equal(refs.headers.get('content-type'), 'application/x-git-upload-pack-advertisement');

  // Alias without the .git suffix resolves too.
  const alias = await fetch(`${base}/demo/info/refs?service=git-upload-pack`);
  assert.equal(alias.status, 200);

  // Web pages.
  const tree = await fetch(`${base}/demo.git/tree/?ref=main`);
  assert.equal(tree.status, 200);
  assert.match(await tree.text(), /HELLO\.md/);

  const blob = await fetch(`${base}/demo.git/blob/?ref=main&path=HELLO.md`);
  assert.equal(blob.status, 200);
  assert.match(await blob.text(), /# hi/);

  const raw = await fetch(`${base}/demo.git/raw/?ref=main&path=HELLO.md`);
  assert.equal(raw.status, 200);
  assert.equal(await raw.text(), '# hi\n');

  // A fresh clone sees the pushed commit.
  const clone2 = path.join(parent, 'clone2');
  await git(['clone', '-q', `${base}/demo.git`, clone2]);
  assert.match(fs.readFileSync(path.join(clone2, 'HELLO.md'), 'utf8'), /# hi/);

  // Unknown repositories 404.
  assert.equal((await fetch(`${base}/missing.git`)).status, 404);
});

test('rejects pushes when push is disabled', { timeout: 30000 }, async (t) => {
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await git(['init', '--bare', '-q', path.join(root, 'demo.git')]);
  const { base } = await startServer(t, baseConfig(root, { allowPush: false }));

  const adv = await fetch(`${base}/demo.git/info/refs?service=git-receive-pack`);
  assert.equal(adv.status, 403);

  const parent = tmpdir();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const work = path.join(parent, 'work');
  await git(['clone', '-q', `${base}/demo.git`, work]);
  await commitFile(work, 'a.txt', 'a\n', 'commit');
  await assert.rejects(git(['-C', work, 'push', '-q', 'origin', 'HEAD:refs/heads/main']));
});

test('pushing to a worktree updates its working tree', { timeout: 30000 }, async (t) => {
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plain = path.join(root, 'plain');
  await git(['init', '-q', plain]);
  await commitFile(plain, 'hello.txt', 'hello\n', 'init');
  await git(['-C', plain, 'branch', '-M', 'main']);

  const { base } = await startServer(t, baseConfig(root));

  const parent = tmpdir();
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const work = path.join(parent, 'work');
  await git(['clone', '-q', `${base}/plain`, work]);
  await commitFile(work, 'from-remote.txt', 'remote\n', 'remote commit');
  await git(['-C', work, 'push', '-q', 'origin', 'HEAD:refs/heads/main']);

  assert.match(fs.readFileSync(path.join(plain, 'from-remote.txt'), 'utf8'), /remote/);
});

test('web browser can be disabled', { timeout: 30000 }, async (t) => {
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await git(['init', '--bare', '-q', path.join(root, 'demo.git')]);
  const { base } = await startServer(t, baseConfig(root, { web: false }));

  assert.equal((await fetch(`${base}/`)).status, 404);
  // git endpoints still work
  assert.equal((await fetch(`${base}/demo.git/info/refs?service=git-upload-pack`)).status, 200);
});