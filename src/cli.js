'use strict';

const fs = require('node:fs');
const path = require('node:path');

const configStore = require('./config');
const { discover } = require('./repos');
const { createServer } = require('./server');
const cgit = require('./cgit');
const { withPrompt, ask, confirm, select, colors: c } = require('./prompt');
const { isDirectory, expandPath } = require('./util');

const pkg = require('../package.json');

/**
 * Extremely small argv parser (no dependencies).
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  const takesValue = new Set(['dir', 'port', 'host', 'depth', 'config', 'web-ui']);
  const shortMap = { d: 'dir', p: 'port', H: 'host', c: 'config', h: 'help', v: 'version' };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      let name = arg.slice(2);
      let value;
      const eq = name.indexOf('=');
      if (eq !== -1) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      if (name.startsWith('no-')) {
        flags[name.slice(3)] = false;
        continue;
      }
      if (takesValue.has(name) && value === undefined) value = argv[(i += 1)];
      flags[name] = value === undefined ? true : value;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const name = shortMap[arg[1]];
      if (!name) {
        positionals.push(arg);
        continue;
      }
      if (takesValue.has(name)) {
        flags[name] = arg.slice(2) || argv[(i += 1)];
      } else {
        flags[name] = true;
        for (const letter of arg.slice(2)) {
          const extra = shortMap[letter];
          if (extra) flags[extra] = true;
        }
      }
      continue;
    }
    positionals.push(arg);
  }
  return { _: positionals, flags };
}

/**
 * Values explicitly provided on the command line.
 * @param {Record<string, any>} flags
 */
function overridesFromFlags(flags) {
  const overrides = {};
  if (flags.dir) overrides.dir = flags.dir;
  if (flags.port !== undefined) overrides.port = Number(flags.port);
  if (flags.host) overrides.host = flags.host;
  if (flags.push !== undefined) overrides.allowPush = Boolean(flags.push);
  if (flags.web !== undefined) overrides.web = Boolean(flags.web);
  if (flags['web-ui'] !== undefined) {
    const value = String(flags['web-ui']).toLowerCase();
    if (value !== 'builtin' && value !== 'cgit') {
      throw new Error('--web-ui must be either "builtin" or "cgit".');
    }
    overrides.webInterface = value;
  }
  if (flags.depth !== undefined) overrides.scanDepth = Number(flags.depth);
  return overrides;
}

/**
 * @param {Record<string, any>} flags
 */
function loadStored(flags) {
  const file = flags.config ? expandPath(String(flags.config)) : undefined;
  const stored = configStore.load(file);
  return { stored, file: file || configStore.resolveConfigPath() };
}

/**
 * Interactively build a configuration, starting from `base`.
 * @param {{base: object, overrides: object}} options
 * @returns {Promise<object>}
 */
async function gatherConfig({ base, overrides }) {
  const current = { ...base, ...overrides };
  return withPrompt(async (rl) => {
    process.stdout.write(
      `\n${c.bold('localgit setup')} — a few questions, then your USB becomes a git remote.\n\n`,
    );
    return gatherAnswers(rl, current);
  });
}

/**
 * Ask every setup question against `rl` and return the normalized config.
 * Split out from `gatherConfig` so the flow can be tested with a fake
 * readline without needing a TTY.
 * @param {import('node:readline/promises').Interface} rl
 * @param {object} current
 * @returns {Promise<object>}
 */
