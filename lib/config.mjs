// Shared configuration for the undercast toolkit. Zero dependencies.
// Resolution order: env > undercast.config.json (cwd) > default.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_FILE = 'undercast.config.json';

function expandHome(p) {
  if (!p) return p;
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

function fileConfig() {
  const path = join(process.cwd(), CONFIG_FILE);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    console.error(`${CONFIG_FILE} is not valid JSON — ignoring it`);
    return {};
  }
}

// PORT and TICKER_URL are honored as legacy aliases
const DEFAULT_STATE_DIR = '~/.local/state/undercast';

export function loadConfig() {
  const file = fileConfig();
  const port = Number(process.env.UNDERCAST_PORT || process.env.PORT || file.port || 8722);
  const stateDir = expandHome(process.env.UNDERCAST_STATE_DIR || file.stateDir || DEFAULT_STATE_DIR);
  return {
    port,
    baseUrl: process.env.UNDERCAST_URL || process.env.TICKER_URL || `http://127.0.0.1:${port}`,
    channel: process.env.UNDERCAST_CHANNEL || file.channel || null,
    ytToken: expandHome(
      process.env.UNDERCAST_YT_TOKEN || file.ytToken || '~/.config/youtubeuploader/yt_token.json'
    ),
    stateDir,
    // legacy state migration must only run for the real state dir, never for
    // throwaway overrides (test instances would consume the legacy file)
    stateDirIsDefault: stateDir === expandHome(DEFAULT_STATE_DIR),
  };
}
