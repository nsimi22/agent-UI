// Watch mode: Claude Code / Codex sessions running in your own terminals
// report what they're doing to the arcade (via hooks), and show up as agents.
//
// This module turns each tool's events into a few generic actions on a
// "watched" agent: start a turn, note activity, wait for you, finish, end.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { truncate } = require('./util');

const ENDED_TTL_MS = 2 * 60_000; // how long a closed session lingers on the floor
const IDLE_TTL_MS = 6 * 60 * 60_000; // forget sessions that went quiet for hours
const TURN_XP = 10;

const SOURCES = {
  claude: { label: 'Claude Code', command: 'claude' },
  codex: { label: 'Codex', command: 'codex' },
};

// ---------------------------------------------------------------------------
// Hook events → actions
//
// Claude Code and Codex hooks share most event names and fields; each source
// only differs on a few events, handled before falling back to fromHook().

// One short line describing a tool call, e.g. "Bash: npm test".
function describeTool(name, input = {}) {
  const detail = input.command || input.file_path || input.pattern || input.url || input.query || input.description || input.prompt || '';
  return truncate(`${name}${detail ? `: ${String(detail).replace(/\s+/g, ' ')}` : ''}`, 120);
}

function fromHook(e) {
  switch (e.hook_event_name) {
    case 'SessionStart':
      return { action: 'start', note: e.source && e.source !== 'startup' ? `session ${e.source}` : 'session started' };
    case 'UserPromptSubmit':
      return { action: 'turn', prompt: e.prompt || '' };
    case 'PreToolUse':
      return { action: 'activity', text: describeTool(e.tool_name, e.tool_input) };
    case 'PostToolUse':
      return { action: 'activity' }; // e.g. a permission prompt was answered
    case 'Stop':
      return { action: 'finish', reply: e.last_assistant_message || null };
    case 'SessionEnd':
      return { action: 'end' };
    default:
      return null;
  }
}

const WAITING_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);

function fromClaude(e) {
  if (e.hook_event_name === 'Notification') {
    // Claude has been idle for a while. Pressing Esc mid-turn or at a
    // permission prompt sends no Stop, so this is what un-sticks the pod.
    if (e.notification_type === 'idle_prompt') return { action: 'settle' };
    if (WAITING_NOTIFICATIONS.has(e.notification_type) || (!e.notification_type && /permission|waiting/i.test(e.message || ''))) {
      return { action: 'wait', text: e.message || 'Waiting for you' };
    }
    return null;
  }
  if (e.hook_event_name === 'Stop' && !e.last_assistant_message) {
    return { action: 'finish', reply: lastClaudeReply(e.transcript_path) };
  }
  return fromHook(e);
}

// Codex has two channels. Its hooks (which run once you trust them with
// /hooks in Codex) report everything. The legacy `notify` program only
// reports finished turns, with kebab-case keys; it's the fallback until then.
function fromCodex(e) {
  if (e.type === 'agent-turn-complete') {
    return { sessionId: e['thread-id'], cwd: e.cwd, action: 'finish', reply: e['last-assistant-message'] || null, viaNotify: true };
  }
  if (e.hook_event_name === 'PermissionRequest') return { action: 'wait', text: `Approve ${describeTool(e.tool_name, e.tool_input)}?` };
  if (e.hook_event_name === 'Interrupt') return { action: 'interrupt' };
  return fromHook(e);
}

