# 🕹️ Agent Arcade

A playful dashboard for the coding agents you run in your terminals. Every **Claude Code** or **Codex** session you start (for example in Cursor's integrated terminal) shows up as a little critter on the arcade floor:

- It **types furiously** while the agent works, and its speech bubble shows what it's doing (`🔧 Bash: npm test`).
- It **waves at you** (✋) when the agent is waiting for your permission or input.
- It **hops for joy** with confetti when a turn finishes, and shows the agent's reply.
- It **naps** when nothing's happening, and earns **XP and levels** per project.

Keep working in your terminals exactly as before. The arcade only watches: it tells you at a glance which of your 10+ sessions needs you. Click a critter to see its activity and jump to that project in Cursor.

## Quick start

```bash
npm install          # once (only needed for the desktop app)
npm run connect      # once: lets Claude Code and Codex report to the arcade
npm run desktop      # or `npm start` and open http://127.0.0.1:4321
```

Then start `claude` or `codex` in any terminal. The session appears on the floor within a second. Sessions that were already running show up after their next event.

**One extra step for Codex:** Codex only runs hooks you've approved. Open `codex`, type `/hooks`, and trust the Agent Arcade hooks once. Until you do, Codex sessions still appear, but they only report finished turns (through Codex's `notify` setting). After that you get the full picture: working, waiting for approval, and done.

`npm run connect` merges a few hooks into `~/.claude/settings.json` and `~/.codex/hooks.json`, and adds one `notify` line to `~/.codex/config.toml` (unless you already have a `notify` setting, which it leaves alone). Your other settings are kept, a backup is saved next to each file (`*.arcade-backup`), and it's safe to run again. `npm run disconnect` removes exactly what it added. In the desktop app, the same switch is **Connect Claude Code & Codex…** in the tray menu.

The hooks never slow your agent down or change what it does: they print nothing, give up after 2 seconds, and do nothing if the arcade isn't running.

Want to see it without real agents? `npm run demo` starts three demo agents the arcade runs itself, and `npm run demo:crowd` starts twelve.

## What you see

| Critter | Status | Means |
| --- | --- | --- |
| typing on a laptop | **working** | the agent is thinking or running tools |
| waving, gold outline | **needs you** | waiting for your permission or an answer in the terminal |
| hopping, happy eyes | **done** | the turn finished; the bubble shows the last line of the reply |
| sleeping | **napping** | nothing has happened for a minute |

Each session is named after its folder (`api`, `web`, …). A critter's colour, hat and level stay with the project across sessions. Closed sessions leave the floor two minutes after they end; use **Dismiss** in the drawer to remove one sooner.

## Running a big crew (10+ agents)

- **Filters.** `All · Needs you · Working · Failed · Done · Idle` show live counts.
- **Compact layout.** It switches on automatically above 6 agents. Toggle it with **▦ Compact** or `C`.
- **Search.** Press `/`, type part of a name or folder, then press `Enter` to open the first match.
- Press `1`–`9` and `0` to jump to the first 10 agents.

## Desktop app

Agent Arcade also runs as a desktop app (Electron) for macOS, Windows and Linux:

- It has its own window, with the agent server running inside the app.
- **Tray / menu-bar icon.** It shows how many agents are working, lists each agent's status, and opens an agent when you click it. Closing the window keeps your agents running in the tray. Use **Quit** in the tray menu to stop them.
- **System notifications** when an agent finishes or fails, showing its last line of output. Click one to jump to that agent. You can turn them off from the tray menu.
- A Dock/taskbar badge with the working count, and an "Open at login" option on macOS and Windows.

```bash
npm install            # one time: installs Electron + electron-builder
npm run desktop        # run the app from this checkout

npm run dist           # build an installer for your OS into dist/
npm run dist:mac       # .dmg + .zip   (build on a Mac)
npm run dist:win       # .exe installer
npm run dist:linux     # AppImage + .deb
```

When you run from the checkout, the app uses the same `agents.local.json` / `agents.json` and `data/` as `npm start`. The installed app keeps its own `agents.json` in your user-data folder. On first launch it creates an empty one there. Open it from the tray with **Edit agents…**, then use **Reload agents** to apply your changes. Agents whose `command` is `node` use the app's bundled Node, so the demo agents work even if Node isn't installed. The app also loads the PATH from your login shell. Without that, macOS apps opened from the Dock can't find tools like `claude`, `cursor` or `idea`.

> The builds aren't code-signed, so the first time you open the app, macOS Gatekeeper and Windows SmartScreen will warn you. On a Mac, right-click → **Open**.

## Agents the arcade runs itself (optional)

Besides watching your terminals, the arcade can also run one-shot agents itself: you type a task into its drawer (or send one to several agents with **📣 Party quest**) and it runs the command. Copy `agents.example.json` to `agents.local.json` and edit it. The local file is gitignored and takes precedence over `agents.json`.

