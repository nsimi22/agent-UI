// Agent Arcade frontend: live agent pods, a chat drawer per agent, and a bit
// of juice (sounds, confetti, level-ups).

const $ = (sel) => document.querySelector(sel);
const SLEEP_AFTER_MS = 60_000;
const RELAX_AFTER_MS = 12_000;
const IDLE_QUIPS = ['Ready for a quest!', 'Give me something to do 👀', 'Idle hands…', 'Poke me!', 'Standing by ✨', '*hums quietly*'];
const DONE_QUIPS = ['Nailed it!', 'Ta-da! 🎉', 'Quest complete!', 'Easy peasy.'];
const ERROR_QUIPS = ['Oops…', 'That did not go well 😵', 'Help?', 'I blame cosmic rays.'];
const WAITING_QUIPS = ['Need your OK! ✋', 'Psst… over here!', 'Waiting on you 👀'];

const state = {
  agents: new Map(), // id -> agent
  pods: new Map(), // id -> cached pod elements
  transcripts: new Map(), // id -> entries
  bubbles: new Map(), // id -> text
  selected: null,
  sound: readPref('sound', true),
  density: readPref('density', 'auto'), // auto | cozy | compact
  filter: 'all',
  search: '',
};
const AUTO_COMPACT_OVER = 6; // agents
const MAX_TRANSCRIPT = 400; // same cap as the server