// Best effort: the transcript format is internal to Claude Code, so if it
// changes we simply show no reply text. Only files under ~/.claude are read,
// and only the tail: a small window first, a bigger one if that wasn't enough.
function lastClaudeReply(transcriptPath) {
  try {
    const file = path.resolve(String(transcriptPath));
    if (!file.startsWith(path.join(os.homedir(), '.claude') + path.sep)) return null;
    const { size } = fs.statSync(file);
    for (const window of [32 * 1024, 256 * 1024]) {
      const len = Math.min(size, window);
      const buf = Buffer.allocUnsafe(len);
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"assistant"')) continue; // skip big tool results without parsing them
        let rec;
        try {
          rec = JSON.parse(lines[i]);
        } catch {
          continue; // the partial first line of the window
        }
        const content = rec && rec.type === 'assistant' && rec.message && rec.message.content;
        const text = Array.isArray(content)
          ? content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join('\n').trim()
          : '';
        if (text) return truncate(text, 4000);
      }
      if (len === size) break; // the whole file was read
    }
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Applying actions to agents

function createWatch({ agents, makeAgent, pushTranscript, setStatus, award, broadcast, defaultIde }) {
  const endedAt = new Map(); // agent id -> time the session ended
  const hookedCwds = new Map(); // cwd -> last time a Codex *hook* event came from it
  const notifyStandIns = new Map(); // cwd -> id of the notify-only Codex agent for that folder

  function uniqueName(base) {
    const taken = new Set([...agents.values()].map((a) => a.cfg.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  }

  function sessionAgent(source, act) {
    const id = `${source}:${act.sessionId}`;
    let a = agents.get(id);
    if (a) return a;
    a = makeAgent({
      id,
      source, // marks a watched agent; colour, hat and XP follow source + cwd
      name: uniqueName(path.basename(act.cwd) || 'session'),
      role: SOURCES[source].label, // the name is already the folder; the drawer shows the path
      command: SOURCES[source].command,
      args: [],
      cwd: act.cwd,
      ide: defaultIde,
    });
    agents.set(id, a);
    if (act.viaNotify) notifyStandIns.set(act.cwd, id);
    setStatus(a, 'idle'); // announces the new agent to clients
    return a;
  }

  function apply(source, act) {
    const a = sessionAgent(source, act);
    endedAt.delete(a.cfg.id);
    // A new phase makes the previous bubble text (tool, permission ask) stale.
    if (act.action === 'turn' || act.action === 'finish' || act.action === 'interrupt' || act.action === 'end') a.lastLine = null;
    switch (act.action) {
      case 'start':
        pushTranscript(a, { kind: 'sys', text: `🟢 ${act.note}` });
        break;
      case 'turn':
        a.task = act.prompt;
        a.startedAt = Date.now();
        a.stats.runs += 1;
        if (act.prompt) pushTranscript(a, { kind: 'prompt', text: act.prompt });
        setStatus(a, 'working');
        broadcast('log', { id: a.cfg.id, text: `${a.cfg.name} is on it: “${truncate(act.prompt, 60)}”` });
        break;
      case 'activity':
        if (a.status === 'waiting') a.lastLine = null; // the permission ask was answered
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
        if (act.reply) pushTranscript(a, { kind: 'out', text: `${act.reply}\n` });
        const secs = a.startedAt ? ((Date.now() - a.startedAt) / 1000).toFixed(1) : null;
        pushTranscript(a, { kind: 'sys', text: secs ? `✅ turn finished in ${secs}s` : '✅ turn finished' });
        award(a, { ok: true, xp: TURN_XP });
        setStatus(a, 'done');
        broadcast('log', { id: a.cfg.id, text: `${a.cfg.name} finished a turn${secs ? ` in ${secs}s` : ''}` });
        break;
      }
      case 'settle':
        if (a.status !== 'working' && a.status !== 'waiting') break; // already settled
        a.lastLine = null;
        pushTranscript(a, { kind: 'sys', text: '⏸ stopped; waiting for your next prompt' });
        setStatus(a, 'idle');
        break;
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

  function handle(source, event) {
    if (!SOURCES[source] || !event || typeof event !== 'object') return;
    const mapped = source === 'claude' ? fromClaude(event) : fromCodex(event);
    if (!mapped) return;
    const act = { sessionId: event.session_id, ...mapped };
    act.cwd = act.cwd || event.cwd || os.homedir();
    act.sessionId = act.sessionId || `notify:${act.cwd}`;
    if (source === 'codex') {
      // Once a folder's Codex hooks are reporting, its notify pings are duplicates.
      const hooked = Date.now() - (hookedCwds.get(act.cwd) || 0) < IDLE_TTL_MS;
      if (act.viaNotify && hooked) return;
      if (!act.viaNotify) {
        hookedCwds.set(act.cwd, Date.now());
        const standIn = notifyStandIns.get(act.cwd);
        if (standIn) {
          notifyStandIns.delete(act.cwd);
          if (agents.has(standIn)) remove(standIn); // hooks take over from notify
        }
      }
    }
    apply(source, act);
  }

  const pruneTimer = setInterval(() => {
    const now = Date.now();
    for (const a of agents.values()) {
      if (!a.cfg.source) continue;
      const ended = endedAt.get(a.cfg.id);
      if ((ended && now - ended > ENDED_TTL_MS) || now - a.lastActivity > IDLE_TTL_MS) remove(a.cfg.id);
    }
    for (const [cwd, t] of hookedCwds) if (now - t > IDLE_TTL_MS) hookedCwds.delete(cwd);
  }, 30_000);
  pruneTimer.unref();

  return { handle, remove };
}

module.exports = { createWatch };
