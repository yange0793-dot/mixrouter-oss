'use strict';
// lib/release-update.js 的离线回归。
//
// 不联网:HTTP 传输全部注入。用例覆盖"成功校验"与**每一种拒绝**:
//   · 坏 sha256          → 删除半截文件,不产生 dest
//   · 不受信任的主机/重定向 → 在建立连接前就拒绝
//   · 超过大小上限        → 下载中止,不留部分文件
//   · 压缩包路径穿越/符号链接 → 拒绝解包
//   · 版本/指纹/制品清单不一致 → 不进入安装
//   · current 切换与回退 → 原子、可核对
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { execFileSync } = require('node:child_process');
const ru = require('../lib/release-update');
const fixture = require('./release-update-fixture');

function tempDir(t, prefix = 'mixr-ru-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ASSET_URL = `https://github.com/${ru.OFFICIAL.owner}/${ru.OFFICIAL.repo}/releases/download/v3.9.1/mixrouter-3.9.1.tar.gz`;

function streamResponse(buffer, { status = 200, headers = {} } = {}) {
  return {
    status,
    headers: { 'content-length': String(buffer.length), ...headers },
    body: Readable.from([buffer]),
    destroy() {},
  };
}

// ---------------------------------------------------------------- 版本
test('parseVersion/compareVersions:数字段与预发布版排序', () => {
  assert.equal(ru.parseVersion('v3.9.1').version, '3.9.1');
  assert.equal(ru.parseVersion('3.9.1-rc.1').version, '3.9.1-rc.1');
  assert.equal(ru.parseVersion('3.9'), null);
  assert.equal(ru.compareVersions('3.10.0', '3.9.9'), 1);
  assert.equal(ru.compareVersions('3.9.1', '3.9.1'), 0);
  assert.equal(ru.compareVersions('3.9.1-rc.1', '3.9.1'), -1);
  assert.equal(ru.compareVersions('3.9.1', '3.9.1-rc.2'), 1);
  assert.throws(() => ru.compareVersions('x', '3.9.1'), /不是 x\.y\.z/);
});

test('assetNames/releaseNameFor:固定附件命名', () => {
  const names = ru.assetNames('v3.9.1');
  assert.equal(names.archive, 'mixrouter-3.9.1.tar.gz');
  assert.equal(names.sha256, 'mixrouter-3.9.1.tar.gz.sha256');
  assert.equal(names.releaseInfo, 'mixrouter-3.9.1.RELEASE-INFO.json');
  assert.equal(ru.releaseNameFor('3.9.1', 'abcdef1234567890'), '3.9.1-abcdef12');
});

// ---------------------------------------------------------------- 发布元数据
test('selectAssets:只接受固定名字的附件,缺校验和/版本不符都拒绝', () => {
  const release = {
    tag_name: 'v3.9.1',
    assets: [
      { name: 'mixrouter-3.9.1.tar.gz', size: 100, browser_download_url: ASSET_URL },
      { name: 'mixrouter-3.9.1.tar.gz.sha256', size: 90,
        browser_download_url: ASSET_URL.replace(/\.tar\.gz$/, '.tar.gz.sha256') },
      { name: 'mixrouter-3.9.1.RELEASE-INFO.json', size: 200,
        browser_download_url: ASSET_URL.replace(/\.tar\.gz$/, '.RELEASE-INFO.json') },
      { name: 'Source code (zip)', browser_download_url: 'https://github.com/evil/archive.zip' },
    ],
  };
  const selected = ru.selectAssets(release, '3.9.1');
  assert.equal(selected.archive.name, 'mixrouter-3.9.1.tar.gz');
  assert.equal(selected.releaseInfo.name, 'mixrouter-3.9.1.RELEASE-INFO.json');

  assert.throws(() => ru.selectAssets(release, '3.9.2'), /不一致/);
  assert.throws(() => ru.selectAssets({ ...release, tag_name: 'v3.9.2' }, '3.9.1'), /不一致/);
  assert.throws(() => ru.selectAssets({ tag_name: 'v3.9.1', assets: [release.assets[0]] }, '3.9.1'), /缺少校验和/);
  assert.throws(() => ru.selectAssets({
    tag_name: 'v3.9.1',
    assets: [release.assets[0], { ...release.assets[0] }, release.assets[1]],
  }, '3.9.1'), /多个同名附件/);
});

test('assertTrustedUrl/assertReleaseAssetUrl:只允许 HTTPS 的固定主机与官方附件路径', () => {
  assert.equal(ru.assertTrustedUrl(ASSET_URL).hostname, 'github.com');
  assert.throws(() => ru.assertTrustedUrl('http://github.com/x'), /https/);
  assert.throws(() => ru.assertTrustedUrl('https://evil.example/x'), /不信任的主机/);
  assert.throws(() => ru.assertTrustedUrl('https://user:pass@github.com/x'), /凭据/);
  assert.throws(() => ru.assertTrustedUrl('https://github.com:8443/x'), /443/);
  assert.throws(() => ru.assertReleaseAssetUrl('https://github.com/someone/else/releases/download/v1/x.tar.gz'),
    /必须位于/);
  assert.ok(ru.assertReleaseAssetUrl('https://objects.githubusercontent.com/github-production-release-asset/x'));
});

// ---------------------------------------------------------------- HTTP/重定向
test('fetchWithRedirects:每一跳都校验主机,拒绝跳到不受信任的域', async () => {
  const calls = [];
  const transport = async url => {
    calls.push(url);
    return { status: 302, headers: { location: 'https://evil.example/payload' }, body: Readable.from([]), destroy() {} };
  };
  await assert.rejects(ru.fetchWithRedirects(ASSET_URL, { transport }), error => error.code === 'untrusted_host');
  assert.equal(calls.length, 1);
});

test('fetchWithRedirects:跟随受信任的 CDN 跳转,并限制跳转次数', async () => {
  const cdn = 'https://objects.githubusercontent.com/github-production-release-asset/abc';
  const transport = async url => url === ASSET_URL
    ? { status: 302, headers: { location: cdn }, body: Readable.from([]), destroy() {} }
    : streamResponse(Buffer.from('ok'));
  const response = await ru.fetchWithRedirects(ASSET_URL, { transport });
  assert.equal(response.url, cdn);
  const body = await ru.readLimited(response.body, 16);
  assert.equal(body.toString(), 'ok');

  let hops = 0;
  const loop = async () => {
    hops += 1;
    return { status: 302, headers: { location: ASSET_URL }, body: Readable.from([]), destroy() {} };
  };
  await assert.rejects(ru.fetchWithRedirects(ASSET_URL, { transport: loop, maxRedirects: 2 }),
    error => error.code === 'too_many_redirects');
  assert.equal(hops, 3);
});

test('fetchJson:非 200 与超大响应都明确失败', async () => {
  await assert.rejects(ru.fetchJson(ASSET_URL, {
    transport: async () => ({ status: 404, headers: {}, body: Readable.from([]), destroy() {} }),
  }), error => error.code === 'http_status' && error.status === 404);
  await assert.rejects(ru.fetchJson(ASSET_URL, {
    transport: async () => streamResponse(Buffer.from('x'.repeat(100))), maxBytes: 10,
  }), error => error.code === 'too_large');
});

// ---------------------------------------------------------------- 下载
test('downloadAsset:校验和一致才落盘', async t => {
  const dir = tempDir(t);
  const payload = Buffer.from('release bytes');
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  const dest = path.join(dir, 'mixrouter-3.9.1.tar.gz');
  const result = await ru.downloadAsset({
    url: ASSET_URL, dest, expectedSha256: hash,
    transport: async () => streamResponse(payload),
  });
  assert.equal(result.sha256, hash);
  assert.deepEqual(fs.readFileSync(dest), payload);
});

test('downloadAsset:坏校验和删除临时文件,不留下 dest', async t => {
  const dir = tempDir(t);
  const dest = path.join(dir, 'mixrouter-3.9.1.tar.gz');
  await assert.rejects(ru.downloadAsset({
    url: ASSET_URL, dest, expectedSha256: '0'.repeat(64),
    transport: async () => streamResponse(Buffer.from('payload')),
  }), error => error.code === 'sha256_mismatch');
  assert.ok(!fs.existsSync(dest));
  assert.deepEqual(fs.readdirSync(dir), [], '半截文件也必须清掉');
});

test('downloadAsset:超过大小上限立即中止', async t => {
  const dir = tempDir(t);
  const dest = path.join(dir, 'mixrouter-3.9.1.tar.gz');
  await assert.rejects(ru.downloadAsset({
    url: ASSET_URL, dest, maxBytes: 4,
    transport: async () => streamResponse(Buffer.from('0123456789')),
  }), error => error.code === 'too_large');
  assert.ok(!fs.existsSync(dest));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('parseSha256:格式与文件名必须对得上', () => {
  const hash = 'AB'.repeat(32);
  assert.equal(ru.parseSha256(`${hash}  mixrouter-3.9.1.tar.gz`, 'mixrouter-3.9.1.tar.gz'), hash.toLowerCase());
  assert.equal(ru.parseSha256(`${hash} *mixrouter-3.9.1.tar.gz`), hash.toLowerCase());
  assert.throws(() => ru.parseSha256(`${hash}  other.tar.gz`, 'mixrouter-3.9.1.tar.gz'), /对应的文件名/);
  assert.throws(() => ru.parseSha256('not-a-hash  x'), /格式不对/);
  assert.throws(() => ru.parseSha256(''), /空的/);
});

// ---------------------------------------------------------------- 解包
test('extractArchive:正常包解出后没有链接,文件齐全', async t => {
  const base = tempDir(t);
  const release = fixture.makeRelease(path.join(base, 'src'));
  const { archive } = fixture.makeArchive(path.join(base, 'assets'), release);
  const dest = path.join(base, 'extracted');
  const result = ru.extractArchive({ archive, dest });
  assert.ok(fs.existsSync(path.join(dest, 'package.json')));
  assert.ok(result.files.includes('lib/runtime-code.js'));
});

test('extractArchive:拒绝路径穿越', async t => {
  const base = tempDir(t);
  // 手工造包:系统 tar 打包时会把 `../` 剥掉(Linux 的 GNU tar 尤其如此),
  // 用 `tar -czf x -C root ../evil.txt` 造出来的其实是正常包,这条用例在 CI 上会假绿。
  const archive = fixture.makeRawArchive(path.join(base, 'evil.tar.gz'), [
    { name: '../evil.txt', content: 'outside' },
  ]);
  assert.throws(() => ru.extractArchive({ archive, dest: path.join(base, 'out') }),
    error => error.code === 'unsafe_archive' && /路径穿越/.test(error.message));
  assert.ok(!fs.existsSync(path.join(base, 'out', 'evil.txt')));
  // 也不能把文件写到 dest 的父目录里。
  assert.ok(!fs.existsSync(path.join(base, 'evil.txt')));
});

test('extractArchive:拒绝绝对路径成员', async t => {
  const base = tempDir(t);
  // Windows 盘符形式:GNU tar 与 bsdtar 都原样列出,所以这条能直接断言我们自己的拒绝。
  // POSIX 形式(`/etc/x`)不在这里断言:两种 tar 都会先削掉前导 `/` 再列成员,削掉之后
  // 本来也逃不出 dest —— 把"谁先拦"当契约写进测试,只会让它依赖打包端实现。
  const archive = fixture.makeRawArchive(path.join(base, 'abs.tar.gz'), [
    { name: 'C:/evil.txt', content: 'outside' },
  ]);
  assert.throws(() => ru.extractArchive({ archive, dest: path.join(base, 'out') }),
    error => error.code === 'unsafe_archive' && /绝对路径/.test(error.message));
  assert.ok(!fs.existsSync(path.join(base, 'out', 'evil.txt')));
});

test('extractArchive:拒绝符号链接与硬链接成员', async t => {
  const base = tempDir(t);
  const dir = path.join(base, 'root');
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync('/etc/passwd', path.join(dir, 'link'));
  const archive = path.join(base, 'link.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', dir, '.']);
  assert.throws(() => ru.extractArchive({ archive, dest: path.join(base, 'out') }),
    error => error.code === 'unsafe_archive' && /链接/.test(error.message));
});

// ---------------------------------------------------------------- 制品校验
test('verifyReleaseDir:版本、入口 VERSION、指纹与制品清单一致才通过', async t => {
  const base = tempDir(t);
  const release = fixture.makeRelease(path.join(base, 'src'));
  const { info } = fixture.makeArchive(path.join(base, 'assets'), release);
  const verified = ru.verifyReleaseDir({ dir: release.dir, expectedVersion: '3.9.1', releaseInfoPath: info });
  assert.equal(verified.version, '3.9.1');
  assert.equal(verified.code_revision, release.code_revision);
  assert.equal(verified.source, 'release-info');
  assert.ok(verified.files >= 10);
});

test('verifyReleaseDir:源码被改后指纹对不上 RELEASE-INFO', async t => {
  const base = tempDir(t);
  const release = fixture.makeRelease(path.join(base, 'src'));
  const { info } = fixture.makeArchive(path.join(base, 'assets'), release);
  fs.writeFileSync(path.join(release.dir, 'lib', 'fixture.js'), '// tampered\n');
  assert.throws(() => ru.verifyReleaseDir({ dir: release.dir, expectedVersion: '3.9.1', releaseInfoPath: info }),
    error => error.code === 'code_revision_mismatch');
});

test('verifyReleaseDir:没有 RELEASE-INFO 时明确降级为"无声明可核对",而不是静默通过', async t => {
  const base = tempDir(t);
  const release = fixture.makeRelease(path.join(base, 'src'));
  const verified = ru.verifyReleaseDir({ dir: release.dir, expectedVersion: '3.9.1' });
  assert.equal(verified.source, 'local');
  assert.equal(verified.declared_code_revision, null);
  assert.ok(verified.warnings.some(line => line.includes('没有 RELEASE-INFO')));
});

test('verifyReleaseDir:版本不一致或制品缺入口都拒绝', async t => {
  const base = tempDir(t);
  const release = fixture.makeRelease(path.join(base, 'src'));
  assert.throws(() => ru.verifyReleaseDir({ dir: release.dir, expectedVersion: '3.9.2' }),
    error => error.code === 'version_mismatch');
  fs.unlinkSync(path.join(release.dir, 'public', 'js', 'workspace.js'));
  assert.throws(() => ru.verifyReleaseDir({ dir: release.dir }), /制品内容校验失败/);
});

// ---------------------------------------------------------------- 数据目录(只读)
test('inspectDataDir:只读,坏 JSON 报告但不改写', async t => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify({ version: 2, claude: [] }));
  const good = ru.inspectDataDir(dir);
  assert.deepEqual(good.errors, []);
  assert.equal(good.files[0].name, 'providers.json');
  const before = fs.readFileSync(path.join(dir, 'providers.json'), 'utf8');
  fs.writeFileSync(path.join(dir, 'routes.json'), '{ not json');
  const bad = ru.inspectDataDir(dir);
  assert.ok(bad.errors.some(line => line.includes('routes.json')));
  assert.equal(fs.readFileSync(path.join(dir, 'providers.json'), 'utf8'), before);
});

