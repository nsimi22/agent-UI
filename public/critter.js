// Draws a little blob critter. Its mood is driven entirely by CSS classes on
// an ancestor (.s-idle, .s-working, .s-done, .s-error, .s-sleep).

const PALETTE = ['#5eead4', '#fbbf24', '#f472b6', '#a78bfa', '#60a5fa', '#4ade80', '#fb923c', '#f87171'];

function hashString(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

function shade(hex, amt) {
  const n = parseInt(hex.replace('#', ''), 16);
  const c = (v) => Math.max(0, Math.min(255, Math.round(v + (amt > 0 ? (255 - v) * amt : v * amt))));
  const r = c(n >> 16), g = c((n >> 8) & 255), b = c(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// Hat artwork (inner markup only; critterSVG wraps it in <g class="hat">).
const HATS = {
  antenna: (dark) => `<line x1="60" y1="34" x2="60" y2="14" stroke="${dark}" stroke-width="3" stroke-linecap="round"/>
        <circle class="bulb" cx="60" cy="12" r="6"/>`,
  hardhat: () => `<path d="M34 42 Q34 18 60 18 Q86 18 86 42 Z" fill="#facc15" stroke="#a16207" stroke-width="2"/>
        <rect x="28" y="39" width="64" height="7" rx="3.5" fill="#eab308" stroke="#a16207" stroke-width="2"/>
        <rect x="56" y="18" width="8" height="22" rx="3" fill="#fde047"/>`,
  horns: () => `<path d="M40 40 Q30 22 38 12 Q42 26 50 34 Z" fill="#fde68a" stroke="#b45309" stroke-width="2" stroke-linejoin="round"/>
        <path d="M80 40 Q90 22 82 12 Q78 26 70 34 Z" fill="#fde68a" stroke="#b45309" stroke-width="2" stroke-linejoin="round"/>`,
  crown: () => `<path d="M40 38 L38 16 L50 27 L60 12 L70 27 L82 16 L80 38 Z" fill="#fcd34d" stroke="#b45309" stroke-width="2" stroke-linejoin="round"/>
        <circle cx="60" cy="30" r="3.5" fill="#ef4444"/>`,
  wizard: () => `<path d="M34 40 L64 2 L86 40 Z" fill="#6d28d9" stroke="#3b0764" stroke-width="2" stroke-linejoin="round"/>
        <ellipse cx="60" cy="40" rx="32" ry="6" fill="#7c3aed" stroke="#3b0764" stroke-width="2"/>
        <text x="58" y="30" font-size="12" text-anchor="middle">⭐</text>`,
  headphones: () => `<path d="M28 62 Q28 22 60 22 Q92 22 92 62" fill="none" stroke="#1f2937" stroke-width="6" stroke-linecap="round"/>
        <rect x="20" y="54" width="14" height="22" rx="6" fill="#ef4444" stroke="#1f2937" stroke-width="2"/>
        <rect x="86" y="54" width="14" height="22" rx="6" fill="#ef4444" stroke="#1f2937" stroke-width="2"/>`,
  cap: () => `<path d="M36 42 Q36 20 60 20 Q84 20 84 42 Z" fill="#2563eb" stroke="#1e3a8a" stroke-width="2"/>
        <path d="M78 40 Q100 38 102 46 L80 46 Z" fill="#1d4ed8" stroke="#1e3a8a" stroke-width="2" stroke-linejoin="round"/>
        <circle cx="60" cy="20" r="3" fill="#1e3a8a"/>`,
  bow: () => `<path d="M60 30 L44 20 L44 40 Z M60 30 L76 20 L76 40 Z" fill="#fb7185" stroke="#9f1239" stroke-width="2" stroke-linejoin="round"/>
        <circle cx="60" cy="30" r="5" fill="#e11d48" stroke="#9f1239" stroke-width="2"/>`,
};

function critterSVG(agent) {
  const h = hashString(agent.id);
  const color = agent.color || PALETTE[h % PALETTE.length];
  const names = Object.keys(HATS);
  const hat = agent.hat || names[(h >> 3) % names.length];
  const dark = shade(color, -0.4);
  const light = shade(color, 0.45);
  return `
<svg class="critter" viewBox="0 0 120 124" role="img" aria-label="${agent.name}">
  <ellipse class="shadow" cx="60" cy="116" rx="30" ry="5"/>
  <g class="bodyg">
    <g class="arm arm-l"><ellipse cx="26" cy="80" rx="8" ry="11" fill="${color}" stroke="${dark}" stroke-width="2.5"/></g>
    <g class="arm arm-r"><ellipse cx="94" cy="80" rx="8" ry="11" fill="${color}" stroke="${dark}" stroke-width="2.5"/></g>
    <rect x="26" y="34" width="68" height="76" rx="34" fill="${color}" stroke="${dark}" stroke-width="3"/>
    <ellipse cx="60" cy="88" rx="22" ry="16" fill="${light}" opacity=".7"/>
    <g class="face">
      <g class="eyes open">
        <circle cx="47" cy="64" r="8" fill="#fff" stroke="${dark}" stroke-width="2"/>
        <circle cx="73" cy="64" r="8" fill="#fff" stroke="${dark}" stroke-width="2"/>
        <circle class="pupil" cx="48" cy="65" r="4" fill="#111827"/>
        <circle class="pupil" cx="74" cy="65" r="4" fill="#111827"/>
        <circle cx="49.5" cy="63" r="1.4" fill="#fff"/>
        <circle cx="75.5" cy="63" r="1.4" fill="#fff"/>
      </g>
      <g class="eyes happy" fill="none" stroke="#111827" stroke-width="3" stroke-linecap="round">
        <path d="M40 66 Q47 57 54 66"/><path d="M66 66 Q73 57 80 66"/>
      </g>
      <g class="eyes dizzy" stroke="#111827" stroke-width="3" stroke-linecap="round">
        <path d="M42 59 L52 69 M52 59 L42 69"/><path d="M68 59 L78 69 M78 59 L68 69"/>
      </g>
      <g class="eyes sleepy" fill="none" stroke="#111827" stroke-width="3" stroke-linecap="round">
        <path d="M40 65 Q47 70 54 65"/><path d="M66 65 Q73 70 80 65"/>
      </g>
      <circle cx="38" cy="76" r="4.5" fill="#fb7185" opacity=".45"/>
      <circle cx="82" cy="76" r="4.5" fill="#fb7185" opacity=".45"/>
      <path class="mouth m-idle" d="M54 78 Q60 83 66 78" fill="none" stroke="#111827" stroke-width="2.5" stroke-linecap="round"/>
      <path class="mouth m-working" d="M55 80 L65 80" fill="none" stroke="#111827" stroke-width="2.5" stroke-linecap="round"/>
      <path class="mouth m-done" d="M51 76 Q60 90 69 76 Z" fill="#7f1d1d" stroke="#111827" stroke-width="2" stroke-linejoin="round"/>
      <path class="mouth m-error" d="M53 84 Q60 77 67 84" fill="none" stroke="#111827" stroke-width="2.5" stroke-linecap="round"/>
      <ellipse class="mouth m-sleep" cx="60" cy="81" rx="3" ry="3.5" fill="#7f1d1d"/>
    </g>
    ${HATS[hat] ? `<g class="hat">${HATS[hat](dark)}</g>` : ''}
  </g>
  <g class="laptop">
    <path d="M36 104 L84 104 L90 114 L30 114 Z" fill="#94a3b8" stroke="#334155" stroke-width="2" stroke-linejoin="round"/>
    <rect x="40" y="86" width="40" height="19" rx="2" fill="#1e293b" stroke="#334155" stroke-width="2"/>
    <rect class="screen" x="43" y="89" width="34" height="13" rx="1"/>
  </g>
  <g class="sweat"><path d="M92 44 Q96 52 92 55 Q88 52 92 44 Z" fill="#7dd3fc" stroke="#0369a1" stroke-width="1.2"/></g>
</svg>`;
}

window.critterSVG = critterSVG;
