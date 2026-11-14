'use strict';
// 部署台账(deploy-live.sh 写的 .run/deploy-state.json)的一致性检查。
//
// 台账回答的是"上一次部署想切到哪、切完后真正跑的是哪个进程/哪份源码"。它**不阻断**任何命令:
// 不一致只说明台账过期,是排查时的线索,不是 status 的前置条件。所以这里只返回一句人话,
// 由 mixctl 打印;没有不一致、文件不存在、JSON 坏了都返回 null,不抛。
//
// 字段缺失一律跳过:旧版部署脚本写的台账没有 pid / code_revision,总不能因此永远报警。
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const shortRevision = value => String(value || '').slice(0, 12);

function currentHead(root) {
  try {
    return execSync(`git -C ${JSON.stringify(root)} rev-parse HEAD`, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return ''; }
}

// options: { root, runDir?, pid, revision?, head? }
//   pid      —— 当前实际在跑的进程 pid(未运行传 0)
//   revision —— 运行进程报告的 code_revision(读不到传空)
//   head     —— 当前代码目录 HEAD;不传则现场用 git 解析(仅测试需要显式给)
function deployLedgerWarning(options = {}) {
  const { root, pid, revision, head } = options;
  const file = path.join(options.runDir || path.join(root, '.run'), 'deploy-state.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const issues = [];
  if (state.pid !== undefined && state.pid !== null) {
    const recorded = Number(state.pid);
    const actual = Number(pid) || 0;
    if (!Number.isInteger(recorded) || recorded !== actual)
      issues.push(`pid ${state.pid} ≠ 当前 ${actual || '未运行'}`);
  }
  if (typeof state.target_commit === 'string' && state.target_commit) {
    const actualHead = head === undefined ? currentHead(root) : head;
    if (actualHead && state.target_commit !== actualHead)
      issues.push(`target_commit ${shortRevision(state.target_commit)} ≠ 当前 HEAD ${shortRevision(actualHead)}`);
  }
  if (typeof state.code_revision === 'string' && state.code_revision && revision
      && state.code_revision !== revision)
    issues.push('code_revision 与运行进程不符');
  return issues.length ? `部署台账过期/不一致:${issues.join(';')}(${file})` : null;
}

module.exports = { deployLedgerWarning, currentHead };
