'use strict';
// mixrouter 侧日志清理接线的回归:确认 startLogRetention() 会用**服务实际的数据目录**
// (MIXR_DATA_DIR/logs)清一次,且可重入(已起定时器后再调不重复清、不抛)。
// 全程只用 mkdtemp 临时目录 + 内存,不碰现役 logs/、不读真实渠道、不起常驻端口。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-retention-wiring-'));
process.env.MIXR_DATA_DIR = root;
process.env.MIXR_LOG_RETAIN_DAYS = '2';
const logs = path.join(root, 'logs');
fs.mkdirSync(logs, { recursive: true });
const DAY = 24 * 3600 * 1000;
const now = Date.now();
const iso = ms => new Date(ms).toISOString();
const line = ts => JSON.stringify({ ts: new Date(ts).toISOString(), app: 'claude', status: 200 });
const archive = (ms, hex = 'a'.repeat(32)) => `${ms}-${hex}`;
// 两类产物:一个超期归档 + 一个窗内归档;外加 launchd.log(一旧一新两行)
// 与 requests.jsonl(超期内容,用来钉住「本模块不碰它」)
fs.mkdirSync(path.join(logs, 'responses', archive(now - 3 * DAY)), { recursive: true });
fs.mkdirSync(path.join(logs, 'responses', archive(now - 1 * DAY)), { recursive: true });
const launchdBody = `${iso(now - 3 * DAY)} old boot\n${iso(now - 1 * DAY)} fresh boot\n`;
fs.writeFileSync(path.join(logs, 'launchd.log'), launchdBody);
const reqBody = [line(now - 3 * DAY), line(now - 1 * DAY)].join('\n') + '\n';
fs.writeFileSync(path.join(logs, 'requests.jsonl'), reqBody);

const mixr = require('../mixrouter.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('startLogRetention 用 MIXR_DATA_DIR/logs 清一次:旧归档删、窗内留、launchd 旧行清掉', () => {
  mixr.startLogRetention();
  assert.equal(fs.existsSync(path.join(logs, 'responses', archive(now - 3 * DAY))), false, '启动清理应删超期归档');
  assert.equal(fs.existsSync(path.join(logs, 'responses', archive(now - 1 * DAY))), true, '窗内归档保留');
  const launchd = fs.readFileSync(path.join(logs, 'launchd.log'), 'utf8');
  assert.doesNotMatch(launchd, /old boot/, 'launchd.log 超期行应清掉');
  assert.match(launchd, /fresh boot/, '窗内行保留');
});

test('startLogRetention 不碰 requests.jsonl(那是 log-files 轮转的地盘)', () => {
  assert.equal(fs.readFileSync(path.join(logs, 'requests.jsonl'), 'utf8'), reqBody, 'requests.jsonl 必须逐字节不动');
});

test('可重入:已起定时器后再调不重复清、不抛', () => {
  assert.equal(mixr.startLogRetention(), undefined, '第二次调用应早退');
});
