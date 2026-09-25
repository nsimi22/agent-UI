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
const { stripVTControlCharacters } = require('util');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_TRANSCRIPT = 400; // entries kept per agent
const OUTPUT_FLUSH_MS = 50; // coalesce chatty stdout into fewer events
// An escape sequence cut off at the end of a chunk (CSI or OSC, unterminated).
// eslint-disable-next-line no-control-regex
const PARTIAL_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*)?$/;
const XP_PER_LEVEL = 100;
const levelOf = (xp) => Math.floor(xp / XP_PER_LEVEL) + 1;

// ---------------------------------------------------------------------------
// Config

// Set by start(); see the bottom of this file for the defaults.
let CONFIG_PATH;
let DATA_DIR;
let STATS_FILE;
let options = {};
let listenHost = '127.0.0.1';

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

// cli: the launcher on PATH (defaults to the key). mac: the app name for
// `open -a` when the CLI isn't installed (defaults to the label).
const jetbrains = (label) => ({ label, jetbrains: true });
const IDES = {
  cursor: { label: 'Cursor' },
  vscode: { label: 'VS Code', cli: 'code', mac: 'Visual Studio Code' },
  insiders: { label: 'VS Code Insiders', cli: 'code-insiders', mac: 'Visual Studio Code - Insiders' },
  windsurf: { label: 'Windsurf' },
  zed: { label: 'Zed' },
  idea: jetbrains('IntelliJ IDEA'),
  webstorm: jetbrains('WebStorm'),
  pycharm: jetbrains('PyCharm'),
  goland: jetbrains('GoLand'),
  rider: jetbrains('Rider'),
  phpstorm: jetbrains('PhpStorm'),
  rubymine: jetbrains('RubyMine'),
  clion: jetbrains('CLion'),
  rustrover: jetbrains('RustRover'),
};
IDES.code = IDES.vscode;

// "cursor" | { "label": "Sublime", "command": "subl", "args": ["{path}"] } | null
function resolveIde(ide) {
  if (!ide) return null;
  if (typeof ide === 'string') {
    const key = ide.toLowerCase();
    const known = IDES[key];
    if (!known) throw new Error(`unknown ide "${ide}" (try: ${Object.keys(IDES).join(', ')})`);
    return { cli: key, mac: known.label, ...known, args: ['{path}'] };
  }
  if (!ide.command) throw new Error('a custom "ide" needs a "command"');
  return { label: ide.label || ide.command, cli: ide.command, args: Array.isArray(ide.args) ? ide.args.map(String) : ['{path}'] };
}

// Resolve a command to a file on PATH (honouring PATHEXT on Windows), or null.
function findOnPath(cmd) {
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  const dirs = path.isAbsolute(cmd) || cmd.includes(path.sep) ? [''] : (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, cmd + ext);
      try {
        if (fs.statSync(file).isFile()) {
          fs.accessSync(file, fs.constants.X_OK);
          return file;
        }
      } catch {}
    }
  }
  return null;
}

// On Windows many CLIs are .cmd/.bat shims (claude.cmd, npx.cmd, code.cmd, …)
// that only run through cmd.exe. Escape for cmd.exe the way cross-spawn does:
// quote per the MSVC rules, then caret-escape metacharacters twice, because
// the shim re-parses its arguments when it expands %*.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
function escapeCmdArg(arg) {
  let s = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  s = `"${s}"`;
  return s.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}

function spawnCommand(command, args, opts) {
  if (process.platform === 'win32') {
    const file = findOnPath(command) || command;
    if (/\.(cmd|bat)$/i.test(file)) {
      const line = [file.replace(CMD_META, '^$1'), ...args.map(escapeCmdArg)].join(' ');
      return spawn(process.env.comspec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true });
    }
  }
  return spawn(command, args, opts);
}

function launch(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(file, args, { detached: true, stdio: 'ignore' });
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
  const bin = findOnPath(ide.cli);
  if (bin) return launch(bin, ide.args.map((x) => x.replaceAll('{path}', cwd)));
  if (process.platform === 'darwin' && ide.mac) return launch('open', ['-a', ide.mac, cwd]);
  const hint = ide.jetbrains
    ? 'Turn on shell scripts in JetBrains Toolbox (Settings → Tools → Shell scripts).'
    : `Install the "${ide.cli}" command from ${ide.label}'s command palette.`;
  throw new Error(`Couldn't find "${ide.cli}" on your PATH. ${hint}`);
}

