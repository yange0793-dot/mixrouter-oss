'use strict';
// 独立进程只读临时配置;不启动真实控制台或常驻实例。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const SCENARIOS = ['success', '429', '500', 'first-byte', 'idle', 'deadline', '401'];
const BUDGETS = { total: 1200, first: 250, idle: 400 };

async function main() {
  const seen = [];
  process.once('disconnect', () => process.exit(0));
  const mock = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const [, side, scenario] = req.url.split('/');
      seen.push({ side, scenario });
      if (side === 'primary' && scenario === 'first-byte') return;
      if (side === 'primary' && ['429', '500', '401'].includes(scenario)) {
        res.writeHead(Number(scenario), { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `injected ${scenario}` } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"diagnostic","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n');
      if (side === 'primary' && scenario === 'idle') return;
      if (side === 'primary' && scenario === 'deadline') {
        const timer = setInterval(() => res.write(': mock heartbeat\n\n'), 50);
        res.once('close', () => clearInterval(timer));
        return;
      }
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${mock.address().port}`;
  const providers = SCENARIOS.flatMap(scenario => ['primary', 'backup'].map(side => ({
    id: `${scenario}-${side}`, name: `${scenario}-${side}`, enabled: true,
    base_url: `${base}/${side}/${scenario}`, api_key: 'sk-offline-diagnostic-placeholder', models: [scenario],
  })));
  fs.mkdirSync(path.join(process.env.MIXR_DATA_DIR, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(process.env.MIXR_DATA_DIR, 'providers.json'), JSON.stringify({ version: 2, current: {}, claude: providers, codex: [] }));
  fs.writeFileSync(path.join(process.env.MIXR_DATA_DIR, 'routes.json'), JSON.stringify({
    rules: SCENARIOS.map(scenario => ({ id: scenario, match: scenario, enabled: true, strategy: 'priority',
      pool: ['primary', 'backup'].map(side => ({ provider: `${scenario}-${side}`, model: scenario })) })), default: {},
  }));
  Object.assign(process.env, {
    MIXR_TOTAL_DEADLINE_MS: String(BUDGETS.total), MIXR_STREAM_FIRST_HEADER_TIMEOUT_MS: String(BUDGETS.first),
    MIXR_FIRST_HEADER_TIMEOUT_MS: '5000', MIXR_STREAM_IDLE_TIMEOUT_MS: String(BUDGETS.idle),
    MIXR_NONSTREAM_TOTAL_TIMEOUT_MS: '5000', MIXR_SSE_KEEPALIVE_MS: '0', MIXR_MAX_ATTEMPTS: '2', MIXR_CONV_RETRIES: '0',
  });
  const router = require('../../mixrouter.js');
  const proxy = await router.listen(0, router.proxyHandler);
  process.on('message', message => {
    if (message === 'report') {
      const file = path.join(process.env.MIXR_DATA_DIR, 'logs', 'requests.jsonl');
      const logs = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
      process.send({ type: 'report', seen, logs: logs.map(({ model_in, status, attempts, failover, err_class, err }) => ({ model_in, status, attempts, failover, err_class, err })) });
    }
  });
  process.send({ type: 'ready', port: proxy.address().port, budgets: BUDGETS });
}
if (require.main === module) main().catch(() => { process.exitCode = 1; if (process.connected) process.disconnect(); });
module.exports = { SCENARIOS, BUDGETS };
