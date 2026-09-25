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

function backupOnce(file) {
  const backup = `${file}.arcade-backup`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
}

// ---------------------------------------------------------------------------
// Claude Code: ~/.claude/settings.json hooks

const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];

// Posts the hook's JSON to the arcade. It prints nothing (hook output can end
// up in Claude's context), gives up after 2s, and never fails the hook.
function claudeHookCommand(port) {
  return `curl -s -o /dev/null -m 2 -X POST -H "Content-Type: application/json" --data-binary @- ${hookUrl(port, 'claude')} || true`;
}

function readClaudeSettings() {
  if (!fs.existsSync(CLAUDE_SETTINGS)) return {};
  const text = fs.readFileSync(CLAUDE_SETTINGS, 'utf8');
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`${CLAUDE_SETTINGS} isn't valid JSON (${err.message}); fix it and run this again.`);
  }
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

function connectClaude(port = DEFAULT_PORT) {
  const settings = readClaudeSettings();
  const hooks = withoutArcadeHooks(settings.hooks);
  const command = claudeHookCommand(port);
  for (const event of CLAUDE_EVENTS) {
    hooks[event] = [...(hooks[event] || []), { hooks: [{ type: 'command', command, timeout: 5 }] }];
  }
  backupOnce(CLAUDE_SETTINGS);
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify({ ...settings, hooks }, null, 2) + '\n');
  return CLAUDE_SETTINGS;
}

function disconnectClaude() {
  if (!fs.existsSync(CLAUDE_SETTINGS)) return null;
  const settings = readClaudeSettings();
  if (!settings.hooks) return null;
  const hooks = withoutArcadeHooks(settings.hooks);
  const next = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(next, null, 2) + '\n');
  return CLAUDE_SETTINGS;
}

function claudeConnected() {
  try {
    return Object.values(readClaudeSettings().hooks || {}).some((groups) =>
      groups.some((g) => (g.hooks || []).some((h) => isOurs(h.command)))
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Everything

function connectAll(port = DEFAULT_PORT) {
  const messages = [`Claude Code: hooks added to ${connectClaude(port)}`];
  if (port !== DEFAULT_PORT) messages.push(`Note: hooks point at port ${port}; keep the arcade on that port.`);
  return { messages };
}

function disconnectAll() {
  const file = disconnectClaude();
  return { messages: [file ? `Claude Code: hooks removed from ${file}` : 'Claude Code: nothing to remove'] };
}

const isConnected = () => claudeConnected();

module.exports = { connectAll, disconnectAll, isConnected, connectClaude, disconnectClaude, DEFAULT_PORT };

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
