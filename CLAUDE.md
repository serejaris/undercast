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
| Stream plan as auto-history of stages from the live transcript: ✓ past + ▶ current, timestamps, chapter export | companion builds it itself (`POST /plan/append`); manual — `undercast plan append/show/export/clear` (`set` is debug-only) |
| YouTube chat into the ticker: live chat + new comments under an announce video | `undercast chatfeed start [announce-url]/stop/status/once` (daemon); OAuth from a youtubeuploader-format token, finds the live video via the channel's `/live` redirect (channel from `UNDERCAST_CHANNEL` or `undercast.config.json`) |
| Any OBS request (scenes, sources, statuses, transforms) | `undercast obs req <RequestType> ['<json>']` |
| Screenshot of a source or scene from OBS | `undercast obs screenshot <sourceName> <out.png> [width]` |
| Add/update the ticker source in the current scene | `undercast obs add-ticker` (idempotent) |
| Show a prompt on the prompt widget | `curl -X POST localhost:8722/prompt -d '{"text":"..."}'`; automatic — the `scripts/hooks/prompt-to-overlay.sh` hook (UserPromptSubmit) |
| Full-screen interstitials (countdown/brb/end/flash) | `undercast screen start "Topic" [min]` / `brb` / `end` / `flash "Text" [sec]` / `off`; add the source to a scene — `undercast obs add-screens` |

Old `bin/ticker`, `bin/plan`, `bin/screen` are deprecated wrappers around the same subcommands.

Channel semantics and the HTTP API — in [README.md](README.md).

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
- **Start the daemons at the top of the stream**: the plan and its timecodes (`/plan/export`) build from the first append — a companion started mid-stream covers only the tail, and chapter offsets shift relative to the video start. Before going live: `undercast ticker mode plan` + `undercast companion start` + `undercast chatfeed start [announce-url]`; after: `undercast chatfeed stop`, `undercast companion stop`, `undercast plan export chapters`.
- **YouTube liveChat has a non-standard REST path**: the resource is named `liveChatMessages` but the URL is `liveChat/messages`; calling it by resource name yields an eternal 404 indistinguishable from "the stream hasn't started yet".

## Roadmap

Next-step ideas — in [README.md](README.md).
