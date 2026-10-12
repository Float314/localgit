'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { escapeHtml } = require('./util');
const { git, gitBuffer, log, refs, currentBranch, revParse } = require('./git');

const MAX_BLOB_BYTES = 1024 * 1024; // 1 MiB preview limit
const README_NAMES = ['README.md', 'README.markdown', 'README.rst', 'README.txt', 'README'];

/**
 * Escape/encode a value for use inside a query string.
 * @param {string} value
 */
const q = (value) => encodeURIComponent(value == null ? '' : String(value));

/**
 * Build the href prefix (origin + repo name) shared by every page.
 * @param {string} base
 * @param {{name:string}} repo
 */
function repoBase(base, repo) {
  return `${base}/${repo.name}`;
}

/**
 * @param {string} gitDir
 * @param {string|undefined} ref
 * @returns {Promise<string>}
 */
async function resolveRef(gitDir, ref) {
  if (ref && ref.trim()) return ref.trim();
  const head = await currentBranch(gitDir);
  return head || 'HEAD';
}

/**
 * @param {string} gitDir
 * @param {string} ref
 * @param {string} dirPath
 * @returns {Promise<Array<{mode:string,type:string,hash:string,size:string,name:string}>>}
 */
async function listTree(gitDir, ref, dirPath = '') {
  const treeish = dirPath ? `${ref}:${dirPath}` : ref;
  const out = await git(['-C', gitDir, 'ls-tree', '-l', '-z', treeish], {
    rejectOnError: false,
  });
  return out
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf('\t');
      const meta = entry.slice(0, tab).trim().split(/\s+/);
      const name = entry.slice(tab + 1);
      const [mode, type, hash, size] = meta;
      return { mode, type, hash, size: size || '', name };
    });
}

/**
 * @param {string} gitDir
 * @param {string} ref
 * @param {string} filePath
 * @returns {Promise<Buffer|null>}
 */
