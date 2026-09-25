// Agent Arcade Terminals: a tiny bridge between Agent Arcade and this editor
// window's integrated terminals (Cursor, VS Code, Windsurf, …).
//
// It keeps one connection open to the arcade on 127.0.0.1. When the arcade
// asks, it finds the terminal whose shell is an ancestor of an agent's
// process, then shows it or types into it, and reports back.

const http = require('http');
const vscode = require('vscode');

const RETRY_MS = 5000;
const BRACKETED_PASTE = ['\x1b[200~', '\x1b[201~']; // lets multi-line replies arrive as one paste
const KEYS = { enter: '\r', esc: '\x1b' };

let request = null;
let retryTimer = null;
let stopped = false;

function port() {
  return vscode.workspace.getConfiguration('agentArcade').get('port') || 4321;
}

function connect() {
  if (stopped) return;
  const query = `app=${encodeURIComponent(vscode.env.appName)}`;
  request = http.get({ host: '127.0.0.1', port: port(), path: `/api/ide/stream?${query}` }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      return retry();
    }
    res.setEncoding('utf8');
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const message = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = message.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        if (/^event: command$/m.test(message) && data) handle(JSON.parse(data)).catch(() => {});
      }
    });
    res.on('end', retry);
    res.on('error', retry);
  });
  request.on('error', retry); // the arcade isn't running; try again shortly
}

function retry() {
  clearTimeout(retryTimer);
  if (!stopped) retryTimer = setTimeout(connect, RETRY_MS);
}

// The terminal whose shell is one of the agent's ancestor processes.
async function findTerminal(pids) {
  for (const terminal of vscode.window.terminals) {
    const pid = await terminal.processId;
    if (pid && pids.includes(pid)) return terminal;
  }
  return null;
}

async function handle(cmd) {
  const terminal = await findTerminal(cmd.pids || []);
  if (!terminal) return ack({ id: cmd.id, ok: false }); // not in this window
  if (cmd.type === 'focus') {
    terminal.show(false);
  } else if (cmd.type === 'send') {
    if (cmd.text) terminal.sendText(`${BRACKETED_PASTE[0]}${cmd.text}${BRACKETED_PASTE[1]}`, false);
    terminal.sendText(KEYS[cmd.key || 'enter'] || KEYS.enter, false);
  }
  // Extensions can't raise their own window, so tell the arcade which folder
  // this window has open; it re-opens that folder, which focuses this window.
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  ack({ id: cmd.id, ok: true, folder: folder && folder.uri.scheme === 'file' ? folder.uri.fsPath : null, app: vscode.env.appName });
}

function ack(result) {
  const body = JSON.stringify(result);
  const req = http.request({
    host: '127.0.0.1',
    port: port(),
    path: '/api/ide/ack',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  });
  req.on('error', () => {});
  req.end(body);
}

function activate(context) {
  stopped = false;
  connect();
  context.subscriptions.push({ dispose: deactivate });
}

function deactivate() {
  stopped = true;
  clearTimeout(retryTimer);
  if (request) request.destroy();
}

module.exports = { activate, deactivate };
