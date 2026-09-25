// Agent Arcade desktop app: runs the arcade server in-process, shows it in a
// native window, and adds a tray icon + system notifications.

const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, nativeTheme, shell, dialog } = require('electron');
const fs = require('fs');
const { execFile } = require('child_process');
const path = require('path');
const arcade = require('../server');
const connect = require('../connect');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(__dirname, 'assets');
const PREFERRED_PORT = 4321;
const IS_MAC = process.platform === 'darwin';

let win = null;
let tray = null;
let instance = null; // what arcade.start() resolved with
let quitting = false;
const settings = { notifications: true, ...arcade.readJson(settingsFile(), {}) };

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

function saveSettings() {
  arcade.writeJson(settingsFile(), settings);
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
// Runs in the background (shell startup can take seconds); agents only need it
// once you start one.
function adoptShellPath() {
  if (process.platform === 'win32') return;
  const shellBin = process.env.SHELL || (IS_MAC ? '/bin/zsh' : '/bin/bash');
  const opts = { encoding: 'utf8', timeout: 5000 };
  execFile(shellBin, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], opts, (err, out) => {
    const m = !err && out.match(/__PATH__(.*)__PATH__/);
    if (!m || !m[1]) return; // keep the PATH we have; absolute commands still work
    const merged = new Set([...m[1].split(':'), ...(process.env.PATH || '').split(':')].filter(Boolean));
    process.env.PATH = [...merged].join(':');
  });
}

async function boot() {
  nativeTheme.themeSource = 'dark'; // dark title bar, menus and dialogs everywhere
  adoptShellPath();
  try {
    instance = await arcade.start({
      ...arcadePaths(),
      nodeBinary: process.execPath,
      defaultCwd: app.getPath('home'),
      port: PREFERRED_PORT,
      fallbackPort: 0, // any free port if something else has 4321
    });
  } catch (err) {
    dialog.showErrorBox('Agent Arcade could not start', `${err.message}\n\nCheck your agents config and try again.`);
    app.exit(1);
    return;
  }

  instance.bus.on('agent', onAgent);
  instance.bus.on('levelup', onLevelUp);
  instance.bus.on('removed', refreshTraySoon); // dismissed / expired sessions leave the tray too

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
  // macOS opens the menu on click; elsewhere a click toggles the window.
  if (!IS_MAC) tray.on('click', () => (win && win.isVisible() && win.isFocused() ? win.hide() : showWindow()));
  refreshTray();
}

const STATUS_ICON = { idle: '💤', working: '⚙️', waiting: '✋', done: '✅', error: '💥' };
let trayKey = '';

function refreshTray() {
  if (!tray || !instance) return;
  const agents = instance.snapshot();
  // Only rebuild the native menu when something it shows has changed.
  const key = JSON.stringify(agents.map((a) => [a.id, a.status, a.stats.level, a.task, a.status === 'waiting' && a.lastLine]));
  if (key === trayKey) return;
  trayKey = key;
  const working = agents.filter((a) => a.status === 'working');
  const waiting = agents.filter((a) => a.status === 'waiting');
  const summary = [waiting.length && `${waiting.length} need you`, working.length && `${working.length} working`].filter(Boolean).join(' · ');

  tray.setImage(trayImage(working.length > 0));
  tray.setToolTip(`Agent Arcade: ${summary || 'all idle'}`);
  // The badge counts sessions waiting on you; failing that, the busy ones.
  const badge = waiting.length || working.length;
  if (IS_MAC) tray.setTitle(badge ? ` ${waiting.length ? '✋' : ''}${badge}` : '');
  app.setBadgeCount(badge);

  const menu = Menu.buildFromTemplate([
    { label: 'Show Agent Arcade', click: showWindow },
    { type: 'separator' },
    { label: agents.length ? `${agents.length} agents · ${summary || 'all idle'}` : 'No agents yet', enabled: false },
    ...agents.map((a) => ({
      label: `${STATUS_ICON[a.status] || '•'}  ${a.name}  ·  Lv ${a.stats.level}`,
      sublabel: (a.status === 'working' || a.status === 'waiting') && (a.lastLine || a.task) ? (a.lastLine || a.task).slice(0, 60) : a.role || undefined,
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
    {
      label: 'Connect Claude Code & Codex…',
      type: 'checkbox',
      checked: connect.isConnected(),
      click: toggleConnected,
    },
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

// The server only reports "done"/"error" at the end of a run.
function onAgent(a) {
  refreshTraySoon();
  if (a.status === 'waiting') notify(`${a.name} needs you ✋`, a.lastLine || 'Waiting for your OK in the terminal.', a.id);
  else if (a.status === 'done') notify(`${a.name} finished 🎉`, a.lastLine || a.task || 'Quest complete!', a.id);
  else if (a.status === 'error') notify(`${a.name} hit a snag 😵`, a.lastLine || 'The run failed. Open it to see what happened.', a.id);
}

// Tray toggle: add or remove the hooks that let terminal sessions report here.
async function toggleConnected(item) {
  const wasConnected = !item.checked; // Electron flips the checkbox before calling us
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: [wasConnected ? 'Disconnect' : 'Connect', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: wasConnected ? 'Stop watching Claude Code and Codex sessions?' : 'Watch your Claude Code and Codex sessions?',
    detail: wasConnected
      ? 'Removes the Agent Arcade hooks from ~/.claude/settings.json and ~/.codex/config.toml.'
      : 'Adds small hooks to ~/.claude/settings.json and ~/.codex/config.toml that tell the arcade what each terminal session is doing. Your other settings are kept, and a backup is saved next to each file.',
  });
  if (response === 0) {
    try {
      const changed = wasConnected ? connect.disconnectAll() : connect.connectAll(Number(new URL(instance.url).port));
      notify(wasConnected ? 'Disconnected' : 'Connected 🎉', changed.messages.join('\n'));
    } catch (err) {
      dialog.showErrorBox('Agent Arcade', err.message);
    }
  }
  trayKey = ''; // force the menu to show the real state
  refreshTray();
}

function onLevelUp({ id, name, level }) {
  notify(`⭐ ${name} reached level ${level}!`, 'Keep those quests coming.', id);
}

function notify(title, body, agentId) {
  if (!settings.notifications || !Notification.isSupported()) return;
  // No need to interrupt if you're already looking at the arcade.
  if (agentId && win && win.isVisible() && win.isFocused()) return;
  const n = new Notification({ title, body, icon: path.join(ASSETS, 'icon.png'), silent: false });
  if (agentId) n.on('click', () => openAgent(agentId));
  n.show();
}