function readPref(key, fallback) {
  try {
    const v = localStorage.getItem(`arcade:${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function writePref(key, value) {
  try {
    localStorage.setItem(`arcade:${key}`, JSON.stringify(value));
  } catch {}
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Server status is sticky ("done" stays "done"); the pod relaxes back to idle
// after a short celebration and dozes off when nothing happens for a while.
function displayStatus(a) {
  if (a.status === 'working' || a.status === 'waiting') return a.status;
  if (a.status === 'error') return 'error'; // stays visible until the next run
  const age = Date.now() - a.lastActivity;
  if (age > SLEEP_AFTER_MS) return 'sleep';
  if (a.status !== 'idle' && age > RELAX_AFTER_MS) return 'idle';
  return a.status;
}
const STATUS_LABEL = { idle: 'idle', sleep: 'napping', working: 'working', waiting: 'needs you', done: 'done', error: 'oops' };
const isWatched = (a) => a.kind === 'watch';
const STATUS_CLASSES = Object.keys(STATUS_LABEL).map((s) => `s-${s}`);

// ---------------------------------------------------------------------------
// Rendering the floor

function podFor(id) {
  return state.pods.get(id)?.el;
}

function renderFloor() {
  const floor = $('#floor');
  floor.innerHTML = '';
  state.pods.clear();
  [...state.agents.values()].forEach((a, i) => {
    const pod = document.createElement('article');
    pod.className = 'pod';
    pod.dataset.id = a.id;
    pod.tabIndex = 0;
    pod.setAttribute('role', 'button');
    pod.setAttribute('aria-label', `${a.name}, ${a.role || 'agent'}`);
    pod.innerHTML = `
      ${i < 10 ? `<kbd class="keycap">${(i + 1) % 10}</kbd>` : ''}
      <span class="status"></span>
      <div class="bubble" hidden></div>
      <div class="stage">${critterSVG(a)}<div class="zzz"><span>z</span><span>z</span><span>Z</span></div></div>
      <h3>${escapeHtml(a.name)}</h3>
      <p class="role">${escapeHtml(a.role || '')}</p>
      <div class="meta">
        <span class="lvl"></span>
        <div class="xpbar" title="XP"><i></i></div>
        <span class="timer"></span>
      </div>`;
    pod.addEventListener('click', () => openDrawer(a.id));
    pod.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDrawer(a.id);
      }
    });
    floor.appendChild(pod);
    const q = (sel) => pod.querySelector(sel);
    state.pods.set(a.id, {
      el: pod,
      status: q('.status'),
      bubble: q('.bubble'),
      lvl: q('.lvl'),
      xpbar: q('.xpbar'),
      xpfill: q('.xpbar i'),
      timer: q('.timer'),
    });
    updatePod(a.id);
  });
  const empty = document.createElement('p');
  empty.className = 'floor-empty';
  empty.hidden = true;
  floor.appendChild(empty);
  if (!state.agents.size) {
    floor.insertAdjacentHTML(
      'beforeend',
      `<div class="onboard"><big>🛋️</big><b>The arcade is empty.</b><br/>
        Run <code>npm run connect</code> once (or use <b>Connect Claude Code &amp; Codex</b> in the tray menu),<br/>
        then start <code>claude</code> or <code>codex</code> in a Cursor terminal. Each session shows up here.</div>`
    );
  }
  applyDensity();
  updateSummary();
}

// ---------------------------------------------------------------------------
// Filtering, search, density (for big crews)

function applyFilter() {
  const q = state.search.trim().toLowerCase();
  let shown = 0;
  for (const a of state.agents.values()) {
    const pod = podFor(a.id);
    if (!pod) continue;
    const matches =
      (state.filter === 'all' || a.status === state.filter) &&
      (!q || `${a.name} ${a.role} ${a.id}`.toLowerCase().includes(q));
    pod.hidden = !matches;
    if (matches) shown++;
  }
  const empty = $('#floor .floor-empty');
  if (empty) {
    empty.hidden = shown > 0 || state.agents.size === 0;
    empty.textContent = q ? `No agents match “${state.search.trim()}”.` : 'Nobody here right now.';
  }
}

function setFilter(filter) {
  state.filter = filter;
  document.querySelectorAll('.filter').forEach((b) => b.classList.toggle('active', b.dataset.filter === filter));
  applyFilter();
}

function isCompact() {
  return state.density === 'compact' || (state.density === 'auto' && state.agents.size > AUTO_COMPACT_OVER);
}

function applyDensity() {
  const compact = isCompact();
  $('#floor').classList.toggle('compact', compact);
  $('#densityBtn').setAttribute('aria-pressed', String(compact));
  $('#densityBtn').textContent = compact ? '▦ Compact' : '▢ Cozy';
}

function toggleDensity() {
  state.density = isCompact() ? 'cozy' : 'compact';
  writePref('density', state.density);
  applyDensity();
}

document.querySelectorAll('.filter').forEach((b) => b.addEventListener('click', () => setFilter(b.dataset.filter)));
$('#search').addEventListener('input', (e) => {
  state.search = e.target.value;
  applyFilter();
});
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.target.value = '';
    state.search = '';
    applyFilter();
    e.target.blur();
  } else if (e.key === 'Enter') {
    const first = [...state.agents.values()].find((a) => !podFor(a.id)?.hidden);
    if (first) openDrawer(first.id);
  }
});
$('#densityBtn').addEventListener('click', toggleDensity);

function updatePod(id) {
  const a = state.agents.get(id);
  const p = state.pods.get(id);
  if (!a || !p) return;
  const ds = displayStatus(a);
  p.el.classList.remove(...STATUS_CLASSES);
  p.el.classList.add(`s-${ds}`);
  p.el.classList.toggle('selected', state.selected === id);
  p.status.textContent = STATUS_LABEL[ds];
  p.lvl.textContent = `Lv ${a.stats.level}`;
  p.xpfill.style.width = `${Math.round(a.stats.levelProgress * 100)}%`;
  p.xpbar.title = `${a.stats.xp} XP · ${a.stats.wins} wins · ${a.stats.fails} fails`;
  updateTimer(a);

  const quips = ds === 'done' ? DONE_QUIPS : ds === 'error' ? ERROR_QUIPS : IDLE_QUIPS;
  if (!state.bubbles.has(id) && ds !== 'sleep') state.bubbles.set(id, pick(quips));
  setBubble(id, state.bubbles.get(id) || '');
}

// Only touches the bubble, so streaming output doesn't re-render the pod.
function setBubble(id, text) {
  state.bubbles.set(id, text);
  const p = state.pods.get(id);
  if (!p || p.bubble.textContent === text) return;
  p.bubble.hidden = !text;
  p.bubble.textContent = text;
  // Pop in on mood changes, but not on every line of streaming output.
  if (state.agents.get(id)?.status !== 'working' || text === 'On it! 🏃') {
    p.bubble.style.animation = 'none';
    void p.bubble.offsetWidth; // restart the pop animation
    p.bubble.style.animation = '';
  }
}

function updateTimer(a) {
  const el = state.pods.get(a.id)?.timer;
  if (!el) return;
  if (a.status === 'working' && a.startedAt) {
    const s = Math.floor((Date.now() - a.startedAt) / 1000);
    el.textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}`;
  } else {
    el.textContent = `${a.stats.wins}🏆`;
  }
}

function updateSummary() {
  const all = [...state.agents.values()];
  const working = all.filter((a) => a.status === 'working').length;
  const wins = all.reduce((n, a) => n + a.stats.wins, 0);
  const failed = all.filter((a) => a.status === 'error').length;
  const waiting = all.filter((a) => a.status === 'waiting').length;
  $('#summary').textContent =
    `${all.length} agent${all.length === 1 ? '' : 's'} · ` +
    (working ? `${working} hard at work` : 'everyone is chilling') +
    (waiting ? ` · ${waiting} need${waiting === 1 ? 's' : ''} you` : '') +
    (failed ? ` · ${failed} failed` : '') +
    ` · ${wins} quest${wins === 1 ? '' : 's'} completed`;

  $('#partyBtn').hidden = !all.some((a) => !isWatched(a)); // only arcade-run agents take quests from here
  const counts = { all: all.length, waiting: 0, working: 0, error: 0, done: 0, idle: 0 };
  for (const a of all) counts[a.status]++;
  document.querySelectorAll('.filter').forEach((b) => {
    b.querySelector('b').textContent = counts[b.dataset.filter];
    b.classList.toggle('has', counts[b.dataset.filter] > 0);
  });
  applyFilter();
}

// ---------------------------------------------------------------------------
// Drawer / transcript

async function openDrawer(id) {
  const a = state.agents.get(id);
  if (!a) return;
  const prev = state.selected;
  state.selected = id;
  if (prev) updatePod(prev);
  updatePod(id);
  $('#drawerAvatar').innerHTML = critterSVG(a);
  $('#drawerName').textContent = a.name;
  $('#drawerRole').textContent = a.role || 'Agent';
  $('#drawerCmd').textContent = isWatched(a) ? `watching ${a.command} in ${a.cwd}` : `$ ${a.command}`;
  $('#drawerCmd').title = a.command;
  $('#ideBtn').hidden = !a.ide;
  $('#ideBtn').textContent = `Open in ${a.ide} ↗`;
  $('#ideBtn').title = a.cwd;
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#scrim').classList.add('open');
  updateDrawer();
  if (!state.transcripts.has(id)) {
    // Live entries that arrive while the history loads collect in `live`;
    // merge them after the fetched ones, skipping any the fetch already had.
    const live = [];
    state.transcripts.set(id, live);
    const fetched = await agentApi(id, 'transcript', null, 'GET').catch(() => []);
    const lastSeq = fetched.length ? fetched[fetched.length - 1].seq : 0;
    state.transcripts.set(id, [...fetched, ...live.filter((e) => e.seq > lastSeq)]);
    if (state.selected !== id) return;
  }
  renderTranscript();
  setTimeout(() => $('#prompt').focus(), 250);
}

function closeDrawer() {
  const prev = state.selected;
  state.selected = null;
  if (prev) updatePod(prev);
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').classList.remove('open');
}

function updateDrawer() {
  const a = state.agents.get(state.selected);
  if (!a) return;
  const ds = displayStatus(a);
  $('#drawerAvatar').className = `drawer-avatar s-${ds}`;
  const working = a.status === 'working';
  $('#composer').hidden = isWatched(a);
  $('#watchNote').hidden = !isWatched(a);
  $('#stopBtn').hidden = !working;
  $('#sendBtn').disabled = working;
  $('#clearBtn').disabled = working;
  $('#drawerStats').innerHTML = [
    `Lv ${a.stats.level}`,
    `${a.stats.xp} XP`,
    `🏆 ${a.stats.wins}`,
    `💥 ${a.stats.fails}`,
    `${STATUS_LABEL[ds]}`,
  ]
    .map((t) => `<span class="chip">${t}</span>`)
    .join('');
}

const isOutput = (e) => e.kind === 'out' || e.kind === 'err';

function entryNode(e) {
  const el = document.createElement(isOutput(e) ? 'pre' : 'div');
  el.className = `msg-${e.kind}`;
  // Always give the element a Text node so later chunks can appendData to it.
  el.appendChild(document.createTextNode(isOutput(e) ? e.text : e.text.trim()));
  return el;
}

function renderTranscript() {
  const box = $('#transcript');
  const a = state.agents.get(state.selected);
  const entries = state.transcripts.get(state.selected) || [];
  box.innerHTML = '';
  if (!entries.length) {
    box.innerHTML = `<div class="empty"><big>🗺️</big>No quests yet.<br/>Tell ${escapeHtml(a ? a.name : 'them')} what to do!</div>`;
  }
  // Build everything off-DOM, merging consecutive output chunks, then insert once.
  const frag = document.createDocumentFragment();
  let last = null;
  for (const e of entries) {
    if (isOutput(e) && last && last.kind === e.kind) last.node.firstChild.appendData(e.text);
    else frag.appendChild((last = { kind: e.kind, node: entryNode(e) }).node);
  }
  box.appendChild(frag);
  syncTyping();
  box.scrollTop = box.scrollHeight;
}

function appendEntry(e) {
  const box = $('#transcript');
  if (box.firstElementChild?.classList.contains('empty')) box.firstElementChild.remove();
  const typing = box.lastElementChild?.classList.contains('typing') ? box.lastElementChild : null;
  const last = typing ? typing.previousElementSibling : box.lastElementChild;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;

  // Merge consecutive output chunks into one block.
  if (isOutput(e) && last && last.classList.contains(`msg-${e.kind}`) && last.firstChild) {
    last.firstChild.appendData(e.text);
  } else {
    box.insertBefore(entryNode(e), typing);
  }
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function syncTyping() {
  const box = $('#transcript');
  const a = state.agents.get(state.selected);
  const want = a && a.status === 'working';
  const el = box.querySelector('.typing');
  if (want && !el) {
    const t = document.createElement('div');
    t.className = 'typing';
    t.innerHTML = '<i></i><i></i><i></i>';
    box.appendChild(t);
    box.scrollTop = box.scrollHeight;
  } else if (!want && el) {
    el.remove();
  }
}

// ---------------------------------------------------------------------------
// Actions

async function agentApi(id, action, body, method = 'POST') {
  const res = await fetch(`/api/agents/${encodeURIComponent(id)}/${action}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function sendQuest(id, prompt) {
  try {
    await agentApi(id, 'run', { prompt });
    return true;
  } catch (err) {
    toast(`⚠️ ${err.message}`);
    sfx('error');
    return false;
  }
}

$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const prompt = $('#prompt').value.trim();
  if (!prompt || !state.selected) return;
  if (await sendQuest(state.selected, prompt)) $('#prompt').value = '';
});
$('#prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#composer').requestSubmit();
});
$('#forgetBtn').addEventListener('click', () => agentApi(state.selected, 'forget').catch((e) => toast(e.message)));
for (const action of ['stop', 'clear']) {
  $(`#${action}Btn`).addEventListener('click', () => agentApi(state.selected, action).catch((e) => toast(e.message)));
}
$('#ideBtn').addEventListener('click', async () => {
  const a = state.agents.get(state.selected);
  if (!a) return;
  try {
    await agentApi(a.id, 'open-ide');
    toast(`↗ Opening ${a.name}'s project in ${a.ide}`);
  } catch (err) {
    toast(`⚠️ ${err.message}`);
  }
});
$('#closeDrawer').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);

// Party quest: pick several agents and send them the same prompt.
function renderPicker() {
  $('#picker').innerHTML = [...state.agents.values()]
    .filter((a) => !isWatched(a)) // terminal sessions take input in the terminal
    .map((a) => {
      const busy = a.status === 'working';
      return `<label class="${busy ? 'busy' : ''}" title="${escapeHtml(a.role || a.name)}${busy ? ' (busy)' : ''}">
        <input type="checkbox" value="${escapeHtml(a.id)}" ${busy ? 'disabled' : 'checked'} />
        <span class="dot" style="background:${escapeHtml(a.color || '#a78bfa')}"></span>${escapeHtml(a.name)}</label>`;
    })
    .join('');
  updatePickCount();
}
function pickedIds() {
  return [...$('#picker').querySelectorAll('input:checked')].map((i) => i.value);
}
function updatePickCount() {
  const n = pickedIds().length;
  $('#pickCount').textContent = `${n} selected`;
  $('#partyGo').textContent = n ? `Send to ${n}` : 'Send';
  $('#partyGo').disabled = n === 0;
}
$('#picker').addEventListener('change', updatePickCount);
$('#pickAll').addEventListener('click', () => {
  $('#picker').querySelectorAll('input:not(:disabled)').forEach((i) => (i.checked = true));
  updatePickCount();
});
$('#pickNone').addEventListener('click', () => {
  $('#picker').querySelectorAll('input').forEach((i) => (i.checked = false));
  updatePickCount();
});

$('#partyBtn').addEventListener('click', () => {
  $('#partyPrompt').value = '';
  $('#partyDialog').returnValue = ''; // so Esc isn't mistaken for the previous Send
  renderPicker();
  $('#partyDialog').showModal();
});
$('#partyDialog').addEventListener('close', async () => {
  if ($('#partyDialog').returnValue !== 'go') return;
  const prompt = $('#partyPrompt').value.trim();
  const ids = pickedIds().filter((id) => state.agents.get(id)?.status !== 'working');
  if (!prompt) return;
  if (!ids.length) return toast('Nobody available for that one 🫠');
  toast(`📣 Sent to ${ids.length} agent${ids.length === 1 ? '' : 's'}`);
  await Promise.all(ids.map((id) => sendQuest(id, prompt)));
});

function renderSoundBtn() {
  $('#soundBtn').textContent = state.sound ? '🔊' : '🔇';
  $('#soundBtn').setAttribute('aria-pressed', String(state.sound));
}
function toggleSound() {
  state.sound = !state.sound;
  writePref('sound', state.sound);
  renderSoundBtn();
  if (state.sound) sfx('start');
}
$('#soundBtn').addEventListener('click', toggleSound);
renderSoundBtn();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.selected && !e.target.closest('dialog')) return closeDrawer();
  if (e.target.closest('textarea, input, dialog')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^[0-9]$/.test(e.key)) {
    const a = [...state.agents.values()][e.key === '0' ? 9 : Number(e.key) - 1];
    if (a) openDrawer(a.id);
  } else if (e.key === 'm') toggleSound();
  else if (e.key === 'p') $('#partyBtn').click();
  else if (e.key === 'c') toggleDensity();
  else if (e.key === '/') {
    e.preventDefault();
    $('#search').focus();
  }
});