async function gatherAnswers(rl, current) {
  // 1. Where repos live.
  let dir = current.dir || process.cwd();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answer = await ask(rl, 'Where are all your git repositories stored?', {
      default: dir,
    });
    const abs = expandPath(answer);
    if (isDirectory(abs)) {
      dir = abs;
      break;
    }
    const create = await confirm(rl, `"${abs}" does not exist. Create it?`, true);
    if (create) {
      fs.mkdirSync(abs, { recursive: true });
      dir = abs;
      break;
    }
  }

  // 2. Which address to listen on.
  const host = await select(
    rl,
    'Which address should the server listen on?',
    [
      {
        label: '127.0.0.1 (this computer only)',
        value: '127.0.0.1',
        hint: 'safest default',
      },
      {
        label: '0.0.0.0 (all interfaces)',
        value: '0.0.0.0',
        hint: 'reachable from other devices on the network',
      },
    ],
    current.host === '0.0.0.0' ? 1 : 0,
  );

  // 3. Port.
  const port = await ask(rl, 'Which port should the server use?', {
    default: String(currentPort(current)),
    validate: (value) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return 'Enter a port between 1 and 65535.';
      return true;
    },
    transform: Number,
  });

  // 4. Allow push?
  const allowPush = await confirm(
    rl,
    'Allow git push (receive-pack) to these repositories?',
    current.allowPush !== false,
  );

  // 5. Web browser?
  const web = await confirm(
    rl,
    'Enable the web repository browser at / ?',
    current.web !== false,
  );

  // 5.b. Which rendering engine, when the browser is enabled?
  let webInterface = 'builtin';
  if (web) {
    const detected = cgit.locate();
    const cgitHint = detected
      ? `detected at ${detected.binary}`
      : 'not detected (install cgit or set CGIT_BINARY)';
    webInterface = await select(
      rl,
      'Which web interface should the browser use?',
      [
        {
          label: 'Built-in (localgit)',
          value: 'builtin',
          hint: 'no extra software, always available',
        },
        {
          label: 'cgit',
          value: 'cgit',
          hint: cgitHint,
        },
      ],
      current.webInterface === 'cgit' && detected ? 1 : 0,
    );
    if (webInterface === 'cgit' && !detected) {
      process.stdout.write(
        `${c.yellow('!')} cgit was not found on this system. The server will refuse to start ` +
          `until you install cgit or point CGIT_BINARY at the binary.\n`,
      );
    }
  }

  // 6. Scan depth.
  const scanDepth = await ask(rl, 'How many folder levels deep should I scan for repos?', {
    default: String(current.scanDepth || 3),
    validate: (value) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 10) return 'Enter a number between 0 and 10.';
      return true;
    },
    transform: Number,
  });

  return configStore.normalize({
    ...current,
    dir,
    host,
    port,
    allowPush,
    web,
    webInterface,
    scanDepth,
  });
}

/**
 * @param {object} current
 */
function currentPort(current) {
  return Number.isFinite(Number(current.port)) ? Number(current.port) : configStore.DEFAULTS.port;
}

/**
 * @param {import('node:http').Server} server
 * @param {object} cfg
 * @param {object} registry
 */
