#!/usr/bin/env node
// Agent Arcade — a tiny, dependency-free server that runs your local agents
// (any CLI: claude, ollama, aider, your own scripts…) and streams their output
// to a playful browser UI over Server-Sent Events.

const http = require('http');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_TRANSCRIPT = 400; // entries kept per agent
const XP_PER_LEVEL = 100;

// ---------------------------------------------------------------------------
// Config

// Set by start(); see the bottom of this file for the defaults.
let CONFIG_PATH;
let DATA_DIR;
let STATS_FILE;
let options = {};

function resolveConfigPath() {
  const fromArg = process.argv.find((a) => a.startsWith('--config='));
  if (fromArg) return path.resolve(fromArg.slice('--config='.length));
  if (process.env.AGENTS_CONFIG) return path.resolve(process.env.AGENTS_CONFIG);
  const local = path.join(ROOT, 'agents.local.json');
  return fs.existsSync(local) ? local : path.join(ROOT, 'agents.json');
}

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.agents;
  const defaultIde = Array.isArray(raw) ? null : raw.ide || null;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`${CONFIG_PATH} must contain a non-empty "agents" array`);
  }
  const seen = new Set();
  return list.map((a, i) => {
    if (!a.id || !a.command) throw new Error(`agent #${i} needs "id" and "command"`);
    if (seen.has(a.id)) throw new Error(`duplicate agent id "${a.id}"`);
    seen.add(a.id);
    return {
      id: String(a.id),
      name: a.name || a.id,
      role: a.role || '',
      color: a.color || null,
      hat: a.hat || null,
      command: a.command,
      args: Array.isArray(a.args) ? a.args.map(String) : ['{prompt}'],
      stdin: Boolean(a.stdin),
      cwd: a.cwd ? path.resolve(ROOT, a.cwd.replace(/^~(?=$|\/)/, os.homedir())) : options.defaultCwd || process.cwd(),
      env: a.env && typeof a.env === 'object' ? a.env : {},
      timeoutSec: Number(a.timeoutSec) || 0,
      ide: resolveIde(a.ide === undefined ? defaultIde : a.ide),
    };
  });
}

// ---------------------------------------------------------------------------
// IDEs ("Open in Cursor" etc.)

// cli: the launcher on PATH. mac: the app name for `open -a` when the CLI
// isn't installed (common for GUI-launched apps on macOS).
const IDES = {
  cursor: { label: 'Cursor', cli: 'cursor', mac: 'Cursor' },
  vscode: { label: 'VS Code', cli: 'code', mac: 'Visual Studio Code' },
  code: { label: 'VS Code', cli: 'code', mac: 'Visual Studio Code' },
  insiders: { label: 'VS Code Insiders', cli: 'code-insiders', mac: 'Visual Studio Code - Insiders' },
  windsurf: { label: 'Windsurf', cli: 'windsurf', mac: 'Windsurf' },
  zed: { label: 'Zed', cli: 'zed', mac: 'Zed' },
  idea: { label: 'IntelliJ IDEA', cli: 'idea', mac: 'IntelliJ IDEA', jetbrains: true },
  webstorm: { label: 'WebStorm', cli: 'webstorm', mac: 'WebStorm', jetbrains: true },
  pycharm: { label: 'PyCharm', cli: 'pycharm', mac: 'PyCharm', jetbrains: true },
  goland: { label: 'GoLand', cli: 'goland', mac: 'GoLand', jetbrains: true },
  rider: { label: 'Rider', cli: 'rider', mac: 'Rider', jetbrains: true },
  phpstorm: { label: 'PhpStorm', cli: 'phpstorm', mac: 'PhpStorm', jetbrains: true },
  rubymine: { label: 'RubyMine', cli: 'rubymine', mac: 'RubyMine', jetbrains: true },
  clion: { label: 'CLion', cli: 'clion', mac: 'CLion', jetbrains: true },
  rustrover: { label: 'RustRover', cli: 'rustrover', mac: 'RustRover', jetbrains: true },
};

// "cursor" | { "label": "Sublime", "command": "subl", "args": ["{path}"] } | null
function resolveIde(ide) {
  if (!ide) return null;
  if (typeof ide === 'string') {
    const known = IDES[ide.toLowerCase()];
    if (!known) throw new Error(`unknown ide "${ide}" (try: ${Object.keys(IDES).join(', ')})`);
    return { ...known, args: ['{path}'] };
  }
  if (!ide.command) throw new Error('a custom "ide" needs a "command"');
  return { label: ide.label || ide.command, cli: ide.command, args: Array.isArray(ide.args) ? ide.args.map(String) : ['{path}'] };
}