```json
{
  "agents": [
    {
      "id": "claude",
      "name": "Clawd",
      "role": "Claude Code",
      "color": "#fb923c",
      "hat": "crown",
      "command": "claude",
      "args": ["-p", "{prompt}"],
      "cwd": "~/code/my-project",
      "timeoutSec": 900
    },
    {
      "id": "llama",
      "name": "Lulu",
      "role": "Ollama",
      "hat": "wizard",
      "command": "ollama",
      "args": ["run", "llama3.2"],
      "stdin": true
    }
  ]
}
```

| field        | meaning                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------- |
| `id`         | unique id (required)                                                                     |
| `command`    | executable to run (required). It runs directly, without a shell.                         |
| `args`       | argument list. `{prompt}` is replaced with your quest. Defaults to `["{prompt}"]`.        |
| `stdin`      | `true` pipes the prompt to stdin instead of (or as well as) passing it as an argument.    |
| `cwd`        | working directory (`~` is expanded; relative paths resolve from this repo)               |
| `env`        | extra environment variables                                                              |
| `timeoutSec` | kill the run after this many seconds                                                     |
| `name`, `role`, `color` | how the critter looks and what it's called                                     |
| `ide`        | editor for **Open in IDE**: a name like `cursor`, a custom `{label, command, args}` object, or `null` for none. Defaults to the top-level `ide`. |
| `hat`        | `antenna`, `hardhat`, `horns`, `crown`, `wizard`, `headphones`, `cap`, `bow` (picked from the id if omitted) |

### Open an agent's project in your IDE

Set `ide` once at the top of the config, or give an agent its own. The agent's drawer then gets an **Open in Cursor ↗** button that opens the agent's `cwd` in that editor.

```json
{
  "ide": "cursor",
  "agents": [
    { "id": "api", "command": "claude", "args": ["-p", "{prompt}"], "cwd": "~/code/api" },
    { "id": "web", "command": "claude", "args": ["-p", "{prompt}"], "cwd": "~/code/web", "ide": "webstorm" },
    { "id": "etc", "command": "claude", "args": ["-p", "{prompt}"], "cwd": "~/code/etc", "ide": { "label": "Sublime", "command": "subl", "args": ["{path}"] } }
  ]
}
```

Supported names: `cursor`, `vscode` (or `code`), `insiders`, `windsurf`, `zed`, and the JetBrains IDEs `idea`, `webstorm`, `pycharm`, `goland`, `rider`, `phpstorm`, `rubymine`, `clion`, `rustrover`. Any other editor works as a custom `{ label, command, args }` entry.

On macOS, the button falls back to `open -a <App>` if the command-line launcher isn't installed. On other systems, install the launcher: for Cursor, VS Code and Windsurf, run *Shell Command: Install '…' command in PATH* from the editor's command palette. For JetBrains, turn on **Settings → Tools → Shell scripts** in JetBrains Toolbox.

The exit code decides the outcome: `0` means done 🎉, anything else means oops 😵.

You can also point to a config file with `--config=path/to/agents.json` or `AGENTS_CONFIG=...`, and change the address with `PORT` and `HOST`.

## Keyboard

| key          | action                              |
| ------------ | ----------------------------------- |
| `1`–`9`, `0` | open that agent (0 is the 10th)     |
| `/`          | search agents                       |
| `C`          | toggle compact layout               |
| `⌘/Ctrl + ↵` | send the quest                      |
| `Esc`        | close the drawer                    |
| `P`          | party quest                         |
| `M`          | mute or unmute the bleeps           |

## Safety notes

- The server listens on `127.0.0.1` only by default.
- Commands come only from your config file. The browser can send prompts, but it can't choose what to execute.
- Cross-origin `POST`s are refused, so other websites open in your browser can't start your agents.
- An agent runs with your user's permissions, so configure it the way you would in a terminal.
- Terminal sessions report to `POST /api/hooks/claude` and `/api/hooks/codex`. These accept only local requests, answer with an empty `204`, and never send anything back to the agent. The Claude Code transcript is only read from files under `~/.claude`.

## API (for tinkering)

- `GET /api/agents` lists the agents and their status and stats
- `GET /api/events` is a Server-Sent Events stream (`hello`, `agent`, `transcript`, `log`, `levelup`, `cleared`)
- `POST /api/agents/:id/run` with `{ "prompt": "..." }` starts a run
- `POST /api/agents/:id/stop` and `/clear` stop a run and clear the transcript
- `GET /api/agents/:id/transcript` returns the transcript
- `POST /api/hooks/claude` and `/api/hooks/codex` receive hook events from your terminals
- `POST /api/agents/:id/forget` dismisses a watched session
