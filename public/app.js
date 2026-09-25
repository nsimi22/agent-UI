// Agent Arcade frontend: live agent pods, a chat drawer per agent, and a bit
// of juice (sounds, confetti, level-ups).

const $ = (sel) => document.querySelector(sel);
const SLEEP_AFTER_MS = 60_000;
const RELAX_AFTER_MS = 12_000;
const IDLE_QUIPS = ['Ready for a quest!', 'Give me something to do 👀', 'Idle hands…', 'Poke me!', 'Standing by ✨', '*hums quietly*'];
const DONE_QUIPS = ['Nailed it!', 'Ta-da! 🎉', 'Quest complete!', 'Easy peasy.'];
const ERROR_QUIPS = ['Oops…', 'That did not go well 😵', 'Help?', 'I blame cosmic rays.'];

const state = {
  agents: new Map(), // id -> agent
  transcripts: new Map(), // id -> entries
  bubbles: new Map(), // id -> text
  selected: null,
  sound: readPref('sound', true),
};

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
  if (a.status === 'working') return 'working';
  const age = Date.now() - a.lastActivity;
  if (age > SLEEP_AFTER_MS) return 'sleep';
  if (a.status !== 'idle' && age > RELAX_AFTER_MS) return 'idle';
  return a.status;
}
const STATUS_LABEL = { idle: 'idle', sleep: 'napping', working: 'working', done: 'done', error: 'oops' };

// ---------------------------------------------------------------------------
// Rendering the floor

function podFor(id) {
  return document.querySelector(`.pod[data-id="${CSS.escape(id)}"]`);
}