// ---------------------------------------------------------------- 安装/切换/回退
test('installExtractedRelease:不可变目录、原子切换 current、数据目录不被触碰', async t => {
  const base = tempDir(t);
  const installRoot = path.join(base, 'install');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'providers.json'), '{"version":2,"claude":[]}');
  const dataBefore = fs.readFileSync(path.join(dataDir, 'providers.json'), 'utf8');

  const old = fixture.makeRelease(path.join(base, 'old'), { version: '3.9.0' });
  fs.mkdirSync(path.join(installRoot, 'releases'), { recursive: true });
  fs.cpSync(old.dir, path.join(installRoot, 'releases', '3.9.0-oldest'), { recursive: true });
  fs.symlinkSync(path.join(installRoot, 'releases', '3.9.0-oldest'),
    path.join(installRoot, 'releases', 'current'), 'dir');

  const next = fixture.makeRelease(path.join(base, 'next'), { version: '3.9.1' });
  const installed = ru.installExtractedRelease({
    extractedDir: next.dir, installRoot, releaseName: '3.9.1-next', dataDir,
    source: 'fixture', version: '3.9.1', revision: next.revision,
    codeRevision: next.code_revision, sha256: 'f'.repeat(64),
  });
  assert.equal(installed.previous, path.join(installRoot, 'releases', '3.9.0-oldest'));
  assert.equal(fs.readlinkSync(path.join(installRoot, 'releases', 'current')),
    path.join(installRoot, 'releases', '3.9.1-next'));
  const manifest = JSON.parse(fs.readFileSync(path.join(installed.releaseDir, 'RELEASE.json'), 'utf8'));
  assert.equal(manifest.code_revision, next.code_revision);
  assert.equal(manifest.data_dir, dataDir);
  assert.equal(manifest.sha256, 'f'.repeat(64));
  assert.equal(fs.readFileSync(path.join(dataDir, 'providers.json'), 'utf8'), dataBefore);
  assert.throws(() => ru.installExtractedRelease({
    extractedDir: next.dir, installRoot, releaseName: '3.9.1-next', dataDir,
    version: '3.9.1', codeRevision: next.code_revision,
  }), error => error.code === 'release_exists');

  const rolled = ru.rollbackCurrent({ installRoot, previous: installed.previous });
  assert.equal(rolled.releaseDir, path.join(installRoot, 'releases', '3.9.0-oldest'));
  assert.equal(fs.readlinkSync(path.join(installRoot, 'releases', 'current')),
    path.join(installRoot, 'releases', '3.9.0-oldest'));
});