// ---------------------------------------------------------------------------
// Live events

function connect() {
  const es = new EventSource('/api/events');
  const conn = $('#conn');
  es.onopen = () => {
    conn.classList.add('live');
    conn.querySelector('span').textContent = 'live';
  };
  es.onerror = () => {
    conn.classList.remove('live');
    conn.querySelector('span').textContent = 'reconnecting…';
  };

  es.addEventListener('hello', (ev) => {
    const { agents } = JSON.parse(ev.data);
    state.agents = new Map(agents.map((a) => [a.id, a]));
    state.transcripts.clear();
    renderFloor();
    if (state.selected && state.agents.has(state.selected)) openDrawer(state.selected);
    else if (state.selected) closeDrawer();
  });

  es.addEventListener('agent', (ev) => {
    const a = JSON.parse(ev.data);
    const prev = state.agents.get(a.id);
    state.agents.set(a.id, a);
    if (!prev) {
      renderFloor(); // a new terminal session appeared
      return;
    }
    if (prev.status !== a.status) {
      if (a.status === 'working') {
        state.bubbles.set(a.id, 'On it! 🏃');
        sfx('start');
      } else if (a.status === 'waiting') {
        state.bubbles.set(a.id, a.lastLine || pick(WAITING_QUIPS));
        sfx('waiting');
      } else if (a.status === 'done') {
        state.bubbles.set(a.id, (isWatched(a) && a.lastLine) || pick(DONE_QUIPS));
        sfx('done');
        confettiFrom(podFor(a.id), isWatched(a) ? 35 : 70);
      } else if (a.status === 'error') {
        state.bubbles.set(a.id, pick(ERROR_QUIPS));
        sfx('error');
      } else {
        state.bubbles.delete(a.id);
      }
    }
    updatePod(a.id);
    updateSummary();
    if (state.selected === a.id) {
      updateDrawer();
      syncTyping();
    }
  });

  es.addEventListener('transcript', (ev) => {
    const { id, entry, lastLine } = JSON.parse(ev.data);
    const list = state.transcripts.get(id);
    if (list) {
      list.push(entry);
      if (list.length > MAX_TRANSCRIPT * 1.25) list.splice(0, list.length - MAX_TRANSCRIPT);
    }
    const a = state.agents.get(id);
    if (a) a.lastActivity = entry.t;
    if (lastLine && entry.kind !== 'prompt' && entry.kind !== 'sys') setBubble(id, lastLine);
    if (state.selected === id && list) appendEntry(entry);
  });

  es.addEventListener('removed', (ev) => {
    const { id } = JSON.parse(ev.data);
    state.agents.delete(id);
    state.transcripts.delete(id);
    state.bubbles.delete(id);
    if (state.selected === id) closeDrawer();
    renderFloor();
  });

  es.addEventListener('cleared', (ev) => {
    const { id } = JSON.parse(ev.data);
    state.transcripts.set(id, []);
    state.bubbles.delete(id);
    updatePod(id);
    if (state.selected === id) renderTranscript();
  });

  es.addEventListener('log', (ev) => {
    const { text } = JSON.parse(ev.data);
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    $('#ticker').innerHTML = `<span><time>${time}</time>${escapeHtml(text)}</span>`;
  });

  es.addEventListener('levelup', (ev) => {
    const { id, name, level } = JSON.parse(ev.data);
    toast(`⭐ ${name} reached level ${level}!`, true);
    sfx('levelup');
    confettiFrom(podFor(id), 160);
  });
}