function printBanner(cfg, registry) {
  const shown = cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host;
  const base = `http://${shown}:${cfg.port}`;
  const repos = registry.repos;
  const interfaceLabel =
    cfg.webInterface === 'cgit' ? c.dim(`cgit`) : c.dim('built-in');
  const lines = [
    '',
    `${c.green('✔')} ${c.bold('localgit is running')}`,
    '',
    `  Web UI     ${c.cyan(`${base}/`)}`,
    `  Repos dir  ${cfg.dir}`,
    `  Push       ${cfg.allowPush ? c.green('enabled') : c.yellow('disabled')}`,
    `  Web        ${cfg.web ? c.green(`enabled (${interfaceLabel})`) : c.yellow('disabled')}`,
    '',
  ];

  if (repos.length === 0) {
    lines.push(`  ${c.yellow('No repositories found yet.')} Create one with:`);
    lines.push(`    ${c.dim(`git init --bare ${path.join(cfg.dir, 'myproject.git')}`)}`);
    lines.push('');
  } else {
    lines.push(`  ${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}:`);
    for (const repo of repos.slice(0, 10)) {
      lines.push(`    ${c.cyan(`${base}/${repo.name}`)}`);
    }
    if (repos.length > 10) lines.push(`    ${c.dim(`… and ${repos.length - 10} more`)}`);
    const example = repos[0].name;
    lines.push('');
    lines.push(`  ${c.bold('Clone:')}      git clone ${base}/${example}`);
    lines.push(
      `  ${c.bold('Push:')}       git remote add usb ${base}/${example} && git push usb --all`,
    );
    lines.push('');
  }

  lines.push(`  ${c.dim('Press Ctrl+C to stop.')}`);
  lines.push('');
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * @param {string} file
 * @param {object} cfg
 */
function saveConfig(file, cfg) {
  try {
    const written = configStore.save(cfg, file);
    process.stdout.write(`${c.dim(`Saved configuration to ${written}`)}\n`);
  } catch (error) {
    process.stderr.write(`${c.yellow('!')} Could not save configuration: ${error.message}\n`);
  }
}

/**
 * @param {Record<string, any>} flags
 */
async function runServe(flags) {
  const { stored, file } = loadStored(flags);
  const overrides = overridesFromFlags(flags);
  const interactive = Boolean(process.stdin.isTTY) && !flags.yes && !flags.force;
  const needsSetup = !stored || flags.setup;

  let cfg;
  let didPrompt = false;
  if (needsSetup) {
    if (!interactive) {
      if (!overrides.dir) {
        throw new Error(
          'No configuration found. Run "localgit setup" or pass --dir <path> for non-interactive use.',
        );
      }
      cfg = configStore.normalize({ ...stored, ...overrides });
    } else {
      didPrompt = true;
      cfg = await gatherConfig({ base: stored || {}, overrides });
    }
  } else {
    cfg = configStore.normalize({ ...stored, ...overrides });
  }

  if (!isDirectory(cfg.dir)) {
    throw new Error(`Repository directory does not exist: ${cfg.dir}`);
  }

  if (didPrompt && flags.save !== false) saveConfig(file, cfg);

  const { server, registry, close } = createServer(cfg);

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`Port ${cfg.port} is already in use. Choose another with --port.`));
        return;
      }
      reject(error);
    };
    server.once('error', onError);
    server.listen(cfg.port, cfg.host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  printBanner(cfg, registry);

  const shutdown = async (signal) => {
    process.stdout.write(`\n${c.dim(`Received ${signal}, shutting down…`)}\n`);
    try {
      await close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { server, registry, config: cfg };
}

/**
 * @param {Record<string, any>} flags
 */
async function runSetupCommand(flags) {
  const { stored, file } = loadStored(flags);
  const overrides = overridesFromFlags(flags);

  if (!process.stdin.isTTY || flags.yes) {
    if (!overrides.dir && !(stored && stored.dir)) {
      throw new Error('Non-interactive setup needs --dir <path>.');
    }
    const cfg = configStore.normalize({ ...stored, ...overrides });
    saveConfig(file, cfg);
    return cfg;
  }

  const cfg = await gatherConfig({ base: stored || {}, overrides });
  saveConfig(file, cfg);
  process.stdout.write(
    `\n${c.green('✔')} Setup complete. Start the server with ${c.bold('localgit')}.\n\n`,
  );
  return cfg;
}

/**
 * @param {Record<string, any>} flags
 */
async function runList(flags) {
  const { stored } = loadStored(flags);
  const overrides = overridesFromFlags(flags);
  const cfg = configStore.normalize({ ...stored, ...overrides });
  if (!isDirectory(cfg.dir)) {
    throw new Error(`Repository directory does not exist: ${cfg.dir}`);
  }
  const { repos, warnings } = discover(cfg.dir, { depth: cfg.scanDepth });
  const shown = cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host;
  const base = `http://${shown}:${cfg.port}`;

  process.stdout.write(`\nRepositories in ${cfg.dir} (${repos.length}):\n\n`);
  if (repos.length === 0) {
    process.stdout.write('  (none found)\n');
  }
  for (const repo of repos) {
    const kind = repo.bare ? 'bare' : 'worktree';
    process.stdout.write(
      `  ${c.cyan(repo.name)} ${c.dim(`[${kind}]`)}\n    ${c.dim(repo.gitDir)}\n    ${base}/${repo.name}\n`,
    );
  }
  for (const warning of warnings) process.stdout.write(`  ${c.yellow('!')} ${warning}\n`);
  process.stdout.write('\n');
  return repos;
}

function printHelp() {
  process.stdout.write(`
${c.bold('localgit')} v${pkg.version} — serve a folder of git repositories over HTTP.

${c.bold('Usage')}
  localgit [command] [options]

${c.bold('Commands')}
  serve            Start the HTTP git server (default)
  setup            Answer the setup questions and save a config
  list             List discovered repositories
  help             Show this help
  version          Print the version

${c.bold('Options')}
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
      --no-save        Do not write a config file after an interactive setup
  -h, --help           Show this help
  -v, --version        Print the version

${c.bold('Environment')}
  CGIT_BINARY          Path to the cgit executable (default: probe PATH)
  CGIT_ASSETS          Directory with cgit's css/js/logo files

${c.bold('Examples')}
  localgit                                   # interactive first run, then serve
  localgit --dir /media/usb/git --port 4000  # serve a USB folder
  localgit setup                             # just (re)write the config
  localgit list                              # show what would be served
`);
}

/**
 * @param {string[]} argv
 */
async function main(argv = process.argv.slice(2)) {
  const { _, flags } = parseArgs(argv);

  if (flags.help) return printHelp();
  if (flags.version) {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  const command = _[0] || 'serve';
  switch (command) {
    case 'serve':
    case 'start':
      return runServe(flags);
    case 'setup':
    case 'init':
      return runSetupCommand(flags);
    case 'list':
    case 'ls':
      return runList(flags);
    case 'help':
      return printHelp();
    case 'version':
      process.stdout.write(`${pkg.version}\n`);
      return;
    default:
      printHelp();
      throw new Error(`Unknown command: ${command}`);
  }
}

module.exports = { main, parseArgs, gatherConfig, gatherAnswers, runServe, runList, runSetupCommand };
