// Adds (or updates) the "ticker" browser source in the current OBS scene via obs-websocket v5.
// Zero dependencies — node scripts/obs-add-ticker.mjs
// Password is read from OBS's own config; never printed.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OBS_WS_URL = 'ws://127.0.0.1:4455';
const INPUT_NAME = 'ticker';
const TICKER_URL = process.env.TICKER_URL || 'http://127.0.0.1:8722/ticker';
const BAR_HEIGHT = Number(process.env.TICKER_HEIGHT || 64);

function obsPassword() {
  if (process.env.OBS_WS_PASSWORD) return process.env.OBS_WS_PASSWORD;
  const cfg = join(
    homedir(),
    'Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json'
  );
  return JSON.parse(readFileSync(cfg, 'utf8')).server_password;
}

const sha256b64 = (s) => createHash('sha256').update(s).digest('base64');

const ws = new WebSocket(OBS_WS_URL);
let reqId = 0;
const pending = new Map();

function request(requestType, requestData = {}) {
  const id = String(++reqId);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ op: 6, d: { requestType, requestId: id, requestData } }));
  });
}

const identified = new Promise((resolve, reject) => {
  ws.onerror = () => reject(new Error('cannot connect to OBS websocket'));
  ws.onmessage = (e) => {
    const { op, d } = JSON.parse(e.data);
    if (op === 0) {
      // Hello → Identify with auth challenge
      const identify = { rpcVersion: 1 };
      if (d.authentication) {
        const { challenge, salt } = d.authentication;
        identify.authentication = sha256b64(sha256b64(obsPassword() + salt) + challenge);
      }
      ws.send(JSON.stringify({ op: 1, d: identify }));
    } else if (op === 2) {
      resolve();
    } else if (op === 7) {
      const p = pending.get(d.requestId);
      if (!p) return;
      pending.delete(d.requestId);
      if (d.requestStatus.result) p.resolve(d.responseData || {});
      else p.reject(Object.assign(new Error(d.requestStatus.comment || 'request failed'), { code: d.requestStatus.code }));
    }
  };
});

await identified;

const { baseWidth, baseHeight } = await request('GetVideoSettings');
const { currentProgramSceneName: scene } = await request('GetCurrentProgramScene');
console.log(`scene: "${scene}" (canvas ${baseWidth}x${baseHeight})`);

const settings = {
  url: TICKER_URL,
  width: baseWidth,
  height: BAR_HEIGHT,
  shutdown: false, // keep running when source is hidden so the marquee never resets
};

let sceneItemId;
try {
  ({ sceneItemId } = await request('GetSceneItemId', { sceneName: scene, sourceName: INPUT_NAME }));
  await request('SetInputSettings', { inputName: INPUT_NAME, inputSettings: settings });
  console.log(`source "${INPUT_NAME}" already in scene — settings refreshed`);
} catch {
  try {
    ({ sceneItemId } = await request('CreateInput', {
      sceneName: scene,
      inputName: INPUT_NAME,
      inputKind: 'browser_source',
      inputSettings: settings,
    }));
    console.log(`created browser source "${INPUT_NAME}"`);
  } catch (e) {
    if (e.code !== 601) throw e; // 601 = input exists in another scene → just add it here
    await request('SetInputSettings', { inputName: INPUT_NAME, inputSettings: settings });
    ({ sceneItemId } = await request('CreateSceneItem', { sceneName: scene, sourceName: INPUT_NAME }));
    console.log(`source "${INPUT_NAME}" existed — added to scene "${scene}"`);
  }
}

await request('SetSceneItemTransform', {
  sceneName: scene,
  sceneItemId,
  sceneItemTransform: { positionX: 0, positionY: baseHeight - BAR_HEIGHT },
});
console.log(`pinned to bottom: y=${baseHeight - BAR_HEIGHT}, size ${baseWidth}x${BAR_HEIGHT}`);

// visual proof: grab a screenshot of the program scene
const shot = process.env.OBS_SCREENSHOT;
if (shot) {
  const { imageData } = await request('GetSourceScreenshot', {
    sourceName: scene,
    imageFormat: 'png',
    imageWidth: 1280,
  });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(shot, Buffer.from(imageData.split(',')[1], 'base64'));
  console.log(`screenshot: ${shot}`);
}

ws.close();
