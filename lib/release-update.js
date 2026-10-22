'use strict';
// Release 获取、校验、解包与安装的**唯一**实现。
//
// ---- 设计前提 ----
//   1. **默认不联网。** 本模块只提供"怎么查/怎么下",是否联网由 CLI 的显式参数决定。
//      仓库固定为 OFFICIAL,没有 --repo / --url 的入口:可替换的下载源等于把"官方发布"
//      这句话作废,用户无法只凭命令行判断拿到的是什么。
//   2. **只信任固定 HTTPS 主机。** 每一跳重定向都重新校验(协议/主机/端口/凭据),
//      不只校验第一次给的 URL —— 重定向恰恰是最容易被利用的那一段。
//   3. **先验后用。** 校验和 → 解包成员路径检查(拒绝绝对路径、`..`、符号链接)
//      → 解包后再走一遍 lstat → 版本三处一致(package.json / 入口 VERSION / RELEASE-INFO)
//      → 运行期源码指纹 → 制品清单。任何一步失败都不进入"安装"。
//   4. **安装是不可变目录 + 原子切换。** 新版本先写 releases/.staging-*,整份就绪后
//      rename;current 用"临时符号链接 + rename"原子替换。数据目录一个字节都不写。
//
// require 本模块零副作用:不读环境、不建目录、不联网。CLI 在 scripts/ 下。

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { codeRevision } = require('./runtime-code');
const manifest = require('../scripts/release-manifest.js');

const OFFICIAL = Object.freeze({ owner: 'yange0793-dot', repo: 'mixrouter-oss' });
// github.com 负责 /releases/download 的跳转,实际字节来自 objects/release-assets CDN。
const TRUSTED_HOSTS = Object.freeze([
  'api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
]);
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_JSON_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const RELEASE_INFO_KEYS = Object.freeze(['name', 'version', 'revision', 'code_revision']);

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

// ---------------------------------------------------------------- 版本
function parseVersion(input) {
  const raw = String(input == null ? '' : input).trim().replace(/^[vV]/, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw);
  if (!match) return null;
  return {
    version: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4] ? `-${match[4]}` : ''}`,
    major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.').map(part => (/^\d+$/.test(part) ? Number(part) : part)) : [],
  };
}

function requireVersion(input, label = 'version') {
  const parsed = parseVersion(input);
  if (!parsed) throw fail('invalid_version', `${label} 不是 x.y.z 形式:${JSON.stringify(input)}`);
  return parsed;
}

// 只用 semver 里升级判断真正需要的部分:数字段逐段比,预发布版低于同版本正式版。
function compareVersions(left, right) {
  const a = requireVersion(left, '左版本');
  const b = requireVersion(right, '右版本');
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function assetNames(version) {
  const ver = requireVersion(version).version;
  const base = `mixrouter-${ver}`;
  return Object.freeze({
    version: ver,
    archive: `${base}.tar.gz`,
    sha256: `${base}.tar.gz.sha256`,
    releaseInfo: `${base}.RELEASE-INFO.json`,
  });
}

function releaseNameFor(version, revision) {
  const ver = requireVersion(version).version;
  const rev = String(revision || '').slice(0, 8) || 'norev';
  return `${ver}-${rev}`;
}

// ---------------------------------------------------------------- URL 信任边界
function assertTrustedUrl(value, { hosts = TRUSTED_HOSTS } = {}) {
  let url;
  try { url = new URL(String(value)); }
  catch { throw fail('untrusted_url', `无法解析的下载地址:${JSON.stringify(value)}`); }
  if (url.protocol !== 'https:') throw fail('untrusted_url', `只允许 https 下载地址,实得 ${url.protocol}//${url.hostname}`);
  if (url.username || url.password) throw fail('untrusted_url', '下载地址里不允许带凭据');
  if (url.port && url.port !== '443') throw fail('untrusted_url', `只允许默认 443 端口,实得 :${url.port}`);
  if (!hosts.includes(url.hostname)) throw fail('untrusted_host', `不信任的主机:${url.hostname}(只允许 ${hosts.join(', ')})`);
  return url;
}

function assertReleaseAssetUrl(value) {
  const url = assertTrustedUrl(value);
  if (url.hostname === 'github.com' || url.hostname === 'api.github.com') {
    const prefix = `/${OFFICIAL.owner}/${OFFICIAL.repo}/releases/download/`;
    if (!url.pathname.startsWith(prefix))
      throw fail('untrusted_host', `发布附件地址必须位于 ${prefix},实得 ${url.pathname}`);
  }
  return url;
}

