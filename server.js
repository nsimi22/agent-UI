#!/usr/bin/env node
// Agent Arcade — a tiny, dependency-free server that runs your local agents
// (any CLI: claude, ollama, aider, your own scripts…) and streams their output
// to a playful browser UI over Server-Sent Events.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 4321;
const MAX_TRANSCRIPT = 400; // entries kept per agent
const XP_PER_LEVEL = 100;

// ---------------------------------------------------------------------------
// Config

function resolveConfigPath() {
  const fromArg = process.argv.find((a) => a.startsWith('--config='));
  if (fromArg) return path.resolve(fromArg.slice('--config='.length));
  if (process.env.AGENTS_CONFIG) return path.resolve(process.env.AGENTS_CONFIG);
  const local = path.join(ROOT, 'agents.local.json');
  return fs.existsSync(local) ? local : path.join(ROOT, 'agents.json');
}

const CONFIG_PATH = resolveConfigPath();

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.agents;
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
      cwd: a.cwd ? path.resolve(ROOT, a.cwd.replace(/^~(?=$|\/)/, os.homedir())) : process.cwd(),
      env: a.env && typeof a.env === 'object' ? a.env : {},
      timeoutSec: Number(a.timeoutSec) || 0,
    };
  });
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

const stats = loadStats();
const agents = new Map(
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

function publicAgent(a) {
  const { xp } = a.stats;
  return {
    id: a.cfg.id,
    name: a.cfg.name,
    role: a.cfg.role,
    color: a.cfg.color,
    hat: a.cfg.hat,
    command: [a.cfg.command, ...a.cfg.args].join(' '),
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

function broadcast(event, data) {
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
  const args = cfg.args.map((arg) => arg.split('{prompt}').join(prompt));

  let child;
  try {
    child = spawn(cfg.command, args, {
      cwd: cfg.cwd,
      env: { ...process.env, ...cfg.env, FORCE_COLOR: '0', NO_COLOR: '1' },
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

  const m = pathname.match(/^\/api\/agents\/([^/]+)\/(run|stop|transcript|clear)$/);
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

function shutdown() {
  for (const a of agents.values()) a.proc && a.proc.kill('SIGTERM');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  const names = [...agents.values()].map((a) => a.cfg.name).join(', ');
  console.log(`\n  🕹️  Agent Arcade is open at http://${HOST}:${PORT}`);
  console.log(`  📜 config: ${path.relative(process.cwd(), CONFIG_PATH) || CONFIG_PATH}`);
  console.log(`  🤖 agents: ${names}\n`);
});
