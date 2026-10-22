'use strict';
// 生成一个**最小但完整**的运行包目录,供 release-update 的校验/安装/回退用例使用。
// 文件清单与 scripts/release-manifest.js 的必备条目对齐 —— 夹具不完整,校验逻辑就测不出
// "缺入口会被拒绝"这一类行为。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const manifest = require('../scripts/release-manifest.js');

// 必备文件直接取自制品清单,**不在这里抄一份**:清单会在功能迭代里增删入口
// (例如控制台新增 js/css),夹具抄一份就会在别人改清单时假红。
const FILES = [...new Set([
  ...manifest.REQUIRED_ENTRIES,
  ...manifest.REQUIRED_MAINTENANCE_ENTRIES,
])].filter(rel => rel !== 'mixrouter.js' && rel !== 'package.json');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeRelease(dir, { version = '3.9.1', lib = '// fixture\n', revision = 'a'.repeat(40) } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  write(path.join(dir, 'package.json'), JSON.stringify({
    name: 'mixrouter', version, engines: { node: '>=18' },
  }, null, 2) + '\n');
  write(path.join(dir, 'mixrouter.js'), `'use strict';\nconst VERSION = '${version}';\n`);
  // 真实的 runtime-code:code_revision 必须能在这份目录里现算。
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'lib', 'runtime-code.js'), path.join(dir, 'lib', 'runtime-code.js'));
  write(path.join(dir, 'lib', 'fixture.js'), lib);
  for (const rel of FILES) write(path.join(dir, rel), '');
  const { codeRevision } = require('../lib/runtime-code');
  return { dir, version, revision, code_revision: codeRevision(dir) };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// 打出一个名字符合官方约定的包,并写出同目录的 .sha256 与 RELEASE-INFO.json。
function makeArchive(base, release, { extraFiles = [] } = {}) {
  fs.mkdirSync(base, { recursive: true });
  for (const entry of extraFiles) write(path.join(release.dir, entry.rel), entry.content);
  const archive = path.join(base, `mixrouter-${release.version}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', release.dir, '.'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const hash = sha256(archive);
  fs.writeFileSync(`${archive}.sha256`, `${hash}  ${path.basename(archive)}\n`);
  const info = path.join(base, `mixrouter-${release.version}.RELEASE-INFO.json`);
  fs.writeFileSync(info, JSON.stringify({
    name: 'mixrouter', version: release.version, revision: release.revision,
    code_revision: release.code_revision,
  }, null, 2) + '\n');
  return { archive, sha256: hash, info, sidecar: `${archive}.sha256` };
}

module.exports = { makeRelease, makeArchive, sha256, write };