function releaseApiUrl(version) {
  if (version === undefined || version === null || version === '') {
    return `https://api.github.com/repos/${OFFICIAL.owner}/${OFFICIAL.repo}/releases/latest`;
  }
  const ver = requireVersion(version).version;
  return `https://api.github.com/repos/${OFFICIAL.owner}/${OFFICIAL.repo}/releases/tags/v${ver}`;
}

// ---------------------------------------------------------------- HTTP
function headerOf(headers, name) {
  if (!headers) return null;
  const key = Object.keys(headers).find(item => item.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

function httpsTransport(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(String(url), { method: 'GET', headers, timeout: timeoutMs }, res => {
      resolve({ status: res.statusCode, headers: res.headers, body: res, destroy: () => res.destroy() });
    });
    req.on('timeout', () => req.destroy(fail('timeout', `请求超时:${url}`)));
    req.on('error', error => reject(error));
    req.end();
  });
}

const destroyBody = response => {
  try { if (response && response.body && typeof response.body.destroy === 'function') response.body.destroy(); }
  catch { /* 已经关掉 */ }
};

async function fetchWithRedirects(url, { transport = httpsTransport, maxRedirects = MAX_REDIRECTS,
  timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, hosts = TRUSTED_HOSTS } = {}) {
  let current = String(url);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    assertTrustedUrl(current, { hosts });
    const response = await transport(current, { timeoutMs, headers });
    if (response.status >= 300 && response.status < 400) {
      const location = headerOf(response.headers, 'location');
      destroyBody(response);
      if (!location) throw fail('redirect_without_location', `重定向响应缺少 Location:${current}`);
      let next;
      try { next = new URL(String(location), current).toString(); }
      catch { throw fail('untrusted_url', `重定向目标无法解析:${location}`); }
      assertTrustedUrl(next, { hosts }); // 每一跳都查,不是只查入口
      current = next;
      continue;
    }
    if (response.status !== 200) {
      destroyBody(response);
      throw fail('http_status', `下载返回 HTTP ${response.status}:${current}`, { status: response.status });
    }
    return { ...response, url: current };
  }
  throw fail('too_many_redirects', `重定向超过 ${maxRedirects} 次:${url}`);
}

