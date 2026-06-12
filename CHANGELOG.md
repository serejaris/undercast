# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-06-12

### Added

- **Self-writing stream plan** — the companion daemon (Claude Code CLI + the official Granola MCP) reads the live transcript of the stream and appends stages as the conversation unfolds; per-stage timestamps export as YouTube chapters (`undercast plan export chapters`)
- **YouTube chat on the ticker** — the chatfeed daemon polls the live chat of the current broadcast (auto-resolved through the channel's `/live` redirect, no quota spent) and fresh comments under an announce video; messages pass zero-LLM heuristic filters (URLs stripped, >200 chars skipped, non-text skipped, id dedup) and are typed onto the ticker character by character
- **Event-driven ticker modes** — `plan` as the background, a viewer `message` interrupts the scroll and the plan returns when the queue drains, `off` keeps the classic flat ribbon; server-side FIFO queue (cap 10) that survives restarts, each message shown exactly once
- **Full-screen interstitials** — countdown, BRB, end screen, transient flash with scramble animation
- **Prompt widget** — a lower-third that shows the audience the last prompt sent to your coding agent
- **Unified `undercast` CLI** — one entrypoint: `serve`, `ticker`, `plan`, `screen`, `companion`, `chatfeed`, `obs`
- **OBS tooling over obs-websocket v5** — add sources, take screenshots, send any request from the CLI
- Localization of overlay labels (English default, `?lang=ru`), configurable `?brand=` footer
- Configuration via env / `undercast.config.json` (`UNDERCAST_PORT`, `UNDERCAST_URL`, `UNDERCAST_CHANNEL`, `UNDERCAST_YT_TOKEN`, `UNDERCAST_STATE_DIR`)
- MIT license

[0.1.0]: https://github.com/serejaris/undercast/releases/tag/v0.1.0
