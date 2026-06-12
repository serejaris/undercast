// Screenshot any OBS source/scene: node scripts/obs-screenshot.mjs <sourceName> <outFile> [width]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [sourceName, outFile, width] = process.argv.slice(2);
if (!sourceName || !outFile) {
  console.error('usage: node scripts/obs-screenshot.mjs <sourceName> <outFile> [width]');
  process.exit(1);
}

function obsPassword() {
  if (process.env.OBS_WS_PASSWORD) return process.env.OBS_WS_PASSWORD;
  const cfg = join(
    homedir(),
    'Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json'
  );
  return JSON.parse(readFileSync(cfg, 'utf8')).server_password;
}

const sha256b64 = (s) => createHash('sha256').update(s).digest('base64');
const ws = new WebSocket('ws://127.0.0.1:4455');
let reqId = 0;
const pending = new Map();

function request(requestType, requestData = {}) {
  const id = String(++reqId);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ op: 6, d: { requestType, requestId: id, requestData } }));
  });
}

await new Promise((resolve, reject) => {
  ws.onerror = () => reject(new Error('cannot connect to OBS websocket'));
  ws.onmessage = (e) => {
    const { op, d } = JSON.parse(e.data);
    if (op === 0) {
      const identify = { rpcVersion: 1 };
      if (d.authentication) {
        const { challenge, salt } = d.authentication;
        identify.authentication = sha256b64(sha256b64(obsPassword() + salt) + challenge);
      }
      ws.send(JSON.stringify({ op: 1, d: identify }));
    } else if (op === 2) resolve();
    else if (op === 7) {
      const p = pending.get(d.requestId);
      if (!p) return;
      pending.delete(d.requestId);
      if (d.requestStatus.result) p.resolve(d.responseData || {});
      else p.reject(new Error(d.requestStatus.comment || 'request failed'));
    }
  };
});

const { imageData } = await request('GetSourceScreenshot', {
  sourceName,
  imageFormat: 'png',
  imageWidth: Number(width || 1280),
});
writeFileSync(outFile, Buffer.from(imageData.split(',')[1], 'base64'));
console.log(outFile);
ws.close();