test('switchCurrent:current 是普通目录时拒绝替换', async t => {
  const base = tempDir(t);
  const installRoot = path.join(base, 'install');
  fs.mkdirSync(path.join(installRoot, 'releases', 'current'), { recursive: true });
  const release = fixture.makeRelease(path.join(installRoot, 'releases', '3.9.1'));
  assert.throws(() => ru.switchCurrent({ installRoot, releaseDir: release.dir }),
    error => error.code === 'current_not_symlink');
  assert.ok(fs.statSync(path.join(installRoot, 'releases', 'current')).isDirectory());
});

test('switchCurrent:兼容 <安装根>/current(install-macos --prefix 的旧布局)', async t => {
  const base = tempDir(t);
  const installRoot = path.join(base, 'install');
  const old = fixture.makeRelease(path.join(installRoot, 'releases', '3.9.0-old'), { version: '3.9.0' });
  const next = fixture.makeRelease(path.join(installRoot, 'releases', '3.9.1-new'), { version: '3.9.1' });
  fs.symlinkSync(old.dir, path.join(installRoot, 'current'), 'dir');
  const switched = ru.switchCurrent({ installRoot, releaseDir: next.dir });
  assert.equal(switched.previous, old.dir);
  assert.equal(fs.readlinkSync(path.join(installRoot, 'current')), next.dir);
  assert.ok(!fs.existsSync(path.join(installRoot, 'releases', 'current')),
    '不能在旧布局下另建一个 releases/current');
});

