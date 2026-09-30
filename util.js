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

// On Windows many CLIs are .cmd/.bat shims (claude.cmd, code.cmd, …) that
// only run through cmd.exe. Escape for cmd.exe the way cross-spawn does:
// quote per the MSVC rules, then caret-escape metacharacters twice, because
// the shim re-parses its arguments when it expands %*. The shim's own path is
// caret-escaped once, so one under "C:\Program Files" still works.
// Returns [program, args] to run with { windowsVerbatimArguments: true }.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdArg(arg) {
  let s = String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  s = `"${s}"`;
  return s.replace(CMD_META, '^$1').replace(CMD_META, '^$1');
}

function viaCmd(file, args) {
  const line = [file.replace(CMD_META, '^$1'), ...args.map(escapeCmdArg)].join(' ');
  return [process.env.comspec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`]];
}

module.exports = { truncate, tildify, readJson, writeJson, viaCmd };
