'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// 只比较常驻服务源码,不把 key/槽位/会话/日志等运行时数据算进去。
// 服务启动时留一份,管理命令现算一份;不按 mtime 猜,也不自动重启活跃会话。
function codeRevision(root) {
  try {
    const files = ['mixrouter.js'];
    const walk = dir => {
      for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(file);
      }
    };
    walk('lib');
    const hash = crypto.createHash('sha256');
    for (const file of files.sort()) {
      hash.update(file).update('\0').update(fs.readFileSync(path.join(root, file))).update('\0');
    }
    return hash.digest('hex');
  } catch { return ''; } // 读不到就报无法核对,不能伪装成已加载
}

module.exports = { codeRevision };
