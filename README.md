# 🕹️ Agent Arcade

A playful web UI for your **local agents**. Each agent is a little critter on the arcade floor:

- It **bobs** while idle and **naps** (💤) when left alone.
- It **types furiously** on a tiny laptop while it works, and its latest output shows up in a speech bubble.
- It **hops for joy** with confetti when a run succeeds, and gets dizzy when one fails.
- It earns **XP and levels up** with every quest (the stats are saved in `data/stats.json`).

Click an agent to open its chat drawer and send it a quest. The drawer streams output live, and you can stop a run from there. **📣 Party quest** sends the same prompt to every idle agent at once.

Any command-line tool can be an agent: `claude`, `ollama`, `aider`, a Python script, a shell script. You can use it in the browser, where the only runtime is Node with no dependencies to install, or as a **desktop app** with a tray icon and notifications.

## Quick start (browser)

```bash
npm start            # or: node server.js
# open http://127.0.0.1:4321
```

It comes with three demo agents (Pip, Bolt and Grub, who is chaos), so you can try it right away.

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

When you run from the checkout, the app uses the same `agents.local.json` / `agents.json` and `data/` as `npm start`. The installed app keeps its own `agents.json` in your user-data folder. On first launch it copies the demo agents there. Open it from the tray with **Edit agents…**, then use **Reload agents** to apply your changes. Agents whose `command` is `node` use the app's bundled Node, so the demo agents work even if Node isn't installed.

> The builds aren't code-signed, so the first time you open the app, macOS Gatekeeper and Windows SmartScreen will warn you. On a Mac, right-click → **Open**.

## Add your own agents

Copy `agents.example.json` to `agents.local.json` and edit it. The local file is gitignored and takes precedence over `agents.json`.

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
| `hat`        | `antenna`, `hardhat`, `horns`, `crown`, `wizard`, `headphones`, `cap`, `bow` (picked from the id if omitted) |

The exit code decides the outcome: `0` means done 🎉, anything else means oops 😵.

You can also point to a config file with `--config=path/to/agents.json` or `AGENTS_CONFIG=...`, and change the address with `PORT` and `HOST`.

## Keyboard

| key          | action                              |
| ------------ | ----------------------------------- |
| `1`–`9`      | open that agent                     |
| `⌘/Ctrl + ↵` | send the quest                      |
| `Esc`        | close the drawer                    |
| `P`          | party quest                         |
| `M`          | mute or unmute the bleeps           |

## Safety notes

- The server listens on `127.0.0.1` only by default.
- Commands come only from your config file. The browser can send prompts, but it can't choose what to execute.
- Cross-origin `POST`s are refused, so other websites open in your browser can't start your agents.
- An agent runs with your user's permissions, so configure it the way you would in a terminal.

## API (for tinkering)

- `GET /api/agents` lists the agents and their status and stats
- `GET /api/events` is a Server-Sent Events stream (`hello`, `agent`, `transcript`, `log`, `levelup`, `cleared`)
- `POST /api/agents/:id/run` with `{ "prompt": "..." }` starts a run
- `POST /api/agents/:id/stop` and `/clear` stop a run and clear the transcript
- `GET /api/agents/:id/transcript` returns the transcript