test('verifyInstalledReleaseDir:运行状态目录(.run/logs)不算数据污染,数据文件仍拒绝', async t => {
  const base = tempDir(t);
  const release = fixture.makeRelease(path.join(base, 'src'));
  fs.mkdirSync(path.join(release.dir, '.run'), { recursive: true });
  fs.writeFileSync(path.join(release.dir, '.run', 'mixrouter.pid'), '1234');
  fs.mkdirSync(path.join(release.dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(release.dir, 'logs', 'server.log'), '');
  const checked = ru.verifyInstalledReleaseDir(release.dir);
  assert.equal(checked.version, '3.9.1');
  assert.equal(checked.code_revision, release.code_revision);

  fs.writeFileSync(path.join(release.dir, 'providers.json'), '{"claude":[]}');
  assert.throws(() => ru.verifyInstalledReleaseDir(release.dir),
    error => error.code === 'rollback_target_invalid' && /providers\.json/.test(error.message));

  fs.unlinkSync(path.join(release.dir, 'providers.json'));
  fs.unlinkSync(path.join(release.dir, 'public', 'js', 'workspace.js'));
  assert.throws(() => ru.verifyInstalledReleaseDir(release.dir), /缺少关键入口/);
});

test('checkUpgradeCompatibility:拒绝降级/同版本/Node 太老', () => {
  assert.deepEqual(ru.checkUpgradeCompatibility({ currentVersion: '3.9.0', targetVersion: '3.9.1' }).to, '3.9.1');
  assert.throws(() => ru.checkUpgradeCompatibility({ currentVersion: '3.10.0', targetVersion: '3.9.1' }),
    error => error.code === 'downgrade_refused');
  assert.throws(() => ru.checkUpgradeCompatibility({ currentVersion: '3.9.1', targetVersion: '3.9.1' }),
    error => error.code === 'same_version');
  assert.throws(() => ru.checkUpgradeCompatibility({
    currentVersion: '3.9.0', targetVersion: '3.9.1', targetEngines: { node: '>=99' }, nodeVersion: '22.0.0',
  }), error => error.code === 'node_too_old');
  assert.equal(ru.checkUpgradeCompatibility({ currentVersion: null, targetVersion: '3.9.1' }).install, true);
});
