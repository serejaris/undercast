# undercast

**The self-aware overlay for OBS.** A ticker that listens to your stream and runs itself.

> Русская версия: [README.ru.md](README.ru.md)

undercast is a local overlay server for OBS with a news-style ticker at the bottom of your stream. The unusual part: it knows what is happening on air. A companion daemon reads the live transcript of your stream and builds the stream plan as it unfolds — past stages ✓, current stage ▶ — while a chat daemon types YouTube live-chat messages straight onto the ticker.

![plan mode](https://raw.githubusercontent.com/serejaris/undercast/main/docs/img/ticker-plan.png)

![message mode](https://raw.githubusercontent.com/serejaris/undercast/main/docs/img/ticker-message.png)

## Features

- **Self-writing stream plan** — stages are detected from the live transcript and appended automatically; entry/exit timestamps accumulate per stage and export as ready-made YouTube chapters after the stream
- **Live chat on the ticker** — YouTube live-chat messages (and fresh comments under an announce video) are typed out character by character, one at a time, then the plan returns
- **Event-driven modes** — the plan is the background; a viewer message interrupts it, the queue drains, the plan comes back; one manual switch returns the classic flat ribbon
- **Full-screen interstitials** — countdown, BRB, end screen, transient flash with scramble animation
- **Prompt widget** — a lower-third that shows your audience the last prompt you sent to your coding agent
- **OBS tooling** — add sources, take screenshots, send any obs-websocket v5 request from the CLI
- Zero dependencies: one Node server, state over SSE, plain HTML overlays

## Quick start

```bash
npm install -g undercast
undercast serve                 # http://127.0.0.1:8722
```

Add a **Browser** source in OBS: URL `http://127.0.0.1:8722/ticker`, width `1920`, height `64`, placed at the bottom of the scene. The page background is transparent — only the bar shows. Or let undercast do it over obs-websocket:

```bash
undercast obs add-ticker        # adds the browser source to the current scene
```

Preview in a regular browser: `http://127.0.0.1:8722/ticker?demo=1` (dark background instead of transparent).

Then:

```bash
undercast ticker now "wiring up the overlay"     # the green "now" slot
undercast ticker chat "what font is that?" alex  # a viewer question
undercast ticker mode plan                       # plan mode: stages + now; messages interrupt
undercast plan export chapters                   # YouTube chapter timecodes after the stream
```

## CLI

One entrypoint, `undercast <command>`:

| Command | What it does |
|---|---|
| `serve` | run the overlay server (foreground); `serve start\|stop\|status` for daemon mode |
| `ticker now\|news\|chat\|set\|add\|clear\|mode\|speed\|hide\|show\|status` | drive the ticker line |
| `plan show\|append\|export\|clear` | stream plan as auto-history (`set` exists as debug) |
| `screen start\|brb\|end\|flash\|off` | full-screen interstitials |
| `companion start\|stop\|status\|once` | transcript watcher: auto-plan + "now" slot (optional, see below) |
| `chatfeed start\|stop\|status\|once\|smoke` | YouTube chat poller |
| `obs add-ticker\|add-screens\|req\|screenshot` | OBS helpers over obs-websocket v5 |

## Configuration

Resolution order: CLI flag > environment variable > `undercast.config.json` in the working directory > default.

| Env | Default | Meaning |
|---|---|---|
| `UNDERCAST_PORT` | `8722` | overlay server port |
| `UNDERCAST_URL` | `http://127.0.0.1:8722` | base URL CLI clients talk to (`TICKER_URL` still works) |
| `UNDERCAST_CHANNEL` | — | your YouTube handle, e.g. `@yourname`; required by chatfeed |
| `UNDERCAST_YT_TOKEN` | `~/.config/youtubeuploader/yt_token.json` | OAuth token file for the YouTube Data API |
| `UNDERCAST_STATE_DIR` | `~/.local/state/undercast` | state, pid files and logs |

`undercast.config.json`:

```json
{ "port": 8722, "channel": "@yourname", "ytToken": "~/.config/youtubeuploader/yt_token.json", "stateDir": "~/.local/state/undercast" }
```

## Ticker modes

| Mode | On screen |
|---|---|
| `plan` | background: plan stages ✓/▶ plus the "now" slot; a static mode chip sits left of the scroll |
| `message` | a viewer message interrupts: the scroll stops, `author: text` is typed out character by character, holds ~8 s, then the plan returns |
| `off` | the classic flat ribbon of all channels (default) |

Messages go through a FIFO queue on the server (capacity 10, oldest dropped), each is shown exactly once, and the queue survives a server restart. In `off` mode `POST /chat` falls back to the legacy behavior — an item on the ribbon.

The flat ribbon is built from typed items, each with its own chip: `now` (green, single slot, replace semantics), `news` (blue, last 5 kept), `chat` (amber, last 5 kept), `note` (no chip).

## The companion (optional)

`undercast companion` is the part that makes the overlay self-aware, and it is honest about its dependencies: it shells out to the [Claude Code](https://claude.com/claude-code) CLI (`claude -p`, haiku by default) with the official [Granola MCP](https://docs.granola.ai/help-center/sharing/integrations/mcp), which transcribes your stream session as a meeting. Every cycle (180 s by default, `COMPANION_INTERVAL` to change) it reads the last minutes of the live transcript and decides:

- did a **new stage** of the conversation begin? → append it to the plan (`POST /plan/append`), fire a full-screen flash
- what are we doing **right now**? → update the ticker's "now" slot

No Claude Code or Granola — no companion; everything else works without it. The plan can also be driven by hand (`undercast plan append "new stage"`).

After the stream, `undercast plan export chapters` prints YouTube chapter timecodes built from the recorded stage timestamps; `export md` gives a checklist with intervals. Start the daemons at the beginning of the stream — the plan only covers what the companion has seen.

## chatfeed: YouTube chat → ticker

`undercast chatfeed start` polls the live chat of your current broadcast — the video is auto-resolved through `youtube.com/<channel>/live` (no API quota spent), so there is nothing to configure per stream. `chatfeed start <announce-url>` additionally polls fresh comments under an announce video (only ones posted after the daemon started).

Messages pass heuristic filters before reaching the ticker: URLs stripped, texts over 200 characters skipped, non-text events (stickers, super chats) skipped, duplicates dropped by id (the seen-set survives restarts). No LLM in the hot path.

Auth: a YouTube Data API OAuth token in [youtubeuploader](https://github.com/porjo/youtubeuploader) format (`UNDERCAST_YT_TOKEN`). Scope `youtube.force-ssl` covers both live chat and comments. Before a broadcast exists the daemon idles politely, rechecking every 2 minutes; once your stream appears it polls quickly so the opening chat lands on the ticker from the start — start it before you go live; when the chat ends it goes back to looking for the next one.

## Interstitials and the prompt widget

`/screens` is a full-screen overlay page that stays in the scene permanently (transparent when off, instant switching, no scene changes):

```bash
undercast screen start "What the stream is about" 10   # countdown, 10 minutes
undercast screen brb "tea break"                       # be-right-back timer
undercast screen end "recording soon on the channel"   # end screen with CTA
undercast screen flash "topic changed" 8               # transient flash, fades by itself
undercast screen off
```

`/prompt-widget` is a lower-third that shows the audience the last prompt sent to your coding agent, with a typing animation, fading after 20 s (`?ttl=30` to change). Feed it manually (`curl -X POST localhost:8722/prompt -d '{"text":"..."}'`) or automatically from Claude Code with a `UserPromptSubmit` hook calling `scripts/hooks/prompt-to-overlay.sh`.

## HTTP API

| Endpoint | What it does |
|---|---|
| `GET /ticker` | overlay page |
| `GET /state` | current state as JSON |
| `GET /events` | SSE stream of state updates |
| `GET /prompt-widget` | prompt widget page |
| `GET /prompt` | last prompt as JSON (`{text, ts}`) |
| `GET /prompt-events` | SSE stream of prompts (replays the last one with its `ts`) |
| `POST /prompt` | `{"text": "..."}` — show a prompt; empty text hides the widget |
| `POST /now` | `{"text": "..."}` — replace the "now" slot; empty text removes it |
| `POST /news` | `{"text": "..."}` — append a news item |
| `POST /chat` | `{"text": "...", "author": "..."}` — viewer message: queued for display in modes, ribbon item when `off` |
| `POST /mode` | `{"mode": "plan\|off"}` — switch ticker mode |
| `GET /screens` | interstitials page |
| `POST /plan` | `{"steps": [...]}` — set a plan (empty array removes it) |
| `POST /plan/current` | `{"index": N}` — jump to step N (0-based; earlier steps become done) |
| `POST /plan/done` | finish the current step, next becomes current |
| `POST /plan/append` | `{"text": "..."}` — new stage: current → done, new → current |
| `GET /plan/export` | `?format=chapters\|md` — timecodes or checklist |
| `POST /screen` | `{"mode": "off\|start\|brb\|end\|flash", "title", "sub", "minutes", "seconds"}` |
| `POST /set` | `{"items": [{"type","text"}, ...]}` or strings — full replace |
| `POST /add` | `{"text": "...", "type": "note"}` — append an item |
| `POST /clear` | `{}` for everything or `{"type": "news"}` for one type |
| `POST /config` | `{"speed", "visible"}` |

State survives server restarts (`state.json` in `UNDERCAST_STATE_DIR`).

## License

MIT