async function readLimited(body, maxBytes) {
  if (!body) throw fail('empty_body', '响应没有正文');
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maxBytes) {
      try { body.destroy(); } catch { /* 已经结束 */ }
      throw fail('too_large', `响应超过上限 ${maxBytes} 字节`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function fetchJson(url, { transport, timeoutMs, maxBytes = DEFAULT_MAX_JSON_BYTES,
  headers = {}, hosts } = {}) {
  const response = await fetchWithRedirects(url, {
    transport, timeoutMs, hosts,
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'mixrouter-release-update', ...headers },
  });
  let text;
  try { text = (await readLimited(response.body, maxBytes)).toString('utf8'); }
  catch (e) { destroyBody(response); throw e; }
  try { return JSON.parse(text); }
  catch { throw fail('invalid_json', `响应不是合法 JSON:${url}`); }
}

async function fetchText(url, { transport, timeoutMs, maxBytes = DEFAULT_MAX_JSON_BYTES, headers, hosts } = {}) {
  const response = await fetchWithRedirects(url, { transport, timeoutMs, hosts, headers });
  try { return (await readLimited(response.body, maxBytes)).toString('utf8'); }
  catch (e) { destroyBody(response); throw e; }
}

// ---------------------------------------------------------------- 发布元数据
function assetSize(asset) {
  const size = Number(asset && asset.size);
  return Number.isFinite(size) && size >= 0 ? size : null;
}

// 只接受**三个固定名字**的附件。GitHub 自动生成的 "Source code" 附件不是运行包,
// 名称恰好对不上,所以这里不会误选它。
function selectAssets(release, version, { maxArchiveBytes = DEFAULT_MAX_ARCHIVE_BYTES } = {}) {
  if (!release || typeof release !== 'object') throw fail('invalid_release', '发布元数据不是对象');
  const tag = String(release.tag_name || '');
  const parsed = requireVersion(tag || version, 'Release tag');
  const expected = requireVersion(version === undefined ? parsed.version : version);
  if (parsed.version !== expected.version)
    throw fail('version_mismatch', `Release tag ${tag} 与请求的版本 ${expected.version} 不一致`);
  const names = assetNames(expected.version);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const pick = name => {
    const matches = assets.filter(asset => asset && asset.name === name);
    if (matches.length > 1) throw fail('duplicate_asset', `Release 里出现多个同名附件:${name}`);
    return matches[0] || null;
  };
  const archive = pick(names.archive);
  const sha = pick(names.sha256);
  const info = pick(names.releaseInfo);
  if (!archive) throw fail('missing_asset', `Release 缺少运行包附件 ${names.archive}`);
  if (!sha) throw fail('missing_asset', `Release 缺少校验和附件 ${names.sha256}(没有校验和就无法验证下载内容)`);
  const size = assetSize(archive);
  if (size !== null && size > maxArchiveBytes)
    throw fail('asset_too_large', `运行包 ${names.archive} 有 ${size} 字节,超过上限 ${maxArchiveBytes}`);
  for (const asset of [archive, sha, info].filter(Boolean)) {
    if (typeof asset.browser_download_url !== 'string')
      throw fail('invalid_release', `附件 ${asset.name} 缺少 browser_download_url`);
    assertReleaseAssetUrl(asset.browser_download_url);
  }
  return { version: expected.version, names, archive, sha256: sha, releaseInfo: info, size };
}

function normalizeRelease(raw, version, options = {}) {
  const selected = selectAssets(raw, version, options);
  const tag = String(raw.tag_name || '');
  return {
    version: selected.version,
    tag,
    name: String(raw.name || tag || selected.version),
    htmlUrl: typeof raw.html_url === 'string' ? raw.html_url : null,
    publishedAt: typeof raw.published_at === 'string' ? raw.published_at : null,
    prerelease: raw.prerelease === true,
    draft: raw.draft === true,
    assets: selected,
  };
}

async function fetchRelease(version, { transport, timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_JSON_BYTES, maxArchiveBytes } = {}) {
  const text = await fetchJson(releaseApiUrl(version), { transport, timeoutMs, maxBytes });
  return normalizeRelease(text, version, { maxArchiveBytes });
}

// ---------------------------------------------------------------- 校验和
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// GitHub 的 `.sha256` 形如 `<hash>  mixrouter-3.9.1.tar.gz`(Linux)或 `<hash> *name`。
// 文件名必须与我们期望的附件名一致:只比哈希会把"另一份包的校验和"也当成通过。
function parseSha256(text, filename) {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) throw fail('invalid_checksum', '校验和文件是空的');
  const match = /^([0-9a-fA-F]{64})(?:\s+\*?(.+))?$/.exec(lines[0]);
  if (!match) throw fail('invalid_checksum', `校验和格式不对:${lines[0].slice(0, 120)}`);
  const hash = match[1].toLowerCase();
  const name = match[2] ? path.basename(match[2].trim()) : null;
  if (filename && name && name !== filename)
    throw fail('checksum_name_mismatch', `校验和对应的文件名是 ${name},期望 ${filename}`);
  return hash;
}

function parseContentLength(headers) {
  const raw = headerOf(headers, 'content-length');
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

// 下载 → 边写边算哈希 → 超限立即中止 → 校验和一致才落到 dest。
// 任何失败都删掉半截文件;调用方不会看到一个"部分下载"的路径。
async function downloadAsset({ url, dest, expectedSha256, maxBytes = DEFAULT_MAX_ARCHIVE_BYTES,
  transport, timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, hosts } = {}) {
  if (!dest) throw new TypeError('downloadAsset: 缺少 dest');
  assertReleaseAssetUrl(url);
  const response = await fetchWithRedirects(url, { transport, timeoutMs, headers, hosts });
  const declared = parseContentLength(response.headers);
  if (declared !== null && declared > maxBytes) {
    destroyBody(response);
    throw fail('too_large', `下载体积 ${declared} 字节超过上限 ${maxBytes}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const tmp = `${dest}.part-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) return callback(fail('too_large', `下载超过上限 ${maxBytes} 字节,已中止`));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(response.body, counter, fs.createWriteStream(tmp, { mode: 0o600 }));
    const actual = hash.digest('hex');
    if (expectedSha256 && actual !== String(expectedSha256).toLowerCase()) {
      throw fail('sha256_mismatch', `下载校验失败:期望 ${expectedSha256},实得 ${actual}`);
    }
    fs.renameSync(tmp, dest);
    return { path: dest, bytes, sha256: actual };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 没有半截文件 */ }
    destroyBody(response);
    throw e;
  }
}

