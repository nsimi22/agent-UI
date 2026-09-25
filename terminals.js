// Reaching the terminal a watched session runs in.
//
// Hooks report the agent's process id. Walking up its parents finds the shell
// that an editor terminal tab was started with. The Agent Arcade Terminals
// extension (ide/vscode) keeps a connection open to the arcade; when asked,
// each editor window checks its own terminals for one of those process ids and
// shows it or types into it.

const { execFile } = require('child_process');

const ACK_TIMEOUT_MS = 2500;
const MAX_DEPTH = 8;

// [pid, parent, grandparent, …] up to (not including) init, plus the agent's
// command name. Resolves null where `ps` isn't available (Windows).
function processChain(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 1) return resolve(null);
    const chain = [];
    let name = null;
    const step = (p) => {
      execFile('ps', ['-o', 'ppid=,comm=', '-p', String(p)], { timeout: 2000 }, (err, out) => {
        const m = !err && out.trim().match(/^(\d+)\s+(.*)$/);
        if (!m) return resolve(chain.length ? { chain, name } : null);
        chain.push(p);
        if (name === null) name = m[2].trim();
        const parent = Number(m[1]);
        if (parent <= 1 || chain.length >= MAX_DEPTH) return resolve({ chain, name });
        step(parent);
      });
    };
    step(pid);
  });
}

// True only while `pid` is a live (non-zombie) process that still sits under
// the same parent. Anything else means the agent has gone and the terminal is
// back at a plain shell prompt, or the pid now belongs to something else.
function stillRunning(pid, parent) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid)) return resolve(false);
    execFile('ps', ['-o', 'stat=,ppid=', '-p', String(pid)], { timeout: 2000 }, (err, out) => {
      const m = !err && out.trim().match(/^(\S+)\s+(\d+)$/);
      resolve(Boolean(m) && !m[1].startsWith('Z') && (parent === undefined || Number(m[2]) === parent));
    });
  });
}

function createTerminals({ sse, broadcast }) {
  const editors = new Set(); // open extension connections
  const pending = new Map(); // command id -> { waiting, resolve }
  let nextId = 1;

  function announce() {
    broadcast('ide', { editors: editors.size });
  }

  // GET /api/ide/stream: one per editor window running the extension.
  function attach(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': hello\n\n');
    editors.add(res);
    announce();
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      editors.delete(res);
      for (const p of pending.values()) p.drop(res);
      announce();
    });
  }

  // POST /api/ide/ack: an editor window says whether it had that terminal
  // (and, if so, which folder the window has open).
  function ack(result) {
    const p = pending.get(result && result.id);
    if (p) p.answer(result);
  }

  // Sends a command to every editor window. Resolves with the ack of the one
  // that had the terminal ({ ok, folder, app }), or null if none did.
  function command(cmd) {
    if (!editors.size) return Promise.resolve(null);
    const id = nextId++;
    return new Promise((resolve) => {
      let waiting = editors.size;
      const done = (result) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(result);
      };
      const timer = setTimeout(() => done(null), ACK_TIMEOUT_MS);
      pending.set(id, {
        answer: (result) => (result.ok ? done(result) : --waiting <= 0 && done(null)),
        drop: () => --waiting <= 0 && done(null),
      });
      const payload = sse('command', { id, ...cmd });
      for (const res of editors) res.write(payload);
    });
  }

  return { attach, ack, command, count: () => editors.size };
}

module.exports = { createTerminals, processChain, stillRunning };
