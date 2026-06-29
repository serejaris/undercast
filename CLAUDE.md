# undercast — agent guide

Local OBS overlay (ticker + prompt widget + full-screen interstitials) plus OBS tooling over obs-websocket v5. Human setup lives in [README.md](README.md). This file is what an agent can do here and the battle-tested gotchas.

## Workflow — issues + PRD (mandatory)

Work on this product goes through GitHub issues with mini-PRDs. No issue — no code.

1. **The product PRD** lives in the epic [#1](https://github.com/serejaris/undercast/issues/1) — vision, channels, success metric, architecture. Updated with rare overview edits only.
2. **Every task/feature = an issue with a mini-PRD** structured as `## Контекст` / `## Что` / `## Решение` / `## Задачи` (checklist). A maintainer comment ("make it smaller", "take it from chat") → issue first, code second.
3. **New issues link as children of the epic** via the Sub-issues API: `gh api -X POST repos/serejaris/undercast/issues/1/sub_issues -F sub_issue_id=$(gh api repos/serejaris/undercast/issues/N --jq '.id')`.
4. **Commits carry the trailer** `refs serejaris/undercast#N` (or `closes ...#N` when the scope is fully delivered).
5. **Progress is tracked by editing the issue body** (checkboxes, commit hashes), not comments. Close an issue only on the maintainer's word or when the scope is fully delivered.

## Capabilities

| What | How |
|---|---|
| Drive the ticker (now/news/chat/note channels) | `undercast ticker now/news/chat/set/add/clear/mode/speed/hide/show/status` |
| Ticker modes: plan in the background, viewer messages interrupt with a typing effect | `undercast ticker mode plan/off` (off = legacy flat ribbon); server-side FIFO queue cap 10, each message shown exactly once |
| Auto-summary of the stream from Granola: the "now" slot + a flash on topic change | `undercast companion start/stop/status/once` (daemon) |
| Stream plan as auto-history of stages: ✓ past + ▶ current, timestamps, chapter export | pre-air: `plan set "A" "B" …` (no flash); on-air: `plan next` / `plan append` (flash); auto: companion via `POST /plan/append`; `plan show/export/clear` |
| YouTube chat into the ticker: live chat + new comments under an announce video | `undercast chatfeed start [announce-url]/stop/status/once` (daemon); OAuth from a youtubeuploader-format token, finds the live video via the channel's `/live` redirect (channel from `UNDERCAST_CHANNEL` or `undercast.config.json`) |
| Any OBS request (scenes, sources, statuses, transforms) | `undercast obs req <RequestType> ['<json>']` |
| Screenshot of a source or scene from OBS | `undercast obs screenshot <sourceName> <out.png> [width]` |
| Add/update the ticker source in the current scene | `undercast obs add-ticker` (idempotent) |
| Show a prompt on the prompt widget | `curl -X POST localhost:8722/prompt -d '{"text":"..."}'`; automatic — the `scripts/hooks/prompt-to-overlay.sh` hook (UserPromptSubmit) |
| Full-screen interstitials (countdown/brb/end/flash) | `undercast screen start "Topic" [min]` / `brb` / `end` / `flash "Text" [sec]` / `off`; add the source to a scene — `undercast obs add-screens` |

Old `bin/ticker`, `bin/plan`, `bin/screen` are deprecated wrappers around the same subcommands.

Channel semantics and the HTTP API — in [README.md](README.md).

## Architecture (what talks to what)

```
OBS Studio
  ├─ browser source "ticker"  → http://127.0.0.1:8722/ticker   (bottom bar, SSE)
  └─ browser source "screens" → http://127.0.0.1:8722/screens  (full-canvas interstitials, SSE)

undercast serve (server.mjs :8722)
  ├─ state.json — ticker + plan + screen mode (persists across restarts)
  └─ SSE /events — pushes state to all browser sources instantly

Daemons (optional, separate processes)
  ├─ companion — Granola MCP → plan/append + now + screen flash (every 180s)
  └─ chatfeed  — YouTube live chat → ticker chat queue (polls /live redirect)

OBS config (scenes, encoder, checklist) — repo corp-streaming, NOT here.
```

**Two visual layers, one server.** Ticker and screens are independent browser sources in the same OBS scene. `screens` is transparent when `mode=off`; countdown/flash/brb cover the whole frame. Ticker keeps running underneath.

**Single screen slot.** `POST /screen` always **replaces** the current interstitial mode. There is no stack — `flash` overwrites `start` (countdown), and when flash expires the mode becomes `off`, **not** back to countdown.

## Go-live playbook (agent)

Repo path: `~/Documents/GitHub/obs-overlay`. Run commands from there. Channel: `UNDERCAST_CHANNEL=@serejaris` (see CLAUDE.local.md).

### Phase A — infrastructure (do this yourself, don't tell the user to run)

```bash
cd ~/Documents/GitHub/obs-overlay

# 1. Server
./bin/undercast serve status || ./bin/undercast serve start

# 2. OBS sources on the active program scene (idempotent)
./bin/undercast obs add-ticker
./bin/undercast obs add-screens

# 3. Fresh plan for this stream (use plan set — see "Plan semantics" below)
./bin/undercast plan clear
./bin/undercast ticker clear
./bin/undercast ticker mode plan
./bin/undercast plan set "этап 1" "этап 2" "…"   # first step becomes ▶, rest ·
./bin/undercast ticker now "короткая строка «сейчас»"

# 4. Chatfeed — start before Go live so the stream's opening chat lands in the ticker (idles until /live exists; see gotcha)
UNDERCAST_CHANNEL=@serejaris ./bin/undercast chatfeed start

# 5. Launch OBS if not running
pgrep -x OBS >/dev/null || open -a OBS
```

Verify: `curl -sf http://127.0.0.1:8722/state | python3 -m json.tool` and `lsof -nP -i :8722 | grep ESTABLISHED`.

### Phase B — pre-air countdown (companion MUST be off)

**Stop companion before any `screen start`.** Companion fires `screen flash` on topic change; that kills the countdown mid-timer (verified 2026-06-29).

```bash
./bin/undercast companion stop
./bin/undercast screen start "тема эфира" 2   # minutes, default 5
```

When the host is ready to switch to program:

```bash
./bin/undercast screen off
```

### Phase C — on air (start companion only if Granola records THIS stream)

```bash
# Only after Granola is actively transcribing the current broadcast:
UNDERCAST_CHANNEL=@serejaris ./bin/undercast companion start
```

Manual stage advance (no Granola / between blocks):

```bash
./bin/undercast plan next          # current → done, next → ▶, fires flash ~7s
./bin/undercast ticker now "…"     # update the green "now" slot
```

### Phase D — after stream

```bash
./bin/undercast chatfeed stop
./bin/undercast companion stop
./bin/undercast plan export chapters   # YouTube timecodes from plan timestamps
```

### Quick reference — what the host sees

| Command | On screen |
|---|---|
| `screen start "Topic" N` | Full-screen countdown, kicker «стрим начнётся через», figlet timer |
| `screen off` | Interstitial disappears (ticker + program visible) |
| `screen flash "Text"` | Full-screen «сейчас», scramble animation, 8s then off |
| `screen brb` / `end` | Break / end cards |
| `ticker mode plan` | Bottom bar: plan steps ✓▶· + messages from chat interrupt |
| `plan next` | Advances plan + flash with new stage title |

Logs: `~/.local/state/undercast/{server,companion,chatfeed}.log`.

## Plan semantics (agent)

| Command | Behavior | Flash? |
|---|---|---|
| `plan set "A" "B" "C"` | All steps at once; **A = ▶**, rest pending. Use for **pre-air setup**. | No |
| `plan append "X"` | Current → done, **X → ▶**. Use **during** stream for new stages. | **Yes** (~7s) |
| `plan next` | Finish current, promote next. | **Yes** |
| `plan current N` | Jump to step N (1-based). | **Yes** |

**Never** run multiple `plan append` in a loop for pre-air setup — each append completes the previous step and fires a flash. For a fresh plan before Go live, always `plan set`.

## Companion — when it helps vs when it breaks things

Companion (`bin/companion`) calls `claude -p` with Granola MCP every **180s** (override: `COMPANION_INTERVAL`).

**It does NOT require the Granola app to be open or recording.** It queries Granola MCP via `list_meetings` for today, then picks **the meeting with the latest start time** (or the latest match for `COMPANION_MEETING_TITLE` hint). An older meeting updated later in the day is **not** selected. Symptom of wrong selection: random stage titles («Фидбек-созвон», «контент-пайплайн») and `screen flash`.

| Situation | companion |
|---|---|
| Pre-air countdown (`screen start`) | **stop** |
| Granola not recording this stream | **stop** (drive plan manually: `plan set` / `plan next`) |
| Before `companion start` | **`companion list`** then **`COMPANION_MEETING_TITLE=... companion verify`** (exit 0 required) |
| Granola live-transcribing the current broadcast | **start** (after `screen off` + verify ok) |
| Response is `NO_MEETING` | Safe — companion skips, no flash |
| Hint set but wrong meeting matched | **skip** — no flash (guard in `bin/companion`) |

Env: `COMPANION_MEETING_TITLE` (substring match on meeting title, from `granola_meeting_title` in corp-youtube `stream-meta.md`). Subcommands: `companion list` (today's meetings, latest first), `companion verify` (dry check + exit 1 on hint mismatch).

`chatfeed` does **not** touch `/screen` — only the ticker chat queue. If countdown was interrupted, suspect **companion** or a manual `plan append`/`plan next`, not chatfeed.

obs-websocket protocol: [v5 request reference](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md) — GetSceneList, GetStreamStatus, SetSceneItemTransform, GetSourceScreenshot, etc.

## Overlay server

- Port `127.0.0.1:8722` (override: `UNDERCAST_PORT`). Health check: `curl -sf http://127.0.0.1:8722/state`
- Run: `undercast serve` (foreground) or `undercast serve start` (daemon)
- The server log records every request — it shows whether OBS loaded the page (`GET /ticker`, `GET /events`)
- Ticker state lives in `state.json` under the state dir (`~/.local/state/undercast`, override: `UNDERCAST_STATE_DIR`) and survives server restarts
- Text in OBS updates instantly via SSE; no source restart needed

## Connecting to OBS

- WebSocket: `ws://127.0.0.1:4455`. Scripts read the password from the OBS config themselves (macOS: `~/Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json`) or from env `OBS_WS_PASSWORD`. **Never print the password to chat or logs.**
- OBS logs (macOS): `~/Library/Application Support/obs-studio/logs/` (newest by mtime; filenames contain spaces).

## Verification (after any overlay change)

1. Server log — did `GET /ticker` + `GET /events` appear
2. `lsof -nP -i :8722 | grep ESTABLISHED` — a live SSE connection from OBS
3. `undercast obs screenshot ticker /tmp/t.png 1920` — the source renders
4. Screenshot of the whole scene — the ticker sits correctly in the composition

## Granola — how it is wired (canon, 2026-06)

The official MCP is the only supported path to Granola data. Connect it in user-scope Claude CLI: `granola: https://mcp.granola.ai/mcp` (Streamable HTTP, browser OAuth, no API keys).

- Tools: `query_granola_meetings`, `list_meetings`, `get_meetings`, `get_meeting_transcript` (paid plans only), `list_meeting_folders`, `get_account_info`
- Headless access: after a one-time interactive OAuth (`/mcp` → granola → authenticate) the token is cached and `claude -p --allowedTools "mcp__granola__*"` works without a browser — `undercast companion` is built on this
- Rate limit ~100 req/min; the free plan sees only your own notes from the last 30 days
- **Live transcripts work (verified on air 2026-06-12), contrary to the docs' "live meetings are unavailable":** the transcript of an ongoing meeting is served hot — companion built the stage plan as the stream went
- Sources: [docs.granola.ai/help-center/sharing/integrations/mcp](https://docs.granola.ai/help-center/sharing/integrations/mcp), [granola.ai/blog/granola-mcp](https://www.granola.ai/blog/granola-mcp)

Dead ends (do not spend time twice):
- REST API (`docs.granola.ai/api-reference`) — Business/Enterprise plans only; keys are created in Settings → Connectors → API keys
- Local files in `~/Library/Application Support/Granola/`: `granola.db` is encrypted (no SQLite header, SQLCipher), `cache-v6.json.enc` too; the old trick of reading `cache-v3.json` is dead

## Gotchas (battle-tested)

- **CEF wedge**: browser sources render empty, the server log shows zero requests, `pgrep -f "OBS Helper \(Renderer\)"` is empty — OBS's browser engine is wedged and only an OBS restart helps. Refreshing the source or toggling visibility does not.
- **Restarting OBS**: first check `GetStreamStatus` and `GetRecordStatus` — both must be `outputActive: false`, otherwise don't touch it. An open Settings window blocks quit: verify via AX that Apply is disabled (no unsaved changes), close it with the close button, then `osascript -e 'quit app "OBS"'`. An osascript `-128` error does not mean the quit failed — re-check `pgrep -x OBS`.
- **Sources live per scene**: ticker/screens get added to the scene that was active at setup time — the scene may have been switched since; check `GetCurrentProgramScene` before and after. For another scene, run `undercast obs add-ticker` / `add-screens` again (601 "already exists" is handled).
- **A browser source in a non-program scene is frozen**: JS and SSE stay alive (the connection shows in lsof) but OBS stops drawing new frames — screenshots show a stale frame. Mode switches "catch up" when the scene returns to program; to verify via screenshot the source must be in the current program scene.
- **Preview without OBS**: headless Chrome with `--virtual-time-budget` hangs — SSE keeps the page "loading forever". Demo background: `?demo=1`. In new headless (Chrome 149+) `--timeout` is dead: `--screenshot` captures right after load, before timers/SSE — the frame is empty. The reliable path: start `--headless --remote-debugging-port=9223 --user-data-dir=$(mktemp -d)` and capture via CDP `Page.captureScreenshot` with a delay (`/json/new` → ws → wait 2–3 s → capture). Without a separate `--user-data-dir` headless conflicts with the user's running Chrome and never loads the page (only favicon in the server log).
- **The prompt widget does not persist**: `lastPrompt` lives in server memory (a prompt is a moment, not state) and never touches `state.json`; after a server restart the widget is empty until the first POST. SSE replay sends the last prompt with its `ts` — the client discards stale ones (>TTL) itself.
- **Hook scripts and stdin**: don't feed python a script via heredoc `python3 - <<'PY'` — the heredoc consumes stdin and the hook's JSON never arrives (silent no-op). Pass the script with `-c` and leave stdin to the data.
- **After editing `ticker.html`** OBS keeps running the old page (SSE reconnects but the JS stays stale — symptom: `[object Object]` in the ticker). Fix: `PressInputPropertiesButton {"inputName":"ticker","propertyName":"refreshnocache"}`.
- **Companion vs countdown (2026-06-29)**: `screen start` and `screen flash` share one `state.screen` slot. Companion (and `plan append`/`plan next`) POST `mode:flash`, which **replaces** an active countdown; after flash ends, mode is `off` — the timer does not resume. **Always `companion stop` before `screen start`.** Start companion only when Granola is transcribing *this* stream.
- **Daemon timing**: chapter timecodes (`plan export`) anchor to `plan.started_at` at first append/set. For accurate chapters, set the plan (`plan set`) before Go live; start companion after `screen off` so auto-appends align with the broadcast. After stream: `chatfeed stop`, `companion stop`, `plan export chapters`.
- **YouTube liveChat has a non-standard REST path**: the resource is named `liveChatMessages` but the URL is `liveChat/messages`; calling it by resource name yields an eternal 404 indistinguishable from "the stream hasn't started yet".
- **chatfeed and the stream start (issue #14)**: start `chatfeed` *before* Go live. The first chat page YouTube returns is recent-history backlog; chatfeed splits it by the daemon's `watchStartedAt` — posted before = primed as seen (silent), posted after = the start it owes the ticker (last `BACKLOG_TAIL_CAP`=10 emitted, to match the server queue cap). Start it after the stream began — or restart mid-stream, which **re-anchors** `watchStartedAt` — and the opening chat before that point is treated as history and never shown. A just-started live whose real `liveChat/messages` still 404s is rechecked every `START_RECHECK_MS` (20 s) for `START_WINDOW_MS` (15 min), then 120 s; `getLiveState`'s `liveBroadcastContent` guard keeps an `upcoming` stream from a false "ready". Invariant: a resolve "ready" must **not** reset the not-ready window — the anchor (`since`) is set by `scheduleNotReadyRecheck` (pending + chat-404 paths) and cleared only on a real connect or stream-gone; clearing it on "ready" resets the recheck timer every cycle, silently breaking the 20 s recheck and "log once" (`fac97da`).

## Roadmap

Next-step ideas — in [README.md](README.md).
