// Agent Arcade desktop app: runs the arcade server in-process, shows it in a
// native window, and adds a tray icon + system notifications.

const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, nativeTheme, shell, dialog } = require('electron');
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const arcade = require('../server');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(__dirname, 'assets');
const PREFERRED_PORT = 4321;
const IS_MAC = process.platform === 'darwin';

let win = null;
let tray = null;
let instance = null; // what arcade.start() resolved with
let quitting = false;
const settings = loadSettings();
const lastLine = new Map(); // agent id -> latest output line, for notification text
const lastStatus = new Map();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(boot);
}

// ---------------------------------------------------------------------------
// Settings & config locations

function settingsFile() {
  return path.join(app.getPath('userData'), 'desktop-settings.json');
}

function loadSettings() {
  try {
    return { notifications: true, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return { notifications: true };
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

// Running from a checkout uses the repo's agents.local.json / agents.json and
// ./data, like `npm start`. The installed app keeps its own copy of the config
// in the user-data folder so it can be edited without touching the app bundle.
function arcadePaths() {
  if (!app.isPackaged) return {};
  const dataDir = app.getPath('userData');
  const configPath = path.join(dataDir, 'agents.json');
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'agents.json'), configPath);
  }
  return { dataDir, configPath };
}

// ---------------------------------------------------------------------------
// Boot

// Apps launched from the Dock/Finder/start menu get a bare-bones PATH, so
// agent CLIs (claude, aider, …) and editor launchers (cursor, code, idea, …)
// wouldn't be found. Borrow the PATH from the user's login shell instead.
function adoptShellPath() {
  if (process.platform === 'win32') return;
  const shellBin = process.env.SHELL || (IS_MAC ? '/bin/zsh' : '/bin/bash');
  try {
    const out = execFileSync(shellBin, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/__PATH__(.*)__PATH__/);
    if (m && m[1]) {
      const merged = new Set([...m[1].split(':'), ...(process.env.PATH || '').split(':')].filter(Boolean));
      process.env.PATH = [...merged].join(':');
    }
  } catch {
    // Keep the PATH we have; agents with absolute command paths still work.
  }
}

async function boot() {
  nativeTheme.themeSource = 'dark'; // dark title bar, menus and dialogs everywhere
  adoptShellPath();
  const base = { ...arcadePaths(), nodeBinary: process.execPath, defaultCwd: app.getPath('home') };
  try {
    try {
      instance = await arcade.start({ ...base, port: PREFERRED_PORT });
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      instance = await arcade.start({ ...base, port: 0 }); // something else has 4321
    }
  } catch (err) {
    dialog.showErrorBox('Agent Arcade could not start', `${err.message}\n\nCheck your agents config and try again.`);
    app.exit(1);
    return;
  }

  for (const a of instance.snapshot()) lastStatus.set(a.id, a.status);
  instance.bus.on('agent', onAgent);
  instance.bus.on('transcript', onTranscript);
  instance.bus.on('levelup', onLevelUp);

  if (IS_MAC) app.dock.setIcon(path.join(ASSETS, 'icon.png'));
  createTray();
  createWindow();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 380,
    minHeight: 500,
    title: 'Agent Arcade',
    icon: path.join(ASSETS, 'icon.png'),
    backgroundColor: '#120f24',
    show: false,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadURL(instance.url);
  win.once('ready-to-show', () => win.show());

  // Links open in the real browser; the window itself never leaves the arcade.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(instance.url)) e.preventDefault();
  });

  // Closing the window keeps agents running in the tray; quit from the tray menu.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!IS_MAC && !settings.hintedTray) {
      settings.hintedTray = true;
      saveSettings();
      notify('Agent Arcade is still running', 'Your agents keep working in the tray. Quit from the tray menu.');
    }
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function openAgent(id) {
  showWindow();
  win.webContents.executeJavaScript(`window.arcade && window.arcade.open(${JSON.stringify(id)})`).catch(() => {});
}

app.on('activate', showWindow);
app.on('before-quit', () => {
  quitting = true;
  if (instance) instance.stopAll();
});
app.on('window-all-closed', () => {
  // Stay alive in the tray.
});