// Timers, sleepiness
setInterval(() => {
  for (const a of state.agents.values()) {
    const pod = podFor(a.id);
    if (!pod) continue;
    if (a.status === 'working') updateTimer(a);
    const want = `s-${displayStatus(a)}`;
    if (!pod.classList.contains(want)) {
      if (want === 's-sleep') state.bubbles.set(a.id, '');
      updatePod(a.id);
      if (state.selected === a.id) updateDrawer();
    }
  }
}, 1000);

// ---------------------------------------------------------------------------
// Juice: toasts, sounds, confetti

function toast(text, big = false) {
  const el = document.createElement('div');
  el.className = `toast${big ? ' big' : ''}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3300);
}

let audio;
function sfx(kind) {
  if (!state.sound) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch {
    return;
  }
  const notes = {
    start: [[523, 0.06], [784, 0.08]],
    done: [[523, 0.08], [659, 0.08], [784, 0.08], [1047, 0.16]],
    error: [[330, 0.12], [247, 0.2]],
    waiting: [[880, 0.08], [660, 0.08], [880, 0.12]],
    levelup: [[523, 0.1], [659, 0.1], [784, 0.1], [1047, 0.1], [784, 0.08], [1047, 0.3]],
  }[kind];
  let t = audio.currentTime;
  for (const [freq, dur] of notes) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = kind === 'error' ? 'sawtooth' : 'square';
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.05, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + dur);
    t += dur * 0.9;
  }
}
// Browsers only allow audio after a user gesture; warm it up on first click.
document.addEventListener('pointerdown', () => { if (state.sound && !audio) sfx('start'); }, { once: true });

const canvas = $('#confetti');
const ctx = canvas.getContext('2d');
let particles = [];
let rafId = null;

function confettiFrom(el, count = 70) {
  if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height * 0.45;
  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
    const speed = 6 + Math.random() * 8;
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      w: 6 + Math.random() * 6,
      h: 4 + Math.random() * 4,
      color: pick(PALETTE),
      life: 0,
    });
  }
  if (!rafId) rafId = requestAnimationFrame(tick);
}

function tick() {
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== innerWidth * dpr || canvas.height !== innerHeight * dpr) {
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  particles = particles.filter((p) => p.life < 140 && p.y < innerHeight + 20);
  for (const p of particles) {
    p.life++;
    p.vy += 0.28;
    p.vx *= 0.985;
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.vr;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - p.life / 140);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx.restore();
  }
  rafId = particles.length ? requestAnimationFrame(tick) : (ctx.clearRect(0, 0, innerWidth, innerHeight), null);
}

connect();

// Hook for the desktop app (clicking a notification opens that agent).
window.arcade = { open: openDrawer };