async function readBlob(gitDir, ref, filePath) {
  try {
    return await gitBuffer(['-C', gitDir, 'show', `${ref}:${filePath}`], {
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * @param {string} gitDir
 * @returns {Promise<string>}
 */
async function readDescription(gitDir) {
  // Prefer an explicit description file, then gitweb.description config.
  try {
    const file = fs.readFileSync(path.join(gitDir, 'description'), 'utf8').trim();
    if (file && !file.startsWith('Unnamed repository')) return file;
  } catch {
    /* ignore */
  }
  const conf = await git(['-C', gitDir, 'config', '--get', 'gitweb.description'], {
    rejectOnError: false,
  });
  return conf.trim();
}

/**
 * @param {string} gitDir
 * @param {string} ref
 * @returns {Promise<string>}
 */
async function readReadme(gitDir, ref) {
  for (const name of README_NAMES) {
    const content = await readBlob(gitDir, ref, name);
    if (content) return content.toString('utf8');
  }
  return '';
}

/**
 * Gather the summary data shown on the home and repository pages.
 * @param {object} repo
 * @returns {Promise<object>}
 */
async function repoSummary(repo) {
  const [defaultBranch, commits, branches, tags, description] = await Promise.all([
    currentBranch(repo.gitDir),
    log(repo.gitDir, 'HEAD', 1),
    refs(repo.gitDir, 'refs/heads'),
    refs(repo.gitDir, 'refs/tags'),
    readDescription(repo.gitDir),
  ]);
  return {
    ...repo,
    defaultBranch: defaultBranch || (commits[0] ? '(detached)' : '(empty)'),
    description,
    lastCommit: commits[0] || null,
    branchCount: branches.length,
    tagCount: tags.length,
    branches,
    tags,
  };
}

/**
 * @param {string} title
 * @param {string} body
 * @param {{base:string, active?:string}} opts
 */
function layout(title, body, { base, active }) {
  const nav = [
    ['Repositories', base + '/'],
    ['Branches', active ? `${base}/${active}/` : null],
  ]
    .filter(([, href]) => href)
    .map(([label, href]) => `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`)
    .join(' <span class="sep">/</span> ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f6f7f9; color: #1c1e21; }
  header { background: #24292f; color: #fff; padding: 14px 20px; }
  header a { color: #fff; text-decoration: none; font-weight: 600; }
  header .sep { color: #8b949e; }
  main { max-width: 960px; margin: 0 auto; padding: 24px 20px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 28px 0 10px; border-bottom: 1px solid #d0d7de; padding-bottom: 6px; }
  a { color: #0969da; }
  code, pre, .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
  pre { background: #fff; border: 1px solid #d0d7de; border-radius: 6px; padding: 12px; overflow: auto; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d0d7de; border-radius: 6px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #eaeef2; vertical-align: top; }
  th { background: #f6f8fa; font-size: 13px; color: #57606a; }
  tr:last-child td { border-bottom: 0; }
  .muted { color: #57606a; }
  .empty { color: #57606a; font-style: italic; }
  .badge { display: inline-block; font-size: 12px; background: #ddf4ff; color: #0969da; border-radius: 999px; padding: 1px 8px; margin-left: 6px; }
  .clone { background: #fff; border: 1px solid #d0d7de; border-radius: 6px; padding: 10px 12px; display: flex; gap: 8px; align-items: center; }
  .clone input { flex: 1; border: 0; background: transparent; font-family: ui-monospace, monospace; font-size: 13px; color: inherit; width: 100%; }
  .toolbar { margin: 12px 0; }
  input[type=text] { padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 6px; width: 100%; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #e6edf3; }
    a { color: #4493f8; }
    h2 { border-color: #30363d; }
    pre, table, .clone { background: #161b22; border-color: #30363d; }
    th { background: #161b22; color: #8b949e; }
    th, td { border-color: #30363d; }
    .muted, .empty { color: #8b949e; }
    input[type=text] { background: #0d1117; border-color: #30363d; color: #e6edf3; }
  }
</style>
</head>
<body>
<header>${nav || '<strong>localgit</strong>'}</header>
<main>
${body}
</main>
</body>
</html>`;
}

/**
 * @param {{repos:Array<object>, base:string, config:object, dir:string}} ctx
 */
async function renderHome(ctx) {
  const { repos, base, config, dir } = ctx;
  const rows = await Promise.all(repos.map((repo) => repoSummary(repo)));

  const body = `
    <h1>localgit</h1>
    <p class="muted">Serving git repositories from <span class="mono">${escapeHtml(dir)}</span>
      &middot; ${rows.length} repositor${rows.length === 1 ? 'y' : 'ies'}
      &middot; push ${config.allowPush ? 'enabled' : 'disabled'}</p>
    ${
      rows.length === 0
        ? `<p class="empty">No repositories found. Create one with <code>git init --bare ${escapeHtml(
            path.join(dir, 'myproject.git'),
          )}</code> and refresh.</p>`
        : `<table>
      <thead><tr><th>Repository</th><th>Description</th><th>Last commit</th></tr></thead>
      <tbody>
      ${rows
        .map((r) => {
          const url = `${base}/${r.name}`;
          const last = r.lastCommit
            ? `${escapeHtml(r.lastCommit.subject)} <span class="muted">&middot; ${escapeHtml(
                r.lastCommit.relative,
              )}</span>`
            : '<span class="empty">empty</span>';
          return `<tr>
            <td><a href="${escapeHtml(url)}"><strong>${escapeHtml(r.name)}</strong></a>${
              r.bare ? '<span class="badge">bare</span>' : ''
            }<div class="muted mono" style="font-size:12px">${escapeHtml(url)}</div></td>
            <td>${escapeHtml(r.description || '') || '<span class="muted">—</span>'}</td>
            <td>${last}</td>
          </tr>`;
        })
        .join('')}
      </tbody></table>`
    }
  `;
  return layout('localgit', body, { base });
}

/**
 * @param {{repo:object, base:string}} ctx
 */
async function renderRepo(ctx) {
  const { repo, base } = ctx;
  const summary = await repoSummary(repo);
  const url = `${base}/${repo.name}`;
  const ref = summary.defaultBranch;
  const commits = await log(repo.gitDir, 'HEAD', 15);
  const readme = await readReadme(repo.gitDir, 'HEAD');

  const body = `
    <h1>${escapeHtml(repo.name)}${repo.bare ? '<span class="badge">bare</span>' : ''}</h1>
    <p class="muted">${escapeHtml(summary.description || 'No description')}</p>

    <div class="toolbar">
      <div class="clone">
        <input readonly value="git clone ${escapeHtml(url)}" onclick="this.select()">
      </div>
    </div>

    <p>
      <a href="${escapeHtml(`${url}/tree/?ref=${q(ref)}`)}">Browse files</a>
      &middot; <a href="${escapeHtml(`${url}/log/?ref=${q(ref)}`)}">Commits</a>
      &middot; <a href="${escapeHtml(`${url}/branches/`)}">Branches (${summary.branchCount})</a>
      &middot; <a href="${escapeHtml(`${url}/tags/`)}">Tags (${summary.tagCount})</a>
    </p>

    ${
      commits.length
        ? `<h2>Recent commits</h2>
        <table>
          <thead><tr><th>Commit</th><th>Message</th><th>Author</th><th>When</th></tr></thead>
          <tbody>${commits
            .map(
              (c) => `<tr>
              <td class="mono"><a href="${escapeHtml(
                `${url}/commit/?id=${q(c.hash)}`,
              )}">${escapeHtml(c.short)}</a></td>
              <td>${escapeHtml(c.subject)}</td>
              <td>${escapeHtml(c.author)}</td>
              <td class="muted">${escapeHtml(c.relative)}</td>
            </tr>`,
            )
            .join('')}</tbody>
        </table>`
        : '<p class="empty">This repository has no commits yet.</p>'
    }

    ${readme ? `<h2>README</h2><pre>${escapeHtml(readme)}</pre>` : ''}
  `;
  return layout(repo.name, body, { base, active: repo.name });
}

/**
 * @param {{repo:object, base:string, ref:string, path:string}} ctx
 */
async function renderTree(ctx) {
  const { repo, base, path: dirPath } = ctx;
  const url = `${base}/${repo.name}`;
  const ref = await resolveRef(repo.gitDir, ctx.ref);
  const entries = await listTree(repo.gitDir, ref, dirPath);

  const crumbs = buildCrumbs(url, ref, dirPath);
  const sorted = entries.slice().sort((a, b) => {
    const dirA = a.type === 'tree' ? 0 : 1;
    const dirB = b.type === 'tree' ? 0 : 1;
    return dirA - dirB || a.name.localeCompare(b.name);
  });

  const body = `
    <h1>${escapeHtml(repo.name)}</h1>
    <p class="muted mono">${crumbs}</p>
    <p class="muted">Browsing <strong>${escapeHtml(ref)}</strong></p>
    <table>
      <thead><tr><th>Name</th><th>Size</th></tr></thead>
      <tbody>
      ${
        dirPath
          ? `<tr><td><a href="${escapeHtml(
              `${url}/tree/?ref=${q(ref)}&path=${q(parentPath(dirPath))}`,
            )}">../</a></td><td></td></tr>`
          : ''
      }
      ${sorted
        .map((entry) => {
          const childPath = dirPath ? `${dirPath}/${entry.name}` : entry.name;
          if (entry.type === 'tree') {
            return `<tr><td><a href="${escapeHtml(
              `${url}/tree/?ref=${q(ref)}&path=${q(childPath)}`,
            )}">${escapeHtml(entry.name)}/</a></td><td class="muted">—</td></tr>`;
          }
          return `<tr><td><a href="${escapeHtml(
            `${url}/blob/?ref=${q(ref)}&path=${q(childPath)}`,
          )}">${escapeHtml(entry.name)}</a></td><td class="muted">${escapeHtml(
            formatSize(entry.size),
          )}</td></tr>`;
        })
        .join('')}
      ${
        sorted.length === 0
          ? '<tr><td colspan="2" class="empty">Empty directory</td></tr>'
          : ''
      }
      </tbody>
    </table>
  `;
  return layout(`${repo.name}/${dirPath || ''} @ ${ref}`, body, { base, active: repo.name });
}

/**
 * @param {{repo:object, base:string, ref:string, path:string}} ctx
 * @returns {Promise<{html?:string, raw?:Buffer, contentType?:string, notFound?:boolean, tooLarge?:boolean}>}
 */
async function renderBlob(ctx) {
  const { repo, base, path: filePath } = ctx;
  const url = `${base}/${repo.name}`;
  const ref = await resolveRef(repo.gitDir, ctx.ref);
  const content = await readBlob(repo.gitDir, ref, filePath);
  if (!content) return { notFound: true };

  const rawHref = `${url}/raw/?ref=${q(ref)}&path=${q(filePath)}`;
  const crumbs = buildCrumbs(url, ref, filePath);
  const isBinary = content.includes(0);
  const tooLarge = content.length > MAX_BLOB_BYTES;

  let viewer;
  if (isBinary) {
    viewer = `<p class="empty">Binary file (${formatSize(String(content.length))}) —
      <a href="${escapeHtml(rawHref)}">download raw</a></p>`;
  } else if (tooLarge) {
    viewer = `<p class="empty">File is too large to display (${formatSize(
      String(content.length),
    )}) — <a href="${escapeHtml(rawHref)}">download raw</a></p>`;
  } else {
    viewer = `<pre>${escapeHtml(content.toString('utf8'))}</pre>`;
  }

  const body = `
    <h1>${escapeHtml(repo.name)}</h1>
    <p class="muted mono">${crumbs}</p>
    <p class="muted"><strong>${escapeHtml(ref)}</strong>
      &middot; ${formatSize(String(content.length))}
      &middot; <a href="${escapeHtml(rawHref)}">raw</a></p>
    ${viewer}
  `;
  return { html: layout(`${repo.name}/${filePath}`, body, { base, active: repo.name }) };
}

/**
 * @param {{repo:object, base:string, ref:string, id:string}} ctx
 */
async function renderCommit(ctx) {
  const { repo, base } = ctx;
  const url = `${base}/${repo.name}`;
  const hash = await revParse(repo.gitDir, ctx.id);
  if (!hash) return { notFound: true };

  const meta = await git(
    ['-C', repo.gitDir, 'show', '--no-patch', '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b', hash],
    { rejectOnError: false },
  );
  const [full, author, email, date, subject, body_] = meta.split('\x1f');
  const patch = await git(['-C', repo.gitDir, 'show', '--no-color', '--patch', '--stat', hash], {
    maxBuffer: 32 * 1024 * 1024,
    rejectOnError: false,
  });

  const html = `
    <h1>Commit ${escapeHtml(hash.slice(0, 12))}</h1>
    <p class="muted">${escapeHtml(subject || '')}</p>
    <table>
      <tbody>
        <tr><th>Commit</th><td class="mono">${escapeHtml(full || hash)}</td></tr>
        <tr><th>Author</th><td>${escapeHtml(author || '')} &lt;${escapeHtml(email || '')}&gt;</td></tr>
        <tr><th>Date</th><td>${escapeHtml(date || '')}</td></tr>
      </tbody>
    </table>
    ${body_ && body_.trim() ? `<h2>Message</h2><pre>${escapeHtml(body_.trim())}</pre>` : ''}
    <h2>Changes</h2>
    <pre>${escapeHtml(patch)}</pre>
  `;
  return { html: layout(`commit ${hash.slice(0, 12)}`, html, { base, active: repo.name }) };
}

/**
 * @param {{repo:object, base:string, ref:string}} ctx
 */
async function renderLog(ctx) {
  const { repo, base } = ctx;
  const url = `${base}/${repo.name}`;
  const ref = await resolveRef(repo.gitDir, ctx.ref);
  const commits = await log(repo.gitDir, ref, 50);

  const body = `
    <h1>${escapeHtml(repo.name)}</h1>
    <p class="muted">Commits on <strong>${escapeHtml(ref)}</strong></p>
    <table>
      <thead><tr><th>Commit</th><th>Message</th><th>Author</th><th>When</th></tr></thead>
      <tbody>
      ${commits
        .map(
          (c) => `<tr>
          <td class="mono"><a href="${escapeHtml(
            `${url}/commit/?id=${q(c.hash)}`,
          )}">${escapeHtml(c.short)}</a></td>
          <td>${escapeHtml(c.subject)}</td>
          <td>${escapeHtml(c.author)}</td>
          <td class="muted">${escapeHtml(c.relative)}</td>
        </tr>`,
        )
        .join('')}
      </tbody>
    </table>
  `;
  return layout(`${repo.name} log`, body, { base, active: repo.name });
}

/**
 * @param {{repo:object, base:string, kind:'branches'|'tags'}} ctx
 */
async function renderRefs(ctx) {
  const { repo, base, kind } = ctx;
  const url = `${base}/${repo.name}`;
  const namespace = kind === 'tags' ? 'refs/tags' : 'refs/heads';
  const items = await refs(repo.gitDir, namespace);
  const ref = await currentBranch(repo.gitDir);

  const body = `
    <h1>${escapeHtml(repo.name)} — ${kind}</h1>
    <table>
      <thead><tr><th>${kind === 'tags' ? 'Tag' : 'Branch'}</th><th>Commit</th><th>Message</th><th>When</th></tr></thead>
      <tbody>
      ${items
        .map(
          (item) => `<tr>
          <td class="mono">${escapeHtml(item.short)}${
            kind === 'branches' && item.short === ref ? '<span class="badge">HEAD</span>' : ''
          }</td>
          <td class="mono"><a href="${escapeHtml(
            `${url}/log/?ref=${q(item.short)}`,
          )}">${escapeHtml(item.hash)}</a></td>
          <td>${escapeHtml(item.subject)}</td>
          <td class="muted">${escapeHtml(item.relative)}</td>
        </tr>`,
        )
        .join('')}
      ${items.length === 0 ? '<tr><td colspan="4" class="empty">None</td></tr>' : ''}
      </tbody>
    </table>
  `;
  return layout(`${repo.name} — ${kind}`, body, { base, active: repo.name });
}

/**
 * @param {string} url
 * @param {string} ref
 * @param {string} filePath
 */
function buildCrumbs(url, ref, filePath) {
  const parts = filePath ? filePath.split('/') : [];
  const links = [`<a href="${escapeHtml(`${url}/tree/?ref=${q(ref)}`)}">${escapeHtml(ref)}</a>`];
  let acc = '';
  parts.forEach((part, i) => {
    acc = acc ? `${acc}/${part}` : part;
    const isLast = i === parts.length - 1;
    if (isLast) links.push(escapeHtml(part));
    else
      links.push(
        `<a href="${escapeHtml(`${url}/tree/?ref=${q(ref)}&path=${q(acc)}`)}">${escapeHtml(part)}</a>`,
      );
  });
  return links.join(' / ');
}

/**
 * @param {string} p
 */
function parentPath(p) {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.slice(0, idx);
}

/**
 * @param {string} size
 */
function formatSize(size) {
  const n = Number(size);
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * @param {{base:string, message:string}} ctx
 */
function renderError({ base, message, status = 404 }) {
  const body = `<h1>${status}</h1><p class="muted">${escapeHtml(message)}</p>
    <p><a href="${escapeHtml(base ? `${base}/` : '/')}">Back to repositories</a></p>`;
  return layout(`${status}`, body, { base });
}

module.exports = {
  repoBase,
  resolveRef,
  listTree,
  readBlob,
  readReadme,
  repoSummary,
  renderHome,
  renderRepo,
  renderTree,
  renderBlob,
  renderCommit,
  renderLog,
  renderRefs,
  renderError,
  formatSize,
};
