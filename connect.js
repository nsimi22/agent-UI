#!/usr/bin/env node
// Connects (or disconnects) Claude Code and Codex to Agent Arcade, so the
// sessions you run in your own terminals report to the arcade.
//
//   node connect.js               connect both
//   node connect.js --disconnect  remove everything this added
//
// Edits are merged into your existing config, a one-time backup is kept next
// to each file, and only entries pointing at /api/hooks/ are ever touched.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PORT = 4321;
const hookUrl = (port, source) => `http://127.0.0.1:${port}/api/hooks/${source}`;
const isOurs = (text) => typeof text === 'string' && /127\.0\.0\.1:\d+\/api\/hooks\/(claude|codex)/.test(text);

// Keeps a copy of your original file, the first time we change it. A file
// that already has our entries isn't "original", so it's never backed up.
function backupOnce(file) {
  const backup = `${file}.arcade-backup`;
  if (!fs.existsSync(file) || fs.existsSync(backup) || isOurs(fs.readFileSync(file, 'utf8'))) return;
  fs.copyFileSync(file, backup);
}

// ---------------------------------------------------------------------------
// Claude Code: ~/.claude/settings.json hooks

const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];

// Posts the hook's JSON (stdin) to the arcade. It prints nothing (hook output
// can end up in the agent's context), gives up after 2s, and never fails.
function hookCommand(port, source) {
  return `curl -s -o /dev/null -m 2 -X POST -H "Content-Type: application/json" --data-binary @- ${hookUrl(port, source)} || true`;
}

function readJsonFile(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`${file} isn't valid JSON (${err.message}); fix it and run this again.`);
  }
}

function writeJsonFile(file, data) {
  backupOnce(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

// Claude Code and Codex share the same hooks layout:
// { "hooks": { "Event": [ { "matcher"?, "hooks": [ { type, command, … } ] } ] } }
function addHooks(file, events, handler) {
  const data = readJsonFile(file);
  const hooks = withoutArcadeHooks(data.hooks);
  for (const event of events) hooks[event] = [...(hooks[event] || []), { hooks: [handler] }];
  writeJsonFile(file, { ...data, hooks });
  return file;
}

function removeHooks(file) {
  if (!fs.existsSync(file)) return null;
  const data = readJsonFile(file);
  if (!hasArcadeHooks(data)) return null;
  const hooks = withoutArcadeHooks(data.hooks);
  const next = { ...data, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  // A file we created (no backup of an original) and left empty goes away.
  if (!Object.keys(next).length && !fs.existsSync(`${file}.arcade-backup`)) fs.unlinkSync(file);
  else fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return file;
}

function hasArcadeHooks(data) {
  return Object.values((data && data.hooks) || {}).some(
    (groups) => Array.isArray(groups) && groups.some((g) => (g.hooks || []).some((h) => isOurs(h.command)))
  );
}

// Drops our hook from every event, leaving everything else as it was.
function withoutArcadeHooks(hooks = {}) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = (Array.isArray(groups) ? groups : [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h.command)) }))
      .filter((g) => g.hooks.length);
    if (kept.length) out[event] = kept;
  }
  return out;
}

const connectClaude = (port = DEFAULT_PORT) =>
  addHooks(CLAUDE_SETTINGS, CLAUDE_EVENTS, { type: 'command', command: hookCommand(port, 'claude'), timeout: 5 });
const disconnectClaude = () => removeHooks(CLAUDE_SETTINGS);

// ---------------------------------------------------------------------------
// Codex: hooks in ~/.codex/hooks.json, plus the legacy `notify` program in
// ~/.codex/config.toml. Codex only runs hooks you've trusted (/hooks in
// Codex); notify needs no trust but only reports finished turns, so it
// covers you until then. The arcade drops notify pings once hooks report.

const CODEX_DIR = path.join(os.homedir(), '.codex');
const CODEX_HOOKS = path.join(CODEX_DIR, 'hooks.json');
const CODEX_CONFIG = path.join(CODEX_DIR, 'config.toml');
const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd'];
const NOTIFY_COMMENT = '# Agent Arcade: report finished turns (npm run disconnect removes this)';