// ---------------------------------------------------------------- 解包
function normalizeMember(name) {
  return String(name).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

// 路径穿越检查。tar 自己通常也会拦,但"通常"不是契约;这里在解包前就把成员名单验一遍,
// 不依赖具体 tar 实现的版本行为。
function validateMember(name) {
  if (!name || name.includes('\0')) throw fail('unsafe_archive', `压缩包里有空路径或 NUL 字符:${JSON.stringify(name)}`);
  if (name.startsWith('/') || /^[A-Za-z]:\//.test(name)) throw fail('unsafe_archive', `压缩包里有绝对路径:${name}`);
  const parts = name.split('/');
  if (parts.some(part => part === '..')) throw fail('unsafe_archive', `压缩包里有路径穿越:${name}`);
  return normalizeMember(name);
}

function listArchiveMembers(archive, { execFileSyncImpl = execFileSync } = {}) {
  let out;
  try {
    out = execFileSyncImpl('tar', ['-tzf', archive], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw fail('archive_unreadable', `无法读取压缩包 ${archive}:${String(e.stderr || e.message).trim().slice(0, 200)}`);
  }
  const members = String(out).split(/\r?\n/).filter(Boolean);
  if (!members.length) throw fail('invalid_archive', '压缩包是空的');
  return members.map(validateMember).filter(Boolean);
}

// 类型检查:拒绝符号链接/硬链接/设备文件。恶意包可以放一个指向 /etc 的链接,
// 再让后续成员穿过它写出去;即使当前 tar 实现会拦,也不该把安全建立在实现细节上。
function assertArchiveTypes(archive, { execFileSyncImpl = execFileSync } = {}) {
  let out;
  try {
    out = execFileSyncImpl('tar', ['-tvzf', archive], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw fail('archive_unreadable', `无法读取压缩包类型列表:${String(e.stderr || e.message).trim().slice(0, 200)}`);
  }
  for (const line of String(out).split(/\r?\n/)) {
    if (!line) continue;
    const type = line[0];
    if (type === 'l' || type === 'h') throw fail('unsafe_archive', `压缩包里包含链接成员,拒绝解包:${line.slice(0, 160)}`);
    if (type === 'b' || type === 'c' || type === 'p' || type === 's')
      throw fail('unsafe_archive', `压缩包里包含特殊文件,拒绝解包:${line.slice(0, 160)}`);
  }
}

function walkTree(dir, visit, base = dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    const stat = fs.lstatSync(full);
    visit(full, rel, stat, entry);
    if (stat.isDirectory()) walkTree(full, visit, base);
  }
}

function extractArchive({ archive, dest, execFileSyncImpl = execFileSync } = {}) {
  if (!archive || !fs.existsSync(archive)) throw fail('archive_missing', `压缩包不存在:${archive}`);
  const members = listArchiveMembers(archive, { execFileSyncImpl });
  assertArchiveTypes(archive, { execFileSyncImpl });
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  try {
    execFileSyncImpl('tar', ['-xzf', archive, '-C', dest], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
    });
  } catch (e) {
    throw fail('extract_failed', `解包失败:${String(e.stderr || e.message).trim().slice(0, 300)}`);
  }
  const files = [];
  walkTree(dest, (full, rel, stat) => {
    if (stat.isSymbolicLink()) throw fail('unsafe_archive', `解包结果含符号链接,拒绝使用:${rel}`);
    if (!stat.isFile() && !stat.isDirectory()) throw fail('unsafe_archive', `解包结果含特殊文件:${rel}`);
    if (stat.isFile()) files.push(normalizeMember(rel));
  });
  // 清单层再挡一次运行数据:即使有人把 providers.json 打进包,也不会被安装。
  for (const rel of files) {
    if (manifest.isRuntimeData(rel)) throw fail('runtime_data_in_archive', `压缩包含运行数据:${rel}`);
  }
  return { files, members };
}

// ---------------------------------------------------------------- 制品校验
function readReleaseInfo(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { throw fail('release_info_missing', `读不到 RELEASE-INFO:${file}`); }
  let json;
  try { json = JSON.parse(raw); }
  catch { throw fail('invalid_release_info', `RELEASE-INFO 不是合法 JSON:${file}`); }
  if (json.name !== undefined && json.name !== 'mixrouter')
    throw fail('invalid_release_info', `RELEASE-INFO 的 name 不是 mixrouter:${JSON.stringify(json.name)}`);
  const version = requireVersion(json.version, 'RELEASE-INFO 的 version').version;
  if (!/^[0-9a-f]{64}$/.test(String(json.code_revision || '')))
    throw fail('invalid_release_info', 'RELEASE-INFO 缺少 64 位 code_revision');
  if (json.revision !== undefined && json.revision !== null && !/^[0-9a-f]{40}$/.test(String(json.revision)))
    throw fail('invalid_release_info', 'RELEASE-INFO 的 revision 不是 40 位十六进制');
  return {
    name: json.name || 'mixrouter',
    version,
    revision: json.revision ? String(json.revision) : null,
    code_revision: String(json.code_revision),
    keys: RELEASE_INFO_KEYS.filter(key => json[key] !== undefined),
  };
}

// 校验一个**已解包**的目录。releaseInfoPath 是可选的(离线只有 tarball 时往往没有
// 单独的 RELEASE-INFO 附件);没有它时,版本与指纹仍然由包内文件现算,但会明确报告
// "没有可比对的声明值",不把跳过当成通过。
function verifyReleaseDir({ dir, expectedVersion, releaseInfoPath, manifestCheck = manifest.check } = {}) {
  if (!dir || !fs.existsSync(dir)) throw fail('release_missing', `发布目录不存在:${dir}`);
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); }
  catch { throw fail('invalid_release', '发布目录缺少可读的 package.json'); }
  const version = requireVersion(pkg.version, 'package.json 的 version').version;
  if (expectedVersion !== undefined && expectedVersion !== null)
    if (requireVersion(expectedVersion, '目标版本').version !== version)
      throw fail('version_mismatch', `目标版本 ${expectedVersion} 与包内 package.json 的 ${version} 不一致`);
  const entryVersion = (() => {
    try { return manifest.entryVersion(dir); }
    catch { throw fail('invalid_release', 'mixrouter.js 里找不到入口 VERSION;不是可运行的发布包'); }
  })();
  if (entryVersion !== version)
    throw fail('version_mismatch', `mixrouter.js 的 VERSION(${entryVersion})与 package.json(${version})不一致`);
  const computed = codeRevision(dir);
  if (!computed) throw fail('revision_unreadable', '无法计算运行期源码指纹(目录不可读)');
  let info = null;
  let infoPath = releaseInfoPath;
  if (!infoPath) {
    const candidate = path.join(dir, 'RELEASE-INFO.json');
    if (fs.existsSync(candidate)) infoPath = candidate;
  }
  if (infoPath) {
    info = readReleaseInfo(infoPath);
    if (info.version !== version)
      throw fail('version_mismatch', `RELEASE-INFO 的版本 ${info.version} 与包内 ${version} 不一致`);
    if (info.code_revision !== computed)
      throw fail('code_revision_mismatch', `RELEASE-INFO 的 code_revision(${info.code_revision.slice(0, 12)}…)与现算值(${computed.slice(0, 12)}…)不一致`);
  }
  const checked = manifestCheck(dir);
  if (!checked.ok) throw fail('manifest_check_failed', `制品内容校验失败:\n${checked.errors.join('\n')}`);
  const warnings = [];
  if (!info) warnings.push('没有 RELEASE-INFO 声明文件:版本与源码指纹已由包内文件现算,但没有可交叉核对的发布声明');
  return {
    version,
    code_revision: computed,
    declared_code_revision: info ? info.code_revision : null,
    revision: info ? info.revision : null,
    source: info ? 'release-info' : 'local',
    files: checked.files.length,
    warnings,
  };
}