function launch(command, args) {
  return new Promise((resolve, reject) => {
    // Windows editor launchers are .cmd scripts, which need a shell.
    const win = process.platform === 'win32';
    const child = spawn(command, win ? args.map((x) => `"${x}"`) : args, {
      detached: true,
      stdio: 'ignore',
      shell: win,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function openInIde(a) {
  const { ide, cwd } = a.cfg;
  if (!ide) throw new Error(`${a.cfg.name} has no "ide" set in the agents config`);
  const args = ide.args.map((x) => x.split('{path}').join(cwd));
  try {
    await launch(ide.cli, args);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    if (process.platform === 'darwin' && ide.mac) {
      await launch('open', ['-a', ide.mac, cwd]);
      return;
    }
    const hint = ide.jetbrains
      ? 'Turn on shell scripts in JetBrains Toolbox (Settings → Tools → Shell scripts).'
      : `Install the "${ide.cli}" command from ${ide.label}'s command palette.`;
    throw new Error(`Couldn't find "${ide.cli}" on your PATH. ${hint}`);
  }
}

// ---------------------------------------------------------------------------
// State

function loadStats() {
  try {
    return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

let statsSaveTimer = null;
function saveStatsSoon() {
  clearTimeout(statsSaveTimer);
  statsSaveTimer = setTimeout(() => {
    const out = {};
    for (const a of agents.values()) out[a.cfg.id] = a.stats;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(out, null, 2));
  }, 300);
}

let agents = new Map();

function loadAgents() {
  const stats = loadStats();
  agents = new Map(
    loadConfig().map((cfg) => [
      cfg.id,
      {
        cfg,
        status: 'idle', // idle | working | done | error
        task: null,
        startedAt: null,
        lastActivity: Date.now(),
        proc: null,
        transcript: [],
        stats: { xp: 0, runs: 0, wins: 0, fails: 0, ...(stats[cfg.id] || {}) },
      },
    ])
  );
}

function publicAgent(a) {
  const { xp } = a.stats;
  return {
    id: a.cfg.id,
    name: a.cfg.name,
    role: a.cfg.role,
    color: a.cfg.color,
    hat: a.cfg.hat,
    command: [a.cfg.command, ...a.cfg.args].join(' '),
    cwd: a.cfg.cwd,
    ide: a.cfg.ide ? a.cfg.ide.label : null,
    status: a.status,
    task: a.task,
    startedAt: a.startedAt,
    lastActivity: a.lastActivity,
    stats: {
      ...a.stats,
      level: Math.floor(xp / XP_PER_LEVEL) + 1,
      levelProgress: (xp % XP_PER_LEVEL) / XP_PER_LEVEL,
    },
  };
}

// ---------------------------------------------------------------------------
// Server-Sent Events

const clients = new Set();
// In-process listeners (the desktop app uses this for tray + notifications).
const bus = new EventEmitter();

function broadcast(event, data) {
  bus.emit(event, data);
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

function pushTranscript(a, entry) {
  const full = { t: Date.now(), ...entry };
  a.transcript.push(full);
  if (a.transcript.length > MAX_TRANSCRIPT) a.transcript.splice(0, a.transcript.length - MAX_TRANSCRIPT);
  a.lastActivity = full.t;
  broadcast('transcript', { id: a.cfg.id, entry: full });
}

function setStatus(a, status) {
  a.status = status;
  a.lastActivity = Date.now();
  broadcast('agent', publicAgent(a));
}

// ---------------------------------------------------------------------------
// Running agents

function runAgent(a, prompt) {
  if (a.proc) return { error: `${a.cfg.name} is busy` };
  const { cfg } = a;
  if (!fs.existsSync(cfg.cwd)) return { error: `${cfg.name}'s folder doesn't exist: ${cfg.cwd}` };
  const args = cfg.args.map((arg) => arg.split('{prompt}').join(prompt));
  let command = cfg.command;
  const env = { ...process.env, ...cfg.env, FORCE_COLOR: '0', NO_COLOR: '1' };
  // Inside the desktop app there may be no `node` on PATH, so run Node
  // scripts with Electron's own bundled Node instead.
  if (command === 'node' && options.nodeBinary) {
    command = options.nodeBinary;
    env.ELECTRON_RUN_AS_NODE = '1';
  }

  let child;
  try {
    child = spawn(command, args, {
      cwd: cfg.cwd,
      env,
      stdio: [cfg.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return { error: err.message };
  }

  a.proc = child;
  a.task = prompt;
  a.startedAt = Date.now();
  a.stats.runs += 1;
  pushTranscript(a, { kind: 'prompt', text: prompt });
  setStatus(a, 'working');
  broadcast('log', { id: cfg.id, text: `${cfg.name} picked up a quest: “${truncate(prompt, 60)}”` });

  if (cfg.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.end(prompt + '\n');
  }

  const onData = (kind) => (buf) => pushTranscript(a, { kind, text: stripAnsi(buf.toString('utf8')) });
  child.stdout.on('data', onData('out'));
  child.stderr.on('data', onData('err'));

  let timer = null;
  if (cfg.timeoutSec > 0) {
    timer = setTimeout(() => {
      pushTranscript(a, { kind: 'sys', text: `⏰ timed out after ${cfg.timeoutSec}s` });
      child.kill('SIGTERM');
    }, cfg.timeoutSec * 1000);
  }

  let finished = false;
  const finish = (code, signal, spawnError) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    a.proc = null;
    const secs = ((Date.now() - a.startedAt) / 1000).toFixed(1);
    const ok = code === 0 && !spawnError;
    const beforeLevel = Math.floor(a.stats.xp / XP_PER_LEVEL);
    if (ok) {
      a.stats.wins += 1;
      a.stats.xp += 25 + Math.min(25, Math.round(Number(secs)));
    } else {
      a.stats.fails += 1;
      a.stats.xp += 5; // participation trophy
    }
    const leveledUp = Math.floor(a.stats.xp / XP_PER_LEVEL) > beforeLevel;
    saveStatsSoon();

    const why = spawnError ? spawnError.message : signal ? `stopped (${signal})` : `exit ${code}`;
    pushTranscript(a, { kind: 'sys', text: ok ? `✅ done in ${secs}s` : `💥 ${why} after ${secs}s` });
    setStatus(a, ok ? 'done' : 'error');
    broadcast('log', {
      id: cfg.id,
      text: ok ? `${cfg.name} completed a quest in ${secs}s` : `${cfg.name} stumbled: ${why}`,
    });
    if (leveledUp) {
      const level = Math.floor(a.stats.xp / XP_PER_LEVEL) + 1;
      broadcast('levelup', { id: cfg.id, level });
      broadcast('log', { id: cfg.id, text: `🎉 ${cfg.name} reached level ${level}!` });
    }
  };

  child.on('error', (err) => finish(null, null, err));
  child.on('close', (code, signal) => finish(code, signal));
  return { ok: true };
}

function stopAgent(a) {
  if (!a.proc) return { error: `${a.cfg.name} isn't doing anything` };
  a.proc.kill('SIGTERM');
  const p = a.proc;
  setTimeout(() => p.exitCode === null && p.kill('SIGKILL'), 3000);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'nope' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// Only accept state-changing requests from our own page, so a random website
// open in another tab can't make your agents run commands.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');

  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ agents: [...agents.values()].map(publicAgent) })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (pathname === '/api/agents' && req.method === 'GET') {
    return sendJson(res, 200, [...agents.values()].map(publicAgent));
  }

  const m = pathname.match(/^\/api\/agents\/([^/]+)\/(run|stop|transcript|clear|open-ide)$/);
  if (m) {
    const a = agents.get(decodeURIComponent(m[1]));
    if (!a) return sendJson(res, 404, { error: 'unknown agent' });
    const action = m[2];

    if (action === 'transcript' && req.method === 'GET') return sendJson(res, 200, a.transcript);
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request refused' });

    if (action === 'run') {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return sendJson(res, 400, { error: 'bad json' });
      }
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return sendJson(res, 400, { error: 'prompt is required' });
      const r = runAgent(a, prompt);
      return sendJson(res, r.error ? 409 : 200, r);
    }
    if (action === 'stop') {
      const r = stopAgent(a);
      return sendJson(res, r.error ? 409 : 200, r);
    }
    if (action === 'open-ide') {
      try {
        await openInIde(a);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }
    if (action === 'clear') {
      if (a.proc) return sendJson(res, 409, { error: 'stop the agent first' });
      a.transcript = [];
      a.task = null;
      setStatus(a, 'idle');
      broadcast('cleared', { id: a.cfg.id });
      return sendJson(res, 200, { ok: true });
    }
  }

  if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
  serveStatic(req, res);
});

// ---------------------------------------------------------------------------
// Helpers

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function stopAll() {
  for (const a of agents.values()) a.proc && a.proc.kill('SIGTERM');
}

// Start the arcade. Resolves with { url, port, server, bus, snapshot, stopAll }.
function start(opts = {}) {
  options = opts;
  CONFIG_PATH = opts.configPath || resolveConfigPath();
  DATA_DIR = opts.dataDir || path.join(ROOT, 'data');
  STATS_FILE = path.join(DATA_DIR, 'stats.json');
  loadAgents();

  const host = opts.host || process.env.HOST || '127.0.0.1';
  const port = opts.port ?? (Number(process.env.PORT) || 4321);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const actual = server.address().port;
      resolve({
        url: `http://${host}:${actual}`,
        port: actual,
        configPath: CONFIG_PATH,
        server,
        bus,
        snapshot: () => [...agents.values()].map(publicAgent),
        stopAll,
      });
    });
  });
}

module.exports = { start };

if (require.main === module) {
  const shutdown = () => {
    stopAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  start()
    .then(({ url, configPath }) => {
      const names = [...agents.values()].map((a) => a.cfg.name).join(', ');
      console.log(`\n  🕹️  Agent Arcade is open at ${url}`);
      console.log(`  📜 config: ${path.relative(process.cwd(), configPath) || configPath}`);
      console.log(`  🤖 agents: ${names}\n`);
    })
    .catch((err) => {
      console.error(`Agent Arcade failed to start: ${err.message}`);
      process.exit(1);
    });
}
