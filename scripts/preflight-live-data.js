#!/usr/bin/env node
'use strict';
// 上线前预检:拿**线上数据文件的副本**喂给新版代码,在临时端口上验"能不能加载 + 控制台资源齐不齐"。
// 全程只读线上目录(只 cp),不碰线上进程、端口、LaunchAgent;新进程写的是副本。
//
// 这是**运维脚本**,与 scripts/deploy-live.sh 配套使用,不随源码包发布(见
// scripts/release-manifest.js 的 EXCLUDE)。线上目录必须由 MIXR_LIVE_DIR 显式给出 ——
// 写死任何人的目录都会在别人的机器上指错,而"指错"在这里的表现是拿空数据跑一遍全绿。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const LIVE = process.env.MIXR_LIVE_DIR || '';
if (!LIVE) {
  console.log('需要 MIXR_LIVE_DIR=<线上 git 克隆的绝对路径>,例如:\n'
    + '  MIXR_LIVE_DIR="$HOME/src/mixrouter" node scripts/preflight-live-data.js');
  process.exit(2);
}
if (!fs.existsSync(path.join(LIVE, 'mixrouter.js'))) {
  console.log(`MIXR_LIVE_DIR 下没有 mixrouter.js,不像线上目录: ${LIVE}`);
  process.exit(2);
}
const DEV = path.resolve(__dirname, '..');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-preflight-'));
const home = path.join(root, 'home');
const data = path.join(root, 'data');
for (const d of [home, data, path.join(root, 'img'), path.join(root, 'tmp')]) fs.mkdirSync(d, { recursive: true });

// 复制线上数据(只读来源),让新代码去写副本
let copied = [];
for (const f of ['providers.json', 'routes.json', 'slots.json', 'dsh.json', 'sessions.json']) {
  const s = path.join(LIVE, f);
  if (fs.existsSync(s)) { fs.copyFileSync(s, path.join(data, f)); copied.push(f); }
}

process.env.HOME = home;
process.env.MIXR_DATA_DIR = data;
process.env.MIXR_CLAUDE_SETTINGS = path.join(home, '.claude', 'settings.json');
process.env.MIXR_CODEX_CONFIG = path.join(home, '.codex', 'config.toml');
process.env.MIXR_ZCODE_CONFIG = path.join(home, '.zcode', 'v2', 'config.json');
process.env.MIXROUTER_PORT = '0';
process.env.MIXUI_PORT = '0';
process.env.TMPDIR = path.join(root, 'tmp');

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); };

const get = (port, p) => new Promise(resolve => {
  const req = http.request({ hostname: '127.0.0.1', port, path: p, method: 'GET' }, res => {
    let b = '';
    res.on('data', d => { b += d; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
  });
  req.on('error', e => resolve({ status: 0, error: e.message, body: '' }));
  req.setTimeout(8000, () => { req.destroy(); resolve({ status: 0, error: 'timeout', body: '' }); });
  req.end();
});

(async () => {
  let mod;
  try { mod = require(path.join(DEV, 'mixrouter.js')); }
  catch (e) { console.log('FAIL 新版 mixrouter.js 无法 require:', e.message); process.exit(1); }

  // 真值来源:线上 /api/state 的计数(只读)
  let liveState = null;
  try {
    const r = await get(8788, '/api/state');
    liveState = JSON.parse(r.body);
  } catch { /* 线上读不到就不比计数 */ }

  const srv = await mod.listen(0, mod.apiHandler);
  const ui = srv.address().port;
  try {
    const st = await get(ui, '/api/state');
    check('GET /api/state 返回 200', st.status === 200, 'status=' + st.status);
    let d = null;
    try { d = JSON.parse(st.body); check(' /api/state 是合法 JSON', true); }
    catch (e) { check(' /api/state 是合法 JSON', false, e.message); }

    if (d) {
      const c = (d.providers && d.providers.claude || []).length;
      const x = (d.providers && d.providers.codex || []).length;
      const rules = (d.routes && d.routes.rules || []).length;
      check(`渠道数 claude=${c} codex=${x}`, c > 0 && x > 0, `claude=${c} codex=${x}`);
      check(`路由规则数 ${rules}`, rules > 0, String(rules));
      if (liveState) {
        const lc = (liveState.providers.claude || []).length, lx = (liveState.providers.codex || []).length;
        const lr = (liveState.routes.rules || []).length;
        check('渠道数与线上一致', c === lc && x === lx, `新=${c}/${x} 线上=${lc}/${lx}`);
        check('规则数与线上一致', rules === lr, `新=${rules} 线上=${lr}`);
      }
      check('会话表可读(数量与线上比对)', Array.isArray(d.sessions),
        `新=${(d.sessions || []).length} 线上=${liveState ? (liveState.sessions || []).length : '?'}`);
    }

    // 控制台三件套:HTML + 外置 CSS/JS(新版才有的静态资源服务)
    const html = await get(ui, '/');
    check('GET / 200 且是 HTML', html.status === 200 && /text\/html/.test(html.headers['content-type'] || ''), 'status=' + html.status);
    check(' index.html 引用了外置 css/js', /\/styles\/base\.css/.test(html.body) && /\/js\/app\.js/.test(html.body));
    const css = await get(ui, '/styles/base.css');
    check('GET /styles/base.css 200', css.status === 200, 'status=' + css.status);
    const js = await get(ui, '/js/app.js');
    check('GET /js/app.js 200', js.status === 200, 'status=' + js.status);
    // 越界防护再验一次(预检也要覆盖)
    const trav = await get(ui, '/..%2f..%2fproviders.json');
    check('编码穿越被挡', trav.status !== 200, 'status=' + trav.status);

    check('GET /healthz 200', (await get(ui, '/healthz')).status === 200);
  } finally {
    try { srv.close(); } catch {}
  }

  let bad = 0;
  for (const r of results) { if (!r.pass) bad++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`); }
  console.log(`\n数据副本: ${copied.join(', ')}`);
  console.log(`预检 ${results.length - bad}/${results.length} 通过`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('预检异常:', e && e.stack || e); process.exit(1); });
