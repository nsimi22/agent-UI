# 🕹️ Agent Arcade

A playful web UI for your **local agents**. Each agent is a little critter on the arcade floor:

- It **bobs** while idle and **naps** (💤) when left alone.
- It **types furiously** on a tiny laptop while it works, and its latest output shows up in a speech bubble.
- It **hops for joy** with confetti when a run succeeds, and gets dizzy when one fails.
- It earns **XP and levels up** with every quest (the stats are saved in `data/stats.json`).

Click an agent to open its chat drawer and send it a quest. The drawer streams output live, and you can stop a run from there. **📣 Party quest** sends the same prompt to every idle agent at once.

Any command-line tool can be an agent: `claude`, `ollama`, `aider`, a Python script, a shell script. The only runtime is Node, with no dependencies to install.

## Quick start

```bash
npm start            # or: node server.js
# open http://127.0.0.1:4321
```

It comes with three demo agents (Pip, Bolt and Grub, who is chaos), so you can try it right away.

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