function renderFloor() {
  const floor = $('#floor');
  floor.innerHTML = '';
  [...state.agents.values()].forEach((a, i) => {
    const pod = document.createElement('article');
    pod.className = 'pod';
    pod.dataset.id = a.id;
    pod.tabIndex = 0;
    pod.setAttribute('role', 'button');
    pod.setAttribute('aria-label', `${a.name}, ${a.role || 'agent'}`);
    pod.innerHTML = `
      ${i < 9 ? `<kbd class="keycap">${i + 1}</kbd>` : ''}
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
    updatePod(a.id);
  });
  updateSummary();
}

function updatePod(id) {
  const a = state.agents.get(id);
  const pod = podFor(id);
  if (!a || !pod) return;
  const ds = displayStatus(a);
  pod.classList.remove('s-idle', 's-sleep', 's-working', 's-done', 's-error');
  pod.classList.add(`s-${ds}`);
  pod.classList.toggle('selected', state.selected === id);
  pod.querySelector('.status').textContent = STATUS_LABEL[ds];
  pod.querySelector('.lvl').textContent = `Lv ${a.stats.level}`;
  pod.querySelector('.xpbar i').style.width = `${Math.round(a.stats.levelProgress * 100)}%`;
  pod.querySelector('.xpbar').title = `${a.stats.xp} XP · ${a.stats.wins} wins · ${a.stats.fails} fails`;
  updateTimer(a, pod);

  const bubble = pod.querySelector('.bubble');
  const quips = ds === 'done' ? DONE_QUIPS : ds === 'error' ? ERROR_QUIPS : IDLE_QUIPS;
  const text = state.bubbles.has(id) ? state.bubbles.get(id) : ds === 'sleep' ? '' : pick(quips);
  if (!state.bubbles.has(id) && ds !== 'sleep') state.bubbles.set(id, text);
  bubble.hidden = !text;
  if (bubble.textContent !== text) {
    bubble.textContent = text;
    bubble.style.animation = 'none';
    void bubble.offsetWidth; // restart pop animation
    bubble.style.animation = '';
  }
}

function updateTimer(a, pod = podFor(a.id)) {
  const el = pod && pod.querySelector('.timer');
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
  $('#summary').textContent =
    `${all.length} agent${all.length === 1 ? '' : 's'} · ` +
    (working ? `${working} hard at work` : 'everyone is chilling') +
    ` · ${wins} quest${wins === 1 ? '' : 's'} completed`;
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
  $('#drawerCmd').textContent = `$ ${a.command}`;
  $('#drawerCmd').title = a.command;
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#scrim').classList.add('open');
  updateDrawer();
  if (!state.transcripts.has(id)) {
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(id)}/transcript`);
      state.transcripts.set(id, await res.json());
    } catch {
      state.transcripts.set(id, []);
    }
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

function renderTranscript() {
  const box = $('#transcript');
  const a = state.agents.get(state.selected);
  const entries = state.transcripts.get(state.selected) || [];
  box.innerHTML = '';
  if (!entries.length) {
    box.innerHTML = `<div class="empty"><big>🗺️</big>No quests yet.<br/>Tell ${escapeHtml(a ? a.name : 'them')} what to do!</div>`;
  }
  for (const e of entries) appendEntry(e, false);
  syncTyping();
  box.scrollTop = box.scrollHeight;
}

function appendEntry(e, scroll = true) {
  const box = $('#transcript');
  box.querySelector('.empty')?.remove();
  const typing = box.querySelector('.typing');
  const last = typing ? typing.previousElementSibling : box.lastElementChild;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;

  // Merge consecutive output chunks into one block.
  if ((e.kind === 'out' || e.kind === 'err') && last && last.classList.contains(`msg-${e.kind}`)) {
    last.textContent += e.text;
  } else {
    const el = document.createElement(e.kind === 'out' || e.kind === 'err' ? 'pre' : 'div');
    el.className = `msg-${e.kind}`;
    el.textContent = e.kind === 'out' || e.kind === 'err' ? e.text : e.text.trim();
    box.insertBefore(el, typing);
  }
  if (scroll && nearBottom) box.scrollTop = box.scrollHeight;
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

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function sendQuest(id, prompt) {
  try {
    await api(`/api/agents/${encodeURIComponent(id)}/run`, { prompt });
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
$('#stopBtn').addEventListener('click', () => api(`/api/agents/${encodeURIComponent(state.selected)}/stop`).catch((e) => toast(e.message)));
$('#clearBtn').addEventListener('click', () => api(`/api/agents/${encodeURIComponent(state.selected)}/clear`).catch((e) => toast(e.message)));
$('#closeDrawer').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);

$('#partyBtn').addEventListener('click', () => {
  $('#partyPrompt').value = '';
  $('#partyDialog').showModal();
});
$('#partyDialog').addEventListener('close', async () => {
  if ($('#partyDialog').returnValue !== 'go') return;
  const prompt = $('#partyPrompt').value.trim();
  const idle = [...state.agents.values()].filter((a) => a.status !== 'working');
  if (!prompt) return;
  if (!idle.length) return toast('Everyone is busy! 🫠');
  toast(`📣 Sent to ${idle.length} agent${idle.length === 1 ? '' : 's'}`);
  await Promise.all(idle.map((a) => sendQuest(a.id, prompt)));
});

$('#soundBtn').addEventListener('click', toggleSound);
function toggleSound() {
  state.sound = !state.sound;
  writePref('sound', state.sound);
  $('#soundBtn').textContent = state.sound ? '🔊' : '🔇';
  $('#soundBtn').setAttribute('aria-pressed', String(state.sound));
  if (state.sound) sfx('start');
}
$('#soundBtn').textContent = state.sound ? '🔊' : '🔇';
$('#soundBtn').setAttribute('aria-pressed', String(state.sound));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.selected && !e.target.closest('dialog')) return closeDrawer();
  if (e.target.closest('textarea, input, dialog')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^[1-9]$/.test(e.key)) {
    const a = [...state.agents.values()][Number(e.key) - 1];
    if (a) openDrawer(a.id);
  } else if (e.key === 'm') toggleSound();
  else if (e.key === 'p') $('#partyBtn').click();
});

// ---------------------------------------------------------------------------
// Live events

function lastLine(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
}

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
    if (prev && prev.status !== a.status) {
      if (a.status === 'working') {
        state.bubbles.set(a.id, 'On it! 🏃');
        sfx('start');
      } else if (a.status === 'done') {
        state.bubbles.set(a.id, pick(DONE_QUIPS));
        sfx('done');
        confettiFrom(podFor(a.id));
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
    const { id, entry } = JSON.parse(ev.data);
    const list = state.transcripts.get(id);
    if (list) list.push(entry);
    const a = state.agents.get(id);
    if (a) a.lastActivity = entry.t;
    if (entry.kind === 'out' || entry.kind === 'err') {
      const line = lastLine(entry.text);
      if (line) {
        state.bubbles.set(id, line);
        updatePod(id);
      }
    }
    if (state.selected === id && list) appendEntry(entry);
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
    const { id, level } = JSON.parse(ev.data);
    const a = state.agents.get(id);
    toast(`⭐ ${a ? a.name : id} reached level ${level}!`, true);
    sfx('levelup');
    confettiFrom(podFor(id), 160);
  });
}

// Timers, sleepiness
setInterval(() => {
  for (const a of state.agents.values()) {
    const pod = podFor(a.id);
    if (!pod) continue;
    if (a.status === 'working') updateTimer(a, pod);
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
const COLORS = ['#f472b6', '#fbbf24', '#5eead4', '#a78bfa', '#60a5fa', '#4ade80'];

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
      color: pick(COLORS),
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
