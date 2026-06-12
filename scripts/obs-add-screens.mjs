// Adds (or updates) the "screens" full-canvas browser source in the current OBS scene.
// Zero dependencies — node scripts/obs-add-screens.mjs
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const INPUT_NAME = 'screens';
const URL_PAGE = process.env.SCREENS_URL || 'http://127.0.0.1:8722/screens';

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
      else p.reject(Object.assign(new Error(d.requestStatus.comment || 'request failed'), { code: d.requestStatus.code }));
    }
  };
});

const { baseWidth, baseHeight } = await request('GetVideoSettings');
const { currentProgramSceneName: scene } = await request('GetCurrentProgramScene');
const settings = { url: URL_PAGE, width: baseWidth, height: baseHeight, shutdown: false };

let sceneItemId;
try {
  ({ sceneItemId } = await request('GetSceneItemId', { sceneName: scene, sourceName: INPUT_NAME }));
  await request('SetInputSettings', { inputName: INPUT_NAME, inputSettings: settings });
  console.log(`source "${INPUT_NAME}" already in scene "${scene}" — settings refreshed`);
} catch {
  try {
    ({ sceneItemId } = await request('CreateInput', {
      sceneName: scene,
      inputName: INPUT_NAME,
      inputKind: 'browser_source',
      inputSettings: settings,
    }));
    console.log(`created browser source "${INPUT_NAME}" in scene "${scene}"`);
  } catch (e) {
    if (e.code !== 601) throw e;
    await request('SetInputSettings', { inputName: INPUT_NAME, inputSettings: settings });
    ({ sceneItemId } = await request('CreateSceneItem', { sceneName: scene, sourceName: INPUT_NAME }));
    console.log(`source "${INPUT_NAME}" existed — added to scene "${scene}"`);
  }
}

await request('SetSceneItemTransform', {
  sceneName: scene,
  sceneItemId,
  sceneItemTransform: { positionX: 0, positionY: 0 },
});
// top of the stack so it covers everything, including the ticker
const { sceneItems } = await request('GetSceneItemList', { sceneName: scene });
await request('SetSceneItemIndex', { sceneName: scene, sceneItemId, sceneItemIndex: sceneItems.length - 1 });
console.log(`pinned full-canvas ${baseWidth}x${baseHeight}, moved to top of scene "${scene}"`);
ws.close();
