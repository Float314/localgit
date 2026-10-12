# localgit

<img src="./other/assets/Screenshot From 2026-10-12 19-55-52.png" alt="localgit with cgit option">

<div align="center">

![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/Float314/localgit/node.js.yml)
![GitHub License](https://img.shields.io/github/license/Float314/localgit)
![GitHub top language](https://img.shields.io/github/languages/top/Float314/localgit)

</div>

Ever wanted to get a git repo in your USB device? Well, now you can! With the
help of this tool, you can set up your USB drive (or any folder) as a git
remote.

`localgit` turns any directory - a USB drive, an external disk, a CI cache
folder - into a **browsable git remote** over HTTP. Plug in your drive, run one
command, and clone/push/pull from `http://127.0.0.1:4000/...` immediately.

- **Browsable** - a lightweight web UI at `http://127.0.0.1:4000/` lists every
  repository and lets you browse trees, files, commits, branches and tags.
- **Push & pull** - real [smart HTTP] support via `git http-backend`, so
  `git clone`, `git push`, `git pull` and `git fetch` all work.
- **Zero dependencies** - built only on Node.js and the git that's already
  installed.
- **Nothing written to your drive** - repositories are served read-only as far
  as config goes; push settings are applied per-request with git's environment
  config (safe for read-only or freshly mounted drives).

Smart HTTP: https://git-scm.com/docs/gitprotocol-http

---

## Features

| Capability            | Description                                                                   |
| --------------------- | ----------------------------------------------------------------------------- |
| Web repository browser| List repos, view trees, files (with raw downloads), commits, logs, branches, tags, READMEs |
| Built-in or cgit UI   | Pick the dependency-free built-in browser or, if installed, the classic [cgit] interface |
| Smart HTTP clone/push | Uses git's own `git http-backend` CGI - no third-party server needed           |
| Bare and   work trees | Serves `project.git` and regular `project/` (with `.git`) repositories        |
| Push to work trees    | Uses `receive.denyCurrentBranch=updateInstead` so pushed commits appear in the working tree |
| Interactive setup     | First run asks *where your repositories live*, port, address, push & web preferences |
| Lightweight           | Pure Node.js http server, tiny dependency-free browser UI, ~tens of MB RAM    |

[cgit]: https://git.zx2c4.com/cgit/

## Requirements

- **Node.js >= 18**
- **git** on your `PATH` (with `git http-backend`, present in every standard git install)
- **cgit** (optional) - only needed when you choose the cgit web interface

No npm packages are installed at runtime.

## Install

```sh
npm install -g .          # or: npm link
localgit --help
```

Or run without installing:

```sh
node bin/localgit.js --help
```

## Usage

```sh
localgit
```

On first run `localgit` asks a few questions:

1. **Where are all your git repositories stored?** - the root folder that holds
   your repos (e.g. `/media/$USER/USB/git`). A bare repo is a folder like
   `myproject.git`; a work tree is a normal cloned folder containing `.git`.
2. **Which address should the server listen on?** - `127.0.0.1` (this computer
   only, the safe default) or `0.0.0.0` (so other devices on your network/USB
   context can reach it).
3. **Which port should the server use?** - defaults to `4000`.
4. **Allow git push?** - enable receive-pack (default yes).
5. **Enable the web browser?** - the repo browser at `/` (default yes).
6. **Which web interface?** - the dependency-free *built-in* browser (default)
   or *cgit* (if installed). cgit is the classic, feature-complete git browser;
   everything runs as CGI via `git http-backend` for clone/push and a small
   bridge that translates requests to the `cgit` binary.
7. **Scan depth** - how many folder levels deep to search for repos.

Then it starts the server and prints what it found:

```
✔ localgit is running

  Web UI     http://127.0.0.1:4000/
  Repos dir  /media/you/USB/git
  Push       enabled
  Web        enabled (cgit)

  3 repositories:
    http://127.0.0.1:4000/another.git
    http://127.0.0.1:4000/demo.git
    http://127.0.0.1:4000/plain

  Clone:      git clone http://127.0.0.1:4000/another.git
  Push:       git remote add usb http://127.0.0.1:4000/another.git && git push usb --all

  Press Ctrl+C to stop.
```

### Cloning and pushing

From any machine/app that can reach the server:

```sh
# clone a repository
git clone http://127.0.0.1:4000/demo.git

# or add an existing local repo as a remote and push
git remote add usb http://127.0.0.1:4000/demo.git
git push usb --all
git push usb main
```

URLs accept both `…/demo.git` and `…/demo` - either spelling works for
clone/push/pull/browse.

### Browsing

Open `http://127.0.0.1:4000/`:

- `.../:project` - summary: description, clone URL, recent commits, README
- `.../:project/tree/?ref=main&path=src/` - directory listing
- `.../:project/blob/?ref=main&path=src/index.js` - file view
- `.../:project/raw/?ref=main&path=src/index.js` - raw file
- `.../:project/log/?ref=main` - commit history
- `.../:project/commit/?id=<sha>` - commit details & diff
- `.../:project/branches/`, `…/:project/tags/` - refs

With the **cgit** interface (`--web-ui cgit`) the same `http://127.0.0.1:4000/`
address instead renders cgit's own pages (`/project/`, `/project/tree/`,
`/project/log/`, `/project/commit/`, …), with cgit's static assets served from
`/cgit.css`, `/cgit.js` and `/cgit.png`. The repo names are identical either
way; cloning and pushing use the same smart-HTTP endpoints.

## Commands & options

```
localgit [command] [options]

Commands
  serve            Start the HTTP git server (default)
  setup            Answer the setup questions and save a config
  list             List discovered repositories
  help             Show this help
  version          Print the version

Options
  -d, --dir <path>     Directory that holds your repositories
  -p, --port <n>       Port to listen on (default 4000)
  -H, --host <addr>    Address to bind (default 127.0.0.1)
      --depth <n>      Folder scan depth (default 3)
  -c, --config <file>  Use a specific config file
      --no-push        Disable git push
      --no-web         Disable the web browser
      --web-ui <name>  Web interface: builtin (default) or cgit
      --setup          Re-run the setup questions
      --yes            Accept defaults / no prompts
      --no-save        Do not write the config file
```

Environment variables:

- `CGIT_BINARY` - path to the cgit executable (otherwise probed on `PATH` and
  at the usual locations such as `/usr/lib/cgit/cgit.cgi`)
- `CGIT_ASSETS` - directory holding cgit's `cgit.css` / `cgit.js` / `cgit.png`
  (otherwise probed, e.g. `/usr/share/cgit`)

Examples:

```sh
# interactive first run, then serve
localgit

# serve a USB folder on a specific port
localgit serve --dir /media/you/USB/git --port 4000

# expose to your local network
localgit --dir /media/you/USB/git --host 0.0.0.0

# use the cgit web interface (must be installed)
localgit serve --dir /media/you/USB/git --web-ui cgit

# list what would be served
localgit list --dir /media/you/USB/git

# non-interactive (scripts / CI)
localgit serve --dir /media/you/USB/git --port 4000 --yes
```

## Configuration

Settings are stored as JSON at:

- **Linux:** `~/.config/localgit/config.json` (or `$XDG_CONFIG_HOME`)
- **macOS:** `~/Library/Application Support/localgit/config.json`
- **Windows:** `%APPDATA%\localgit\config.json`
- **Override:** set `LOCALGIT_CONFIG=/path/to/config.json` or pass `--config`

Example:

```json
{
  "dir": "/media/you/USB/git",
  "host": "127.0.0.1",
  "port": 4000,
  "allowPush": true,
  "web": true,
  "webInterface": "builtin",
  "scanDepth": 3
}
```

Set `"webInterface": "cgit"` to use cgit (see `CGIT_BINARY` / `CGIT_ASSETS` above
if it is not in a standard location).

## How it works

- **Discovery** - `src/repos.js` walks the configured folder (up to the scan
  depth), flagging bare repos (`*.git`, or any git dir with `HEAD`/`objects`/`refs`)
  and work trees (folders containing `.git`). Each repo maps to a public URL and
  an internal path, so `PATH_INFO` points git at the real git dir.
- **Smart HTTP** - `src/git-http.js` translates Node's `http` request into a CGI
  invocation of `git http-backend` (headers, stdin body, CONTENT_LENGTH, status
  passthrough), which handles all the pack negotiation for fetch/clone/push.
  Push settings are injected via `GIT_CONFIG_COUNT` environment config, so no
  repository files are ever modified.
- **Web UI** - `src/web.js` renders a small, dependency-free, XSS-escaped
  gitweb-like interface by shelling out to `git log`, `git ls-tree`, `git show`.
- **cgit UI** - `src/cgit.js` locates the `cgit` binary, generates a throwaway
  `cgitrc` (in a temp dir, never on the drive) listing the discovered
  repositories, and proxies web requests to cgit over CGI. `src/cgi.js` is the
  shared CGI bridge used by both `git http-backend` and cgit.
- **Server** - `src/server.js` routes between git endpoints (`/info/refs`,
  `/git-upload-pack`, `/git-receive-pack`, …) and web pages, with a short scan
  cache so new repositories appear within seconds.

## Tests

```sh
npm test
```

The suite spins up real repositories and exercises the full flow: clone,
push, pull, web browsing, push-over-worktree, and disabled-push.

## Security notes

- By default the server binds to **127.0.0.1** only. Use `0.0.0.0` only on
  networks you trust - the server has **no authentication**.
- Pushing is a single toggle (`--no-push` / `allowPush: false`); anything
  reaching receive-pack then gets `403`.
- The web UI escapes all user-controlled content (paths, messages, file
  contents) before rendering.

## License

[MIT](./LICENSE)