// ---------------------------------------------------------------------------
// Tray

function trayImage(busy) {
  if (IS_MAC) {
    const img = nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(path.join(ASSETS, busy ? 'tray-busy.png' : 'tray.png'));
}

function createTray() {
  tray = new Tray(trayImage(false));
  tray.on('click', () => (IS_MAC ? null : win && win.isVisible() && win.isFocused() ? win.hide() : showWindow()));
  refreshTray();
}

const STATUS_ICON = { idle: '💤', working: '⚙️', done: '✅', error: '💥' };

function refreshTray() {
  if (!tray || !instance) return;
  const agents = instance.snapshot();
  const working = agents.filter((a) => a.status === 'working');

  tray.setImage(trayImage(working.length > 0));
  tray.setToolTip(working.length ? `Agent Arcade: ${working.length} working` : 'Agent Arcade: all idle');
  if (IS_MAC) tray.setTitle(working.length ? ` ${working.length}` : '');
  app.setBadgeCount(working.length);

  const menu = Menu.buildFromTemplate([
    { label: 'Show Agent Arcade', click: showWindow },
    { type: 'separator' },
    { label: working.length ? `${working.length} of ${agents.length} working` : `${agents.length} agents, all idle`, enabled: false },
    ...agents.map((a) => ({
      label: `${STATUS_ICON[a.status] || '•'}  ${a.name}  ·  Lv ${a.stats.level}`,
      sublabel: a.status === 'working' && a.task ? a.task.slice(0, 60) : a.role || undefined,
      click: () => openAgent(a.id),
    })),
    { type: 'separator' },
    {
      label: 'Notifications',
      type: 'checkbox',
      checked: settings.notifications,
      click: (item) => {
        settings.notifications = item.checked;
        saveSettings();
      },
    },
    ...(IS_MAC || process.platform === 'win32'
      ? [
          {
            label: 'Open at login',
            type: 'checkbox',
            checked: app.getLoginItemSettings().openAtLogin,
            click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
          },
        ]
      : []),
    { label: 'Edit agents…', click: () => shell.openPath(instance.configPath) },
    {
      label: 'Reload agents (restarts app)',
      click: () => {
        app.relaunch();
        app.quit();
      },
    },
    { type: 'separator' },
    { label: 'Quit Agent Arcade', accelerator: IS_MAC ? 'Cmd+Q' : undefined, click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

let trayTimer = null;
function refreshTraySoon() {
  clearTimeout(trayTimer);
  trayTimer = setTimeout(refreshTray, 150);
}

// ---------------------------------------------------------------------------
// Events -> notifications

function onAgent(a) {
  const prev = lastStatus.get(a.id);
  lastStatus.set(a.id, a.status);
  refreshTraySoon();
  if (prev !== 'working' || (a.status !== 'done' && a.status !== 'error')) return;

  const line = lastLine.get(a.id);
  if (a.status === 'done') notify(`${a.name} finished 🎉`, line || a.task || 'Quest complete!', a.id);
  else notify(`${a.name} hit a snag 😵`, line || 'The run failed. Open it to see what happened.', a.id);
}

function onTranscript({ id, entry }) {
  if (entry.kind !== 'out' && entry.kind !== 'err') return;
  const lines = entry.text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length) lastLine.set(id, lines[lines.length - 1].slice(0, 180));
}

function onLevelUp({ id, level }) {
  const a = instance.snapshot().find((x) => x.id === id);
  notify(`⭐ ${a ? a.name : id} reached level ${level}!`, 'Keep those quests coming.', id);
}

function notify(title, body, agentId) {
  if (!settings.notifications || !Notification.isSupported()) return;
  // No need to interrupt if you're already looking at the arcade.
  if (agentId && win && win.isVisible() && win.isFocused()) return;
  const n = new Notification({ title, body, icon: path.join(ASSETS, 'icon.png'), silent: false });
  if (agentId) n.on('click', () => openAgent(agentId));
  n.show();
}
