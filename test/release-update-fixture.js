'use strict';
// 生成一个**最小但完整**的运行包目录,供 release-update 的校验/安装/回退用例使用。
// 文件清单与 scripts/release-manifest.js 的必备条目对齐 —— 夹具不完整,校验逻辑就测不出
// "缺入口会被拒绝"这一类行为。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
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

// ---------------------------------------------------------------- 手工 tar
// 造**恶意**包不能用系统 tar:它自己就会做安全检查。GNU tar(Linux)在打包时把 `../`
// 直接剥掉,于是 `tar -czf x.tar.gz -C root ../evil.txt` 产出的成员名是 `evil.txt`,
// 包里根本没有穿越路径 —— 在 Linux 上这个用例会静默变成"正常包解包成功",
// 断言抛错就失败;而 macOS 的 bsdtar 保留 `../`,本机一直通过。测试要验证的是
// "解包器拒绝穿越",不是"某个 tar 版本会不会剥",所以这里自己按 ustar 格式写字节。
function octal(value, length) {
  // tar 头里的数值字段是**八进制**数字串 + NUL。写成十进制不会报错,只会让 tar 报
  // "Unrecognized archive format" —— 整条用例会以错误的方式失败。
  return Math.trunc(Number(value) || 0).toString(8).padStart(length - 1, '0') + '\0';
}

function header({ name, size = 0, mode = 0o644, type = '0', linkname = '', mtime = 0 }) {
  if (Buffer.byteLength(name) > 100) throw new Error(`夹具只支持 100 字节以内的成员名:${name}`);
  const buf = Buffer.alloc(512, 0);
  buf.write(name, 0, 100, 'utf8');
  buf.write(octal(mode, 8), 100);
  buf.write(octal(0, 8), 108);
  buf.write(octal(0, 8), 116);
  buf.write(octal(size, 12), 124);
  buf.write(octal(mtime, 12), 136);
  buf.write('        ', 148); // 校验和先按空格算
  buf.write(type, 156, 1, 'utf8');
  buf.write(linkname, 157, 100, 'utf8');
  buf.write('ustar\0', 257, 6, 'binary');
  buf.write('00', 263, 2, 'binary');
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(octal(sum, 7) + ' ', 148);
  return buf;
}

// entries: [{ name, content }] 普通文件;{ name, type: 'symlink', linkname } 链接。
// 名字原样写进包头,不做任何规范化 —— 这正是造 `../` 与绝对路径用例需要的行为。
function makeRawArchive(file, entries) {
  const blocks = [];
  for (const entry of entries) {
    const body = entry.type === 'symlink' ? Buffer.alloc(0) : Buffer.from(entry.content ?? '', 'utf8');
    blocks.push(header({
      name: entry.name, size: body.length, type: entry.type === 'symlink' ? '2' : '0',
      linkname: entry.linkname || '', mode: entry.mode ?? 0o644,
    }));
    if (body.length) {
      blocks.push(body);
      const pad = (512 - (body.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0)); // 两个全零块结束
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(blocks)));
  return file;
}

module.exports = { makeRelease, makeArchive, makeRawArchive, sha256, write };