// ---------------------------------------------------------------- 数据目录(只读)
const DATA_FILE_NAMES = Object.freeze(['providers.json', 'routes.json', 'slots.json', 'sessions.json']);
const MAX_DATA_FILE_BYTES = 8 * 1024 * 1024;

// 只读检查:文件存在、JSON 可解析、顶层形状粗判。**不写、不备份、不迁移**。
// 升级工具拿它当"数据目录看起来可用"的证据,不是兼容性证明。
function inspectDataDir(dataDir) {
  const result = { dataDir, exists: false, files: [], errors: [], warnings: [] };
  try { result.exists = fs.statSync(dataDir).isDirectory(); } catch { return result; }
  if (!result.exists) return result;
  for (const name of DATA_FILE_NAMES) {
    const file = path.join(dataDir, name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile()) { result.errors.push(`${name} 不是普通文件`); continue; }
    if (stat.size > MAX_DATA_FILE_BYTES) { result.errors.push(`${name} 超过 ${MAX_DATA_FILE_BYTES} 字节,拒绝读取`); continue; }
    let json;
    try { json = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { result.errors.push(`${name} 不是合法 JSON`); continue; }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      result.errors.push(`${name} 的顶层不是对象`);
      continue;
    }
    result.files.push({ name, bytes: stat.size, version: json.version === undefined ? null : json.version });
  }
  if (!result.files.length) result.warnings.push('数据目录里没有已知配置文件(全新安装或尚未保存过配置)');
  return result;
}

