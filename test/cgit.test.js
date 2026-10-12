'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createServer } = require('../src/server');
const configStore = require('../src/config');
const cgit = require('../src/cgit');

function tmpdir(prefix = 'localgit-cgit-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function baseConfig(dir, overrides = {}) {
  return {
    dir,
    host: '127.0.0.1',
    port: 0,
    allowPush: true,
    web: true,
    webInterface: 'builtin',
    scanDepth: 3,
    ...overrides,
  };
}

function fakeCgi(dir, body) {
  const file = path.join(dir, 'fake-cgit');
  fs.writeFileSync(
    file,
    `#!/bin/sh\n${body}\n`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

async function startServer(t, config, options) {
  const { server, registry, close } = createServer(config, { ttl: 0, ...options });
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

test('config normalize defaults to the built-in interface and accepts cgit', () => {
  assert.equal(configStore.normalize({}).webInterface, 'builtin');
  assert.equal(configStore.normalize({ webInterface: 'cgit' }).webInterface, 'cgit');
  assert.equal(configStore.normalize({ webInterface: 'CGIT' }).webInterface, 'cgit');
  assert.equal(configStore.normalize({ webInterface: 'whatever' }).webInterface, 'builtin');
  assert.equal(configStore.DEFAULTS.webInterface, 'builtin');
});

test('renderCgitrc creates a self-contained cgitrc for the served repository set', () => {
  const repos = [
    { name: 'demo.git', gitDir: '/media/usb/git/demo.git' },
    { name: 'plain', gitDir: '/media/usb/git/plain/.git' },
  ];
  const rc = cgit.renderCgitrc({ repos });
  assert.match(rc, /^virtual-root=\//m);
  assert.match(rc, /^repo\.url=demo\.git\nrepo\.path=\/media\/usb\/git\/demo\.git/m);
  assert.match(rc, /^repo\.url=plain\nrepo\.path=\/media\/usb\/git\/plain\/\.git/m);
  assert.match(rc, /^cache-size=0/m);
  // With an asset dir cgit's files are referenced under the web root …
  const withAssets = cgit.renderCgitrc({ assetDir: '/usr/share/cgit', repos });
  assert.match(withAssets, /^css=\/cgit\.css/m);
  // … and without one the resource links are blanked out.
  const without = cgit.renderCgitrc({ assetDir: null, repos });
  assert.match(without, /^css=$/m);
});

test('findBinary resolves an explicit path and a bare name on PATH', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'cgit-stub'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(dir, 'cgit-stub'), 0o755);

  assert.equal(cgit.findBinary(path.join(dir, 'cgit-stub')), path.join(dir, 'cgit-stub'));

  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}:/usr/bin:/bin`;
  try {
    assert.equal(cgit.findBinary('cgit-stub'), path.join(dir, 'cgit-stub'));
  } finally {
    process.env.PATH = savedPath;
  }

  // Explicit configuration is strict: a bad path never falls back to another
  // cgit, while an existing one is used verbatim.
  assert.equal(cgit.locateExplicit(path.join(dir, 'missing-cgit')), null);
  assert.equal(cgit.locateExplicit(path.join(dir, 'cgit-stub')), path.join(dir, 'cgit-stub'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cgit interface proxies requests to the CGI program', { timeout: 30000 }, async (t) => {
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(['init', '--bare', '-q', path.join(root, 'demo.git')]);
  git(['--git-dir', path.join(root, 'demo.git'), 'symbolic-ref', 'HEAD', 'refs/heads/main']);

  // A fake CGI that echoes the CGI environment localgit hands it.
  const script = fakeCgi(
    root,
    `
printf 'Content-Type: text/plain\\n\\n'
printf 'method=%s\\n' "$REQUEST_METHOD"
printf 'path=%s\\n' "$PATH_INFO"
printf 'query=%s\\n' "$QUERY_STRING"
printf 'root=%s\\n' "$CGIT_CONFIG"
`,
  );
  const { base } = await startServer(
    t,
    baseConfig(root, { webInterface: 'cgit' }),
    { cgit: { command: script } },
  );

  const home = await fetch(`${base}/?q=search`);
  assert.equal(home.status, 200);
  const body = await home.text();
  assert.match(body, /method=GET/);
  assert.match(body, /path=\//);
  assert.match(body, /query=q=search/);
  assert.match(body, /root=.*cgitrc/);

  const tree = await fetch(`${base}/demo.git/tree/?h=main`);
  assert.match(await tree.text(), /path=\/demo\.git\/tree\//);

  // Git endpoints are still served by git http-backend, not passed to cgit.
  const refs = await fetch(`${base}/demo.git/info/refs?service=git-upload-pack`);
  assert.equal(refs.status, 200);
  assert.equal(refs.headers.get('content-type'), 'application/x-git-upload-pack-advertisement');
});

test('cgit interface serves static assets from the asset directory', { timeout: 30000 }, async (t) => {
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(['init', '--bare', '-q', path.join(root, 'demo.git')]);

  const assets = path.join(root, 'assets');
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(assets, 'cgit.css'), 'body { color: red; }\n');

  const { base } = await startServer(
    t,
    baseConfig(root, { webInterface: 'cgit' }),
    {
      cgit: {
        command: fakeCgi(root, `printf 'Content-Type: text/plain\\n\\n'`),
        assetDir: assets,
      },
    },
  );

  const css = await fetch(`${base}/cgit.css`);
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.match(await css.text(), /color: red/);

  // Unknown asset requests fall through to the normal router (404 here).
  assert.equal((await fetch(`${base}/nope.css`)).status, 404);
});

test('interactive setup asks for and honors the cgit web interface', async () => {
  const { gatherAnswers } = require('../src/cli');
  const answers = ['', '', '', '', '', '2', ''];
  const rl = {
    async question() {
      const next = answers.shift();
      return next === undefined ? '' : next;
    },
  };
  const cfg = await gatherAnswers(rl, {});
  assert.equal(cfg.webInterface, 'cgit');
  assert.equal(cfg.web, true);
  assert.equal(cfg.allowPush, true);
  assert.equal(cfg.port, 4000);
  assert.equal(cfg.scanDepth, 3);

  // The built-in interface stays the default.
  const rl2 = {
    async question() {
      return '';
    },
  };
  const cfg2 = await gatherAnswers(rl2, {});
  assert.equal(cfg2.webInterface, 'builtin');

  // When the browser is disabled, no interface question is asked.
  const rl3 = {
    async question() {
      return '';
    },
    /** the confirm() for "Enable the web repository browser" */
  };
  const cfg3 = await gatherAnswers(rl3, { web: false });
  assert.equal(cfg3.web, false);
  assert.equal(cfg3.webInterface, 'builtin');
});

test('createServer fails clearly when cgit is enabled but missing', () => {
  assert.throws(
    () =>
      createServer(baseConfig(tmpdir(), { webInterface: 'cgit' }), {
        cgit: { command: '/nonexistent/cgit' },
      }),
    /no cgit executable was found/,
  );
});

test('cgit interface renders real cgit pages when cgit is installed', { timeout: 60000 }, async (t) => {
  const located = cgit.locate();
  if (!located) {
    t.skip('cgit binary not available on this system');
    return;
  }
  const root = tmpdir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(['init', '--bare', '-q', path.join(root, 'demo.git')]);
  git(['--git-dir', path.join(root, 'demo.git'), 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(['init', '-q', path.join(root, 'plain')]);
  git(['-C', path.join(root, 'plain'), 'config', 'user.email', 't@e.st']);
  git(['-C', path.join(root, 'plain'), 'config', 'user.name', 'T']);
  fs.writeFileSync(path.join(root, 'plain', 'hello.txt'), 'hello\n');
  git(['-C', path.join(root, 'plain'), 'add', '.']);
  git(['-C', path.join(root, 'plain'), 'commit', '-qm', 'first']);
  git(['-C', path.join(root, 'plain'), 'branch', '-M', 'main']);

  const { base } = await startServer(t, baseConfig(root, { webInterface: 'cgit' }));

  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  const homeText = await home.text();
  assert.match(homeText, /cgit/);
  assert.match(homeText, /demo\.git/);
  // Work trees keep their localgit name (not cgit's "plain/.git").
  assert.match(homeText, /href='\/plain\/'>/);

  const repo = await fetch(`${base}/demo.git/`);
  assert.equal(repo.status, 200);
  assert.match(await repo.text(), /summary/);

  const work = await fetch(`${base}/plain/tree/`);
  assert.equal(work.status, 200);
  assert.match(await work.text(), /hello\.txt/);

  // Static assets are served when the asset directory is discoverable.
  if (located.assetDir) {
    const css = await fetch(`${base}/cgit.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
  }

  // Smart HTTP still works next to cgit.
  const refs = await fetch(`${base}/demo.git/info/refs?service=git-upload-pack`);
  assert.equal(refs.status, 200);
  assert.equal(refs.headers.get('content-type'), 'application/x-git-upload-pack-advertisement');
});