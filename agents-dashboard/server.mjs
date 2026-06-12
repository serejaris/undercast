// agents-dashboard — standalone prototype server (port 8723).
// Polls running Claude Code sessions and serves a corner widget for OBS.
// Self-contained: does not touch the main overlay server (8722).

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, stat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const PORT = process.env.PORT || 8723;
const POLL_MS = 5000;
const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const WIDGET = fileURLToPath(new URL('./widget.html', import.meta.url));

let sessions = [];           // latest snapshot
const sseClients = new Set();

// --- data collection ------------------------------------------------------

async function listClaudeProcesses() {
  try {
    const { stdout } = await exec('ps', ['-axo', 'pid=,pcpu=,etime=,args=']);
    return stdout.split('\n').flatMap((line) => {
      const m = line.match(/^\s*(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/);
      if (!m) return [];
      const [, pid, pcpu, etime, args] = m;
      // CLI process: command is `claude` itself, not an app bundle path
      const argv0 = args.split(/\s+/)[0] || '';
      if (basename(argv0) !== 'claude') return [];
      return [{ pid: Number(pid), cpu: Number(pcpu), etime, args }];
    });
  } catch {
    return [];
  }
}

async function cwdOf(pid) {
  try {
    const { stdout } = await exec('lsof', ['-p', String(pid), '-a', '-d', 'cwd', '-Fn']);
    const line = stdout.split('\n').find((l) => l.startsWith('n'));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

// same encoding Claude Code uses for ~/.claude/projects dir names
const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

async function freshestJsonl(dir) {
  try {
    const entries = await readdir(dir);
    let best = null;
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const full = join(dir, name);
      const st = await stat(full).catch(() => null);
      if (st && (!best || st.mtimeMs > best.mtimeMs)) best = { full, mtimeMs: st.mtimeMs };
    }
    return best;
  } catch {
    return null;
  }
}

async function modelFromJsonl(file) {
  try {
    // read the last ~64KB and take the last "model" occurrence
    const fh = await open(file, 'r');
    const { size } = await fh.stat();
    const len = Math.min(size, 65536);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    await fh.close();
    const matches = buf.toString('utf8').match(/"model":"([^"]+)"/g);
    if (!matches) return null;
    return matches[matches.length - 1].slice(9, -1).replace(/^claude-/, '');
  } catch {
    return null;
  }
}

function prettyEtime(etime) {
  // formats: mm:ss | hh:mm:ss | d-hh:mm:ss
  let days = 0, rest = etime;
  if (rest.includes('-')) [days, rest] = [Number(rest.split('-')[0]), rest.split('-')[1]];
  const parts = rest.split(':').map(Number);
  const [h, m] = parts.length === 3 ? parts : [0, parts[0]];
  if (days) return `${days}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

async function poll() {
  try {
    const procs = await listClaudeProcesses();
    const now = Date.now();
    const next = [];
    for (const p of procs) {
      const cwd = await cwdOf(p.pid);
      const project = cwd ? (cwd === homedir() ? '~' : basename(cwd)) : `pid ${p.pid}`;
      let model = null, jsonlAge = Infinity;
      if (cwd) {
        const best = await freshestJsonl(join(PROJECTS_DIR, encodeCwd(cwd)));
        if (best) {
          jsonlAge = (now - best.mtimeMs) / 1000;
          model = await modelFromJsonl(best.full);
        }
      }
      next.push({
        pid: p.pid,
        project,
        model,
        uptime: prettyEtime(p.etime),
        thinking: p.cpu > 5 || jsonlAge < 10,
      });
    }
    next.sort((a, b) => a.project.localeCompare(b.project));
    sessions = next;
    broadcast();
  } catch (err) {
    console.error('poll failed:', err.message);
  }
}

// --- http -----------------------------------------------------------------

function broadcast() {
  const payload = `data: ${JSON.stringify(sessions)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/' || url.pathname === '/widget') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await readFile(WIDGET));
  } else if (url.pathname === '/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessions));
  } else if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(sessions)}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`agents-dashboard on http://127.0.0.1:${PORT}`);
  poll();
  setInterval(poll, POLL_MS);
});