// 回退目标的校验与"解开的制品"不同:一个**正在使用过**的发布目录里合法地存在
// .run/mixrouter.pid 与 logs/(launchd-run.sh 与 mixctl 都写在这里)。把它们当成
// "制品被污染"会让回退永远做不成 —— 而它们恰恰是运行状态,不是发布内容。
// 所以这里只要求:
//   · 关键入口与维护条目齐全(与运行包同一份清单);
//   · providers.json / routes.json / slots.json / sessions.json 一个都不在
//     (发布目录里出现它们,说明有人把数据目录指到了这里,回退会让两份数据打架)。
const RELEASE_RUNTIME_STATE = Object.freeze(['.run', 'logs']);

function runtimeStatePath(relPath) {
  const parts = normalizeMember(relPath).split('/').filter(Boolean);
  return parts.some(part => RELEASE_RUNTIME_STATE.includes(part));
}

function verifyInstalledReleaseDir(dir, { existsSync = fs.existsSync } = {}) {
  if (!dir || !existsSync(dir)) throw fail('release_missing', `发布目录不存在:${dir}`);
  const files = [];
  walkTree(dir, (full, rel, stat) => { if (stat.isFile()) files.push(normalizeMember(rel)); });
  const problems = [];
  for (const rel of files) {
    if (!manifest.isRuntimeData(rel)) continue;
    if (runtimeStatePath(rel)) continue; // .run/ 与 logs/ 属于运行状态
    problems.push(`发布目录里出现运行数据:${rel}`);
  }
  for (const need of manifest.REQUIRED_ENTRIES)
    if (!files.includes(need)) problems.push(`发布目录缺少关键入口:${need}`);
  for (const need of manifest.REQUIRED_MAINTENANCE_ENTRIES)
    if (!files.some(rel => rel === need || rel.startsWith(need + '/')))
      problems.push(`发布目录缺少维护条目:${need}`);
  const pkgVersion = (() => {
    try { return requireVersion(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version).version; }
    catch { return null; }
  })();
  if (!pkgVersion) problems.push('package.json 缺失或 version 不可解析');
  const revision = codeRevision(dir);
  if (!revision) problems.push('无法计算运行期源码指纹');
  if (problems.length) throw fail('rollback_target_invalid', `回退目标不是可用的发布目录:\n${problems.join('\n')}`);
  return { version: pkgVersion, code_revision: revision, files: files.length };
}

// ---------------------------------------------------------------- 安装与切换
function assertReleaseName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name === 'current')
    throw fail('invalid_release_name', `发布目录名不合法:${JSON.stringify(name)}`);
  return name;
}

function writeJsonAtomic(file, value, { fsImpl = fs } = {}) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fsImpl.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fsImpl.renameSync(tmp, file);
  } catch (e) {
    try { fsImpl.unlinkSync(tmp); } catch { /* 没写出来 */ }
    throw e;
  }
}

// 发布根与 current 的解析**不在这里另写一份**:唯一实现是 lib/service-manager.js 的
// releaseRootOf / currentLinkPath(它们从 lib/paths 取默认安装根的真相,并同时认
// paths.currentRelease 的 releases/current 与 installPlan 带 --prefix 时的 <prefix>/current)。
const { releaseRootOf, currentLinkPath } = require('./service-manager');

