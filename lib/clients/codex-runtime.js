'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');

async function connectCodex(socketPath, { timeoutMs = 5000, onNotification = () => {} } = {}) {
  const sockets = new Set(), pending = new Map();
  let ws, sequence = 0, closed = false;
  const fail = error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  // Node's native WebSocket handles framing; a short-lived loopback bridge supplies Unix transport.
  const bridge = net.createServer(client => {
    const upstream = net.connect(socketPath);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => { client.destroy(); upstream.destroy(); });
    }
    client.pipe(upstream).pipe(client);
  });
  const close = () => {
    if (closed) return;
    closed = true;
    fail(new Error('Codex 运行时连接已关闭'));
    if (ws?.readyState === WebSocket.OPEN) ws.close();
    for (const socket of sockets) socket.destroy();
    bridge.close();
  };
  try {
    bridge.listen(0, '127.0.0.1');
    await once(bridge, 'listening');
    ws = new WebSocket(`ws://127.0.0.1:${bridge.address().port}/`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 Codex 运行时超时')), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('无法连接 Codex 运行时')); }, { once: true });
    });
    ws.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); }
      catch { fail(new Error('Codex 返回了无效的运行时消息')); return; }
      const item = pending.get(message.id);
      if (!item) {
        if (message.method) onNotification(message);
        return;
      }
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error(message.error.message));
      else item.resolve(message.result);
    });
    ws.addEventListener('close', () => fail(new Error('Codex 运行时连接已断开')));
    ws.addEventListener('error', () => fail(new Error('Codex 运行时通信失败')));
    const request = (method, params) => new Promise((resolve, reject) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return reject(new Error('Codex 运行时未连接'));
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex 运行时操作超时')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const initialized = await request('initialize', {
      clientInfo: { name: 'mixrouter', version: '3.10.0' }, capabilities: { experimentalApi: true },
    });
    ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    return { request, close, home: initialized.codexHome };
  } catch (error) { close(); throw error; }
}

async function syncCodexModel({ configFile, before, after, connect = connectCodex }) {
  const result = { status: 'not_running', updated: 0, skipped: 0, failed: 0 };
  if (before.provider !== after.provider) return { ...result, status: 'restart_required' };
  const home = path.dirname(configFile);
  const socketPath = path.join(home, 'app-server-control', 'app-server-control.sock');
  if (!fs.existsSync(socketPath)) return result;
  if (typeof WebSocket === 'undefined') return { ...result, status: 'unsupported' };
  let client;
  try {
    client = await connect(socketPath);
    if (!client.home || fs.realpathSync(client.home) !== fs.realpathSync(home))
      return { ...result, status: 'home_mismatch' };
    let cursor = null;
    do {
      const page = await client.request('thread/loaded/list', { cursor, limit: 100 });
      for (const threadId of page.data) {
        try {
          const { thread } = await client.request('thread/read', { threadId, includeTurns: false });
          // Explicit per-thread models and workers keep their own settings.
          if (thread.modelProvider !== before.provider || thread.model !== before.model ||
              (thread.source && typeof thread.source === 'object' && thread.source.subAgent)) {
            result.skipped++;
            continue;
          }
          await client.request('thread/settings/update', { threadId, model: after.model });
          const checked = await client.request('thread/read', { threadId, includeTurns: false });
          if (checked.thread.model !== after.model) throw new Error('Codex 未确认新模型');
          result.updated++;
        } catch { result.failed++; }
      }
      cursor = page.nextCursor;
    } while (cursor);
    result.status = result.failed ? 'partial' : result.updated ? 'applied' : 'no_matching_threads';
  } catch { result.status = result.updated ? 'partial' : 'unavailable'; }
  finally { client?.close(); }
  return result;
}

module.exports = { connectCodex, syncCodexModel };