// ---------------------------------------------------------------------------
// State

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let statsSaveTimer = null;
function saveStatsSoon() {
  clearTimeout(statsSaveTimer);
  statsSaveTimer = setTimeout(() => {
    const out = {};
    for (const a of agents.values()) out[a.cfg.id] = a.stats;
    writeJson(STATS_FILE, out);
  }, 300);
}

let agents = new Map();

function loadAgents() {
  const stats = readJson(STATS_FILE, {});
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
        lastLine: null, // latest non-blank output line of the current run
        seq: 0, // transcript entry counter, so clients can merge live + fetched entries
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
    lastLine: a.lastLine,
    startedAt: a.startedAt,
    lastActivity: a.lastActivity,
    stats: {
      ...a.stats,
      level: levelOf(xp),
      levelProgress: (xp % XP_PER_LEVEL) / XP_PER_LEVEL,
    },
  };
}

const snapshot = () => [...agents.values()].map(publicAgent);

// ---------------------------------------------------------------------------
// Server-Sent Events

const clients = new Set();
// In-process listeners (the desktop app uses this for tray + notifications).
const bus = new EventEmitter();

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function broadcast(event, data) {
  bus.emit(event, data);
  const payload = sse(event, data);
  for (const res of clients) res.write(payload);
}

function lastLineOf(text) {
  for (let end = text.length; end > 0; ) {
    const start = text.lastIndexOf('\n', end - 1);
    const line = text.slice(start + 1, end).trim();
    if (line) return line.slice(0, 180);
    end = start;
  }
  return null;
}

function pushTranscript(a, entry) {
  const full = { seq: ++a.seq, t: Date.now(), ...entry };
  a.transcript.push(full);
  // Trim in batches rather than shifting the array on every chunk.
  if (a.transcript.length > MAX_TRANSCRIPT * 1.25) a.transcript.splice(0, a.transcript.length - MAX_TRANSCRIPT);
  a.lastActivity = full.t;
  if (entry.kind === 'out' || entry.kind === 'err') a.lastLine = lastLineOf(entry.text) || a.lastLine;
  broadcast('transcript', { id: a.cfg.id, entry: full, lastLine: a.lastLine });
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
  const args = cfg.args.map((arg) => arg.replaceAll('{prompt}', prompt));
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
    child = spawnCommand(command, args, {
      cwd: cfg.cwd,
      env,
      stdio: [cfg.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return { error: err.message };
  }

  a.proc = child;
  a.task = prompt;
  a.lastLine = null;
  a.startedAt = Date.now();
  a.stats.runs += 1;
  pushTranscript(a, { kind: 'prompt', text: prompt });
  setStatus(a, 'working');
  broadcast('log', { id: cfg.id, text: `${cfg.name} picked up a quest: “${truncate(prompt, 60)}”` });

  if (cfg.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.end(prompt + '\n');
  }

  // Buffer output briefly so a chatty agent sends a few events per second
  // instead of one per pipe chunk.
  // Escape sequences are stripped at flush time; an unfinished one at the end
  // of the buffer waits for the rest to arrive.
  let pending = null; // { kind, raw }
  let flushTimer = null;
  const flush = (final = true) => {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (!pending) return;
    let { raw } = pending;
    const tail = final ? '' : (raw.match(PARTIAL_ESCAPE) || [''])[0];
    raw = raw.slice(0, raw.length - tail.length);
    const text = stripVTControlCharacters(raw);
    if (text) pushTranscript(a, { kind: pending.kind, text });
    pending = tail ? { kind: pending.kind, raw: tail } : null;
  };
  const onData = (kind) => (chunk) => {
    if (pending && pending.kind !== kind) flush();
    if (pending) pending.raw += chunk;
    else pending = { kind, raw: chunk };
    flushTimer ??= setTimeout(() => flush(false), OUTPUT_FLUSH_MS);
  };
  // setEncoding decodes UTF-8 across chunk boundaries (no split emoji).
  child.stdout.setEncoding('utf8').on('data', onData('out'));
  child.stderr.setEncoding('utf8').on('data', onData('err'));

  let timer = null;
  if (cfg.timeoutSec > 0) {
    timer = setTimeout(() => {
      flush();
      pushTranscript(a, { kind: 'sys', text: `⏰ timed out after ${cfg.timeoutSec}s` });
      child.kill('SIGTERM');
    }, cfg.timeoutSec * 1000);
  }

  let finished = false;
  const finish = (code, signal, spawnError) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    flush();
    a.proc = null;
    const secs = ((Date.now() - a.startedAt) / 1000).toFixed(1);
    const ok = code === 0 && !spawnError;
    const levelBefore = levelOf(a.stats.xp);
    if (ok) {
      a.stats.wins += 1;
      a.stats.xp += 25 + Math.min(25, Math.round(Number(secs)));
    } else {
      a.stats.fails += 1;
      a.stats.xp += 5; // participation trophy
    }
    const level = levelOf(a.stats.xp);
    saveStatsSoon();

    const why = spawnError ? spawnError.message : signal ? `stopped (${signal})` : `exit ${code}`;
    pushTranscript(a, { kind: 'sys', text: ok ? `✅ done in ${secs}s` : `💥 ${why} after ${secs}s` });
    setStatus(a, ok ? 'done' : 'error');
    broadcast('log', {
      id: cfg.id,
      text: ok ? `${cfg.name} completed a quest in ${secs}s` : `${cfg.name} stumbled: ${why}`,
    });
    if (level > levelBefore) {
      broadcast('levelup', { id: cfg.id, name: cfg.name, level });
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

// Only answer requests addressed to this machine by name. This blocks DNS
// rebinding, where a website points its own domain at 127.0.0.1.
function localHost(req) {
  try {
    const { hostname } = new URL(`http://${req.headers.host}`);
    return ['localhost', '127.0.0.1', '[::1]', listenHost].includes(hostname);
  } catch {
    return false;
  }
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

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) sendJson(res, 400, { error: err.message });
    else res.end();
  });
});

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://x');
  if (!localHost(req)) return sendJson(res, 403, { error: 'unexpected Host header' });

  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(sse('hello', { agents: snapshot() }));
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (pathname === '/api/agents' && req.method === 'GET') {
    return sendJson(res, 200, snapshot());
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
      a.lastLine = null;
      setStatus(a, 'idle');
      broadcast('cleared', { id: a.cfg.id });
      return sendJson(res, 200, { ok: true });
    }
  }

  if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
  serveStatic(req, res);
}

