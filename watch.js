// Watch mode: Claude Code / Codex sessions running in your own terminals
// report what they're doing to the arcade (via hooks), and show up as agents.
//
// This module turns each tool's events into a few generic actions on a
// "watched" agent: start a turn, note activity, wait for you, finish, end.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ENDED_TTL_MS = 2 * 60_000; // how long a closed session lingers on the floor
const IDLE_TTL_MS = 6 * 60 * 60_000; // forget sessions that went quiet for hours
const TURN_XP = 10;

const SOURCES = {
  claude: { label: 'Claude Code', command: 'claude' },
  codex: { label: 'Codex', command: 'codex' },
};

// ---------------------------------------------------------------------------
// Claude Code hooks → actions

// One short line describing a tool call, e.g. "Bash: npm test".
function describeTool(name, input = {}) {
  const detail = input.command || input.file_path || input.pattern || input.url || input.query || input.description || input.prompt || '';
  const text = `${name}${detail ? `: ${String(detail).replace(/\s+/g, ' ')}` : ''}`;
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

const WAITING_NOTIFICATIONS = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
]);

function fromClaude(e) {
  const base = { sessionId: e.session_id, cwd: e.cwd };
  switch (e.hook_event_name) {
    case 'SessionStart':
      return { ...base, action: 'start', note: e.source && e.source !== 'startup' ? `session ${e.source}` : 'session started' };
    case 'UserPromptSubmit':
      return { ...base, action: 'turn', prompt: e.prompt || '' };
    case 'PreToolUse':
      return { ...base, action: 'activity', text: describeTool(e.tool_name, e.tool_input) };
    case 'PostToolUse':
      return { ...base, action: 'activity' }; // a permission prompt was answered
    case 'Notification':
      if (WAITING_NOTIFICATIONS.has(e.notification_type) || (!e.notification_type && /permission|waiting/i.test(e.message || ''))) {
        return { ...base, action: 'wait', text: e.message || 'Waiting for you' };
      }
      return null;
    case 'Stop':
      return { ...base, action: 'finish', reply: lastClaudeReply(e.transcript_path) };
    case 'SessionEnd':
      return { ...base, action: 'end' };
    default:
      return null;
  }
}