// 只在 current 是符号链接(或不存在)时切换。current 若是普通目录(有人手工建过),
// 直接 rename 会把它替换掉,那等于无声删除别人的目录 —— 拒绝。
function switchCurrent({ installRoot, releaseDir, previous, now = new Date(), fsImpl = fs,
  env = process.env, home = os.homedir() } = {}) {
  const releaseRoot = releaseRootOf(installRoot, env, home);
  assertDirInside(releaseDir, releaseRoot);
  const link = currentLinkPath(installRoot, { lstatSync: p => fsImpl.lstatSync(p), env, home });
  let prior = previous;
  if (prior === undefined) {
    try {
      const raw = fsImpl.readlinkSync(link);
      prior = path.resolve(path.dirname(link), raw);
    } catch {
      prior = null;
      try {
        if (fsImpl.lstatSync(link).isDirectory())
          throw fail('current_not_symlink', `${link} 是普通目录,不是本工具创建的符号链接;请人工处理后重试`);
      } catch (e) {
        if (e && e.code === 'current_not_symlink') throw e;
      }
    }
  }
  fsImpl.mkdirSync(releaseRoot, { recursive: true, mode: 0o755 });
  // 切换记录写文件:进程在"换链接"和"启动服务"之间被杀掉时,人还能从这里看出上一版是谁。
  if (prior) writeJsonAtomic(path.join(releaseRoot, '.previous.json'),
    { previous: prior, current: path.resolve(releaseDir), at: now.toISOString() }, { fsImpl });
  // 临时链接必须与目标链接同目录,rename 才是同一文件系统上的原子替换。
  const tmpLink = path.join(path.dirname(link), `.current.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fsImpl.symlinkSync(path.resolve(releaseDir), tmpLink, 'dir');
    fsImpl.renameSync(tmpLink, link); // POSIX 上 rename 原子替换已有符号链接
  } catch (e) {
    try { fsImpl.unlinkSync(tmpLink); } catch { /* 没建出来 */ }
    throw e;
  }
  return { current: path.resolve(releaseDir), previous: prior, link };
}

function assertDirInside(dir, root) {
  const resolved = path.resolve(dir);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path.sep))
    throw fail('outside_install_root', `${resolved} 不在 ${base} 之下,拒绝操作`);
  return resolved;
}

// 安装一份已解包、已验证的发布。**只写 releases/ 与新发布的 .run 之外的内容**;
// dataDir 仅记录在 RELEASE.json 里,不创建、不读取它的配置文件。
function installExtractedRelease({ extractedDir, installRoot, releaseName, dataDir, source,
  version, revision, codeRevision: revisionValue, sha256, now = new Date(), fsImpl = fs,
  env = process.env, home = os.homedir() } = {}) {
  if (!extractedDir || !fsImpl.existsSync(extractedDir)) throw fail('release_missing', `解包目录不存在:${extractedDir}`);
  assertReleaseName(releaseName);
  if (!dataDir || !path.isAbsolute(dataDir)) throw fail('invalid_data_dir', 'dataDir 必须是绝对路径');
  const releaseRoot = releaseRootOf(installRoot, env, home);
  const target = path.join(releaseRoot, releaseName);
  assertDirInside(target, releaseRoot);
  if (fsImpl.existsSync(target)) throw fail('release_exists', `${target} 已存在,拒绝覆盖(发布目录不可变)`);
  fsImpl.mkdirSync(releaseRoot, { recursive: true, mode: 0o755 });
  const staging = path.join(releaseRoot, `.staging-${releaseName}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  let moved = false;
  try {
    fsImpl.cpSync(extractedDir, staging, { recursive: true, dereference: true, preserveTimestamps: true, force: true });
    walkTree(staging, (full, rel, stat) => {
      if (stat.isSymbolicLink()) throw fail('unsafe_release', `发布目录里出现符号链接:${rel}`);
      if (stat.isFile() && manifest.isRuntimeData(rel)) throw fail('runtime_data_in_release', `发布目录里出现运行数据:${rel}`);
    });
    const manifestPath = path.join(staging, 'RELEASE.json');
    writeJsonAtomic(manifestPath, {
      version: requireVersion(version, '安装版本').version,
      revision: revision || null,
      code_revision: revisionValue || codeRevision(staging),
      release: releaseName,
      installed_at: now.toISOString(),
      source: source || 'local-archive',
      sha256: sha256 || null,
      data_dir: dataDir,
      items: manifest.INCLUDE.slice(),
    }, { fsImpl });
    fsImpl.renameSync(staging, target);
    moved = true;
  } finally {
    if (!moved) { try { fsImpl.rmSync(staging, { recursive: true, force: true }); } catch { /* 清不掉也不掩盖原错误 */ } }
  }
  const switched = switchCurrent({ installRoot, releaseDir: target, now, fsImpl, env, home });
  return { releaseDir: target, previous: switched.previous, version, code_revision: revisionValue || codeRevision(target) };
}

function rollbackCurrent({ installRoot, previous, now = new Date(), fsImpl = fs,
  env = process.env, home = os.homedir() } = {}) {
  const releaseRoot = releaseRootOf(installRoot, env, home);
  if (!previous) throw fail('no_previous', '没有可回退的上一版发布目录');
  const target = assertDirInside(previous, releaseRoot);
  let stat;
  try { stat = fsImpl.statSync(target); } catch { throw fail('previous_missing', `上一版发布目录不存在:${target}`); }
  if (!stat.isDirectory()) throw fail('previous_missing', `上一版发布路径不是目录:${target}`);
  const switched = switchCurrent({ installRoot, releaseDir: target, now, fsImpl, env, home });
  return { releaseDir: target, previous: switched.previous, version: readPkgVersion(target, fsImpl) };
}

function readPkgVersion(dir, fsImpl = fs) {
  try { return requireVersion(JSON.parse(fsImpl.readFileSync(path.join(dir, 'package.json'), 'utf8')).version).version; }
  catch { return null; }
}

// ---------------------------------------------------------------- 兼容性
function parseRequiredNode(engines) {
  const raw = engines && typeof engines.node === 'string' ? engines.node : '';
  const match = />=\s*(\d+)/.exec(raw);
  return match ? Number(match[1]) : null;
}

function checkUpgradeCompatibility({ currentVersion, targetVersion, targetEngines, nodeVersion = process.versions.node, allowSame = false } = {}) {
  if (!currentVersion) return { from: null, to: requireVersion(targetVersion).version, install: true, warnings: [] };
  const from = requireVersion(currentVersion, '当前版本').version;
  const to = requireVersion(targetVersion, '目标版本').version;
  const cmp = compareVersions(to, from);
  if (cmp < 0) throw fail('downgrade_refused', `目标版本 ${to} 低于当前 ${from};回退请用 --rollback-to <旧发布目录>,不要用降级安装`);
  if (cmp === 0 && !allowSame) throw fail('same_version', `目标版本与当前版本相同(${to});如要重装同一版本,显式加 --allow-same`);
  const warnings = [];
  const required = parseRequiredNode(targetEngines);
  const major = Number(String(nodeVersion).split('.')[0]);
  if (required !== null && Number.isFinite(major) && major < required)
    throw fail('node_too_old', `目标版本要求 Node >= ${required},当前是 ${nodeVersion}`);
  if (!required) warnings.push('目标版本的 package.json 没有可解析的 engines.node');
  return { from, to, install: false, compare: cmp, warnings };
}

// 数据格式没有版本闸门(见 docs/upgrade-and-rollback.md)。这里只做"读得出来"的检查,
// 不声称兼容 —— 检查通过不等于旧版能读新版写出的数据。
function compatibilityReport({ currentVersion, targetVersion, targetEngines, nodeVersion, dataDir, allowSame }) {
  const version = checkUpgradeCompatibility({ currentVersion, targetVersion, targetEngines, nodeVersion, allowSame });
  const data = dataDir ? inspectDataDir(dataDir) : null;
  return { ...version, data };
}

module.exports = {
  OFFICIAL, TRUSTED_HOSTS, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_JSON_BYTES, DEFAULT_MAX_ARCHIVE_BYTES, MAX_REDIRECTS,
  parseVersion, requireVersion, compareVersions, assetNames, releaseNameFor,
  assertTrustedUrl, assertReleaseAssetUrl, releaseApiUrl,
  headerOf, httpsTransport, fetchWithRedirects, readLimited, fetchJson, fetchText,
  selectAssets, normalizeRelease, fetchRelease,
  sha256File, parseSha256, parseContentLength, downloadAsset,
  normalizeMember, validateMember, listArchiveMembers, assertArchiveTypes, extractArchive,
  readReleaseInfo, verifyReleaseDir, verifyInstalledReleaseDir, inspectDataDir,
  assertReleaseName, assertDirInside, currentLinkPath, switchCurrent, installExtractedRelease, rollbackCurrent, writeJsonAtomic,
  parseRequiredNode, checkUpgradeCompatibility, compatibilityReport,
};