// Codex appends the event JSON as the last argument, which lands right after
// --data-binary. It runs without a shell, so no quoting games.
function notifyLine(port) {
  const argv = ['curl', '-s', '-o', '/dev/null', '-m', '2', '-X', 'POST', '-H', 'Content-Type: application/json', hookUrl(port, 'codex'), '--data-binary'];
  return `notify = [${argv.map((a) => JSON.stringify(a)).join(', ')}]`;
}

// Top-level keys must come before the first [table] header. Returns where
// the top-level section ends (the first table, or the end of the file) and
// where to insert: just after its last non-blank line, so removing our two
// lines later gives back the file exactly as it was.
function topLevelSection(lines) {
  let end = lines.findIndex((l) => /^\s*\[/.test(l));
  if (end === -1) end = lines.length;
  let insertAt = end;
  while (insertAt > 0 && !lines[insertAt - 1].trim()) insertAt--;
  return { end, insertAt };
}

function withoutArcadeNotify(text) {
  return text
    .split('\n')
    .filter((l) => l !== NOTIFY_COMMENT && !(/^\s*notify\s*=/.test(l) && isOurs(l)))
    .join('\n');
}

function connectCodexNotify(port) {
  const text = withoutArcadeNotify(fs.existsSync(CODEX_CONFIG) ? fs.readFileSync(CODEX_CONFIG, 'utf8') : '');
  const lines = text.split('\n');
  const { end, insertAt } = topLevelSection(lines);
  if (lines.slice(0, end).some((l) => /^\s*notify\s*=/.test(l))) return 'kept your existing notify setting';
  lines.splice(insertAt, 0, NOTIFY_COMMENT, notifyLine(port));
  backupOnce(CODEX_CONFIG);
  fs.mkdirSync(CODEX_DIR, { recursive: true });
  fs.writeFileSync(CODEX_CONFIG, lines.join('\n'));
  return `notify added to ${CODEX_CONFIG}`;
}

function disconnectCodexNotify() {
  if (!fs.existsSync(CODEX_CONFIG)) return null;
  const before = fs.readFileSync(CODEX_CONFIG, 'utf8');
  const after = withoutArcadeNotify(before);
  if (after === before) return null;
  fs.writeFileSync(CODEX_CONFIG, after);
  return CODEX_CONFIG;
}

function connectCodex(port = DEFAULT_PORT) {
  addHooks(CODEX_HOOKS, CODEX_EVENTS, { type: 'command', command: hookCommand(port, 'codex'), timeout: 5, async: true });
  return [`hooks added to ${CODEX_HOOKS}`, connectCodexNotify(port)];
}

function disconnectCodex() {
  return [removeHooks(CODEX_HOOKS), disconnectCodexNotify()].filter(Boolean);
}

function codexConnected() {
  try {
    return hasArcadeHooks(readJsonFile(CODEX_HOOKS)) || (fs.existsSync(CODEX_CONFIG) && isOurs(fs.readFileSync(CODEX_CONFIG, 'utf8')));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Everything

function connectAll(port = DEFAULT_PORT) {
  const messages = [
    `Claude Code: hooks added to ${connectClaude(port)}`,
    ...connectCodex(port).map((m) => `Codex: ${m}`),
    'Codex: open codex and run /hooks once to trust the Agent Arcade hooks. Until then you only get "finished" updates.',
  ];
  if (port !== DEFAULT_PORT) messages.push(`Note: the hooks point at port ${port}; keep the arcade on that port.`);
  return { messages };
}

function disconnectAll() {
  const claude = disconnectClaude();
  const codex = disconnectCodex();
  return {
    messages: [
      claude ? `Claude Code: hooks removed from ${claude}` : 'Claude Code: nothing to remove',
      codex.length ? `Codex: removed from ${codex.join(' and ')}` : 'Codex: nothing to remove',
    ],
  };
}

const isConnected = () => hasArcadeHooks(safeRead(CLAUDE_SETTINGS)) || codexConnected();

function safeRead(file) {
  try {
    return readJsonFile(file);
  } catch {
    return {};
  }
}

module.exports = { connectAll, disconnectAll, isConnected, DEFAULT_PORT };

if (require.main === module) {
  try {
    const port = Number(process.env.PORT) || DEFAULT_PORT;
    const { messages } = process.argv.includes('--disconnect') ? disconnectAll() : connectAll(port);
    for (const m of messages) console.log(`  ${m}`);
  } catch (err) {
    console.error(`  ${err.message}`);
    process.exit(1);
  }
}