// Best effort: the transcript format is internal to Claude Code, so if it
// changes we simply show no reply text. Only files under ~/.claude are read.
function lastClaudeReply(transcriptPath) {
  try {
    const file = path.resolve(String(transcriptPath));
    if (!file.startsWith(path.join(os.homedir(), '.claude') + path.sep)) return null;
    const { size } = fs.statSync(file);
    const len = Math.min(size, 256 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let rec;
      try {
        rec = JSON.parse(lines[i]);
      } catch {
        continue; // partial first line, or not JSON
      }
      const content = rec && rec.type === 'assistant' && rec.message && rec.message.content;
      const text = Array.isArray(content)
        ? content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join('\n').trim()
        : '';
      if (text) return text.length > 4000 ? `${text.slice(0, 3999)}…` : text;
    }
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Codex → actions
//
// Codex has two channels. Its hooks (same shape as Claude Code's, and they
// run once you trust them with /hooks in Codex) report everything. The
// legacy `notify` program only reports finished turns, with kebab-case keys;
// it's the fallback until the hooks are trusted.

function fromCodex(e) {
  if (e.type === 'agent-turn-complete') {
    const cwd = e.cwd || null;
    return {
      sessionId: e['thread-id'] || `notify:${cwd || 'codex'}`,
      cwd,
      action: 'finish',
      reply: e['last-assistant-message'] || null,
      viaNotify: true,
    };
  }
  const base = { sessionId: e.session_id, cwd: e.cwd };
  switch (e.hook_event_name) {
    case 'SessionStart':
      return { ...base, action: 'start', note: e.source && e.source !== 'startup' ? `session ${e.source}` : 'session started' };
    case 'UserPromptSubmit':
      return { ...base, action: 'turn', prompt: e.prompt || '' };
    case 'PreToolUse':
      return { ...base, action: 'activity', text: describeTool(e.tool_name, e.tool_input) };
    case 'PermissionRequest':
      return { ...base, action: 'wait', text: `Approve ${describeTool(e.tool_name, e.tool_input)}?` };
    case 'PostToolUse':
      return { ...base, action: 'activity' };
    case 'Stop':
      return { ...base, action: 'finish', reply: e.last_assistant_message || null };
    case 'Interrupt':
      return { ...base, action: 'interrupt' };
    case 'SessionEnd':
      return { ...base, action: 'end' };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Applying actions to agents

function createWatch(arcade) {
  const { agents, makeAgent, pushTranscript, setStatus, award, broadcast, defaultIde } = arcade;
  const endedAt = new Map(); // agent id -> time the session ended
  const hookedCwds = new Map(); // cwd -> last time a Codex *hook* event came from it

  function uniqueName(base, id) {
    const taken = new Set([...agents.values()].filter((a) => a.cfg.id !== id).map((a) => a.cfg.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  }

  function sessionAgent(source, act) {
    const { sessionId, cwd } = act;
    const id = `${source}:${sessionId}`;
    let a = agents.get(id);
    if (a) return a;
    const dir = cwd || os.homedir();
    const home = os.homedir();
    const where = dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir;
    a = makeAgent({
      id,
      kind: 'watch',
      source,
      name: uniqueName(path.basename(dir) || 'session', id),
      role: SOURCES[source].label, // the name is already the folder; the drawer shows the full path
      where,
      command: SOURCES[source].command,
      args: [],
      cwd: dir,
      ide: defaultIde(),
      // Colour, hat and XP follow the project, not the individual session.
      hashKey: `${source}:${dir}`,
      statsKey: `watch:${source}:${dir}`,
      viaNotify: Boolean(act.viaNotify),
    });
    agents.set(id, a);
    setStatus(a, 'idle'); // announces the new agent to clients
    return a;
  }

  function apply(source, act) {
    const a = sessionAgent(source, act);
    endedAt.delete(a.cfg.id);
    switch (act.action) {
      case 'start':
        pushTranscript(a, { kind: 'sys', text: `🟢 ${act.note}` });
        break;
      case 'turn':
        a.task = act.prompt;
        a.lastLine = null;
        a.startedAt = Date.now();
        a.stats.runs += 1;
        if (act.prompt) pushTranscript(a, { kind: 'prompt', text: act.prompt });
        setStatus(a, 'working');
        broadcast('log', { id: a.cfg.id, text: `${a.cfg.name} is on it: “${act.prompt.slice(0, 60)}”` });
        break;
      case 'activity':
        if (a.status === 'waiting') a.lastLine = null; // the "needs your permission" text is stale now
        if (act.text) pushTranscript(a, { kind: 'tool', text: `🔧 ${act.text}` }, act.text);
        if (a.status !== 'working') {
          a.startedAt = a.startedAt || Date.now();
          setStatus(a, 'working');
        }
        break;
      case 'wait':
        pushTranscript(a, { kind: 'sys', text: `⏳ ${act.text}` }, act.text);
        setStatus(a, 'waiting');
        broadcast('log', { id: a.cfg.id, text: `${a.cfg.name} needs you: ${act.text}` });
        break;
      case 'finish': {
        a.lastLine = null; // the reply's last line, if we have one, replaces tool/wait text
        if (act.reply) pushTranscript(a, { kind: 'out', text: `${act.reply}\n` });
        const secs = a.startedAt ? ((Date.now() - a.startedAt) / 1000).toFixed(1) : null;
        pushTranscript(a, { kind: 'sys', text: secs ? `✅ turn finished in ${secs}s` : '✅ turn finished' });
        award(a, { ok: true, xp: TURN_XP });
        setStatus(a, 'done');
        broadcast('log', { id: a.cfg.id, text: `${a.cfg.name} finished a turn${secs ? ` in ${secs}s` : ''}` });
        break;
      }
      case 'interrupt':
        pushTranscript(a, { kind: 'sys', text: '⏹ interrupted' });
        setStatus(a, 'idle');
        break;
      case 'end':
        pushTranscript(a, { kind: 'sys', text: '👋 session ended' });
        endedAt.set(a.cfg.id, Date.now());
        setStatus(a, 'idle');
        break;
    }
  }

  function remove(id) {
    agents.delete(id);
    endedAt.delete(id);
    broadcast('removed', { id });
  }

  // Returns true if the event was understood.
  function handle(source, event) {
    if (!SOURCES[source] || !event || typeof event !== 'object') return false;
    const act = source === 'claude' ? fromClaude(event) : fromCodex(event);
    if (!act || !act.sessionId) return false;
    if (source === 'codex') {
      // Once a folder's Codex hooks are reporting, its notify pings are duplicates.
      if (act.viaNotify) {
        if (Date.now() - (hookedCwds.get(act.cwd) || 0) < IDLE_TTL_MS) return false;
      } else {
        hookedCwds.set(act.cwd, Date.now());
        // Retire the notify-only stand-in for this folder.
        for (const a of [...agents.values()]) {
          if (a.cfg.source === 'codex' && a.cfg.viaNotify && a.cfg.cwd === (act.cwd || os.homedir())) remove(a.cfg.id);
        }
      }
    }
    apply(source, act);
    return true;
  }

  const pruneTimer = setInterval(() => {
    const now = Date.now();
    for (const a of agents.values()) {
      if (a.cfg.kind !== 'watch') continue;
      const ended = endedAt.get(a.cfg.id);
      if ((ended && now - ended > ENDED_TTL_MS) || now - a.lastActivity > IDLE_TTL_MS) remove(a.cfg.id);
    }
  }, 30_000);
  pruneTimer.unref();

  return { handle, remove };
}

module.exports = { createWatch, SOURCES };
