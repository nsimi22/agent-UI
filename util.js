// Small helpers shared by the server, watch mode, connect.js and the desktop app.

const fs = require('fs');
const os = require('os');
const path = require('path');

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// "/Users/me/code/api" -> "~/code/api"
function tildify(p) {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

module.exports = { truncate, tildify, readJson, writeJson };
