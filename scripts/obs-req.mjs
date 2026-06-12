// Generic obs-websocket request: node scripts/obs-req.mjs <RequestType> ['<json requestData>']
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [requestType, dataJson] = process.argv.slice(2);
if (!requestType) {
  console.error('usage: node scripts/obs-req.mjs <RequestType> [\'{"key":"value"}\']');
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

ws.onerror = () => {
  console.error('cannot connect to OBS websocket');
  process.exit(1);
};
ws.onmessage = (e) => {
  const { op, d } = JSON.parse(e.data);
  if (op === 0) {
    const identify = { rpcVersion: 1 };
    if (d.authentication) {
      const { challenge, salt } = d.authentication;
      identify.authentication = sha256b64(sha256b64(obsPassword() + salt) + challenge);
    }
    ws.send(JSON.stringify({ op: 1, d: identify }));
  } else if (op === 2) {
    ws.send(JSON.stringify({
      op: 6,
      d: { requestType, requestId: '1', requestData: dataJson ? JSON.parse(dataJson) : {} },
    }));
  } else if (op === 7) {
    if (!d.requestStatus.result) {
      console.error(`error ${d.requestStatus.code}: ${d.requestStatus.comment || ''}`);
      process.exit(1);
    }
    console.log(JSON.stringify(d.responseData || {}, null, 2));
    ws.close();
  }
};
