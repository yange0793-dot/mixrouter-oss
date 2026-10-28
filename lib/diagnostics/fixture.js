'use strict';
// 独立进程只读临时配置;不启动真实控制台或常驻实例。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const SCENARIOS = ['success', '429', '500', 'first-byte', 'idle', 'deadline', '401'];
// 需要"主渠道失败 → 备渠道接过"的三个场景各占一个 Claude 槽位(槽名固定五个)。
// 其余场景只有主渠道一份,直接按**精确已登记模型**落点,请求就发模型本名。
const SLOT_SCENARIOS = { 429: 'main', 500: 'opus', 'first-byte': 'sonnet' };
const modelOf = scenario => SLOT_SCENARIOS[scenario] ? 'mixr-' + SLOT_SCENARIOS[scenario] : scenario;
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
  // 主备两家的落点模型不同名:瘦身后同名模型登记在两个渠道就是明确歧义(409),
  // 而诊断要的是"主渠道失败 → 备渠道接过",所以主备用各自身份模型,由**槽位**绑成一个池。
  const providers = SCENARIOS.flatMap(scenario => ['primary', 'backup'].map(side => ({
    id: `${scenario}-${side}`, name: `${scenario}-${side}`, enabled: true,
    base_url: `${base}/${side}/${scenario}`, api_key: 'sk-offline-diagnostic-placeholder',
    // 主备登记不同的模型名,免得同名登记在两个渠道被判成歧义(409)
    models: [side === 'primary' ? scenario : `${scenario}-backup`],
  })));
  fs.mkdirSync(path.join(process.env.MIXR_DATA_DIR, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(process.env.MIXR_DATA_DIR, 'providers.json'), JSON.stringify({ version: 2, current: {}, claude: providers, codex: [] }));
  // routes.json 只承载压缩设置;主备关系由槽位表表达(Claude 槽名固定五个,够放下三个要转移的场景)
  fs.writeFileSync(path.join(process.env.MIXR_DATA_DIR, 'routes.json'), JSON.stringify({ rules: [] }));
  fs.writeFileSync(path.join(process.env.MIXR_DATA_DIR, 'slots.json'), JSON.stringify({ version: 1,
    claude: Object.fromEntries(Object.entries(SLOT_SCENARIOS).map(([scenario, slot]) => [slot, {
      provider: `${scenario}-primary`, model: scenario,
      pool: [{ provider: `${scenario}-backup`, model: `${scenario}-backup` }], strategy: 'priority',
    }])), codex: {} }));
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
module.exports = { SCENARIOS, BUDGETS, SLOT_SCENARIOS, modelOf };