// ---------------------------------------------------------------------------
// Helpers

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function stopAll() {
  for (const a of agents.values()) a.proc && a.proc.kill('SIGTERM');
}

function listen(port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

// Start the arcade. If `fallbackPort` is given (e.g. 0 for "any free port")
// it's used when `port` is taken. Resolves with { url, configPath, bus,
// snapshot, stopAll }.
async function start(opts = {}) {
  options = opts;
  CONFIG_PATH = opts.configPath || resolveConfigPath();
  DATA_DIR = opts.dataDir || path.join(ROOT, 'data');
  STATS_FILE = path.join(DATA_DIR, 'stats.json');
  loadAgents();

  const host = opts.host || process.env.HOST || '127.0.0.1';
  listenHost = host;
  const port = opts.port ?? (Number(process.env.PORT) || 4321);
  let actual;
  try {
    actual = await listen(port, host);
  } catch (err) {
    if (err.code !== 'EADDRINUSE' || opts.fallbackPort === undefined) throw err;
    actual = await listen(opts.fallbackPort, host);
  }
  return { url: `http://${host}:${actual}`, configPath: CONFIG_PATH, bus, snapshot, stopAll };
}

module.exports = { start, readJson, writeJson };

if (require.main === module) {
  const shutdown = () => {
    stopAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  start()
    .then(({ url, configPath, snapshot: list }) => {
      const names = list().map((a) => a.name).join(', ');
      console.log(`\n  🕹️  Agent Arcade is open at ${url}`);
      console.log(`  📜 config: ${path.relative(process.cwd(), configPath) || configPath}`);
      console.log(`  🤖 agents: ${names}\n`);
    })
    .catch((err) => {
      console.error(`Agent Arcade failed to start: ${err.message}`);
      process.exit(1);
    });
}
