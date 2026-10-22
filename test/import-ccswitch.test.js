'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { main, parseArgs, loadStore } = require('../scripts/import-ccswitch');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'import-ccswitch.js');

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixr-ccswitch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, out: path.join(dir, 'providers.json') };
}

function rows() {
  return [
    {
      app_type: 'claude', name: 'Fixture Claude', notes: 'note',
      settings_config: JSON.stringify({ env: {
        ANTHROPIC_BASE_URL: 'https://fixture.example/',
        ANTHROPIC_AUTH_TOKEN: 'fixture-secret-key',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-target',
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'retired-only',
      } }),
    },
    {
      app_type: 'codex', name: 'Fixture Codex', notes: '',
      settings_config: JSON.stringify({
        auth: { OPENAI_API_KEY: 'codex-secret-key' },
        config: 'model = "gpt-fixture"\nmodel_provider = "custom"\n[model_providers.custom]\nbase_url = "https://codex.example/v1"\nwire_api = "responses"\n',
      }),
    },
  ];
}

function collector() {
  const logs = [];
  const errors = [];
  return {
    logs, errors,
    io(exec) {
      return {
        execFileSync: exec || (() => JSON.stringify(rows())),
        log: message => logs.push(message),
        error: message => errors.push(message),
      };
    },
  };
}

function existingStore() {
  return {
    version: 2,
    current: { claude: 'p1', codex: null },
    claude: [{ id: 'p1', name: '保持', base_url: 'https://keep.example', api_key: 'keep-key' }],
    codex: [],
  };
}

test('默认预演:只读数据库和目标库,不写文件、不打印 key 正文', t => {
  const ws = workspace(t);
  const output = collector();
  const code = main(['fixture.db', ws.out], output.io());
  assert.equal(code, 0);
  assert.equal(fs.existsSync(ws.out), false);
  const text = output.logs.join('\n');
  assert.match(text, /预演模式/);
  assert.ok(!text.includes('fixture-secret-key'));
  assert.ok(!text.includes('codex-secret-key'));
  assert.match(text, /Claude/);
  assert.match(text, /Codex/);
});

test('--apply:自动备份、合并保留现有 key/current/id、原子写入 0600', t => {
  const ws = workspace(t);
  fs.writeFileSync(ws.out, JSON.stringify(existingStore(), null, 2));
  const output = collector();
  const code = main(['fixture.db', ws.out, '--apply'], output.io());
  assert.equal(code, 0, output.errors.join('\n'));

  const merged = JSON.parse(fs.readFileSync(ws.out, 'utf8'));
  assert.deepEqual(merged.current, { claude: 'p1', codex: null });
  assert.equal(merged.claude[0].api_key, 'keep-key');
  assert.equal(merged.claude.length, 2);
  assert.equal(merged.claude[1].base_url, 'https://fixture.example');
  assert.equal(merged.claude[1].models.includes('retired-only'), false);
  assert.equal(merged.codex[0].model, 'gpt-fixture');
  assert.equal(fs.statSync(ws.out).mode & 0o777, 0o600);

  const backups = fs.readdirSync(ws.dir).filter(name => name.startsWith('providers.json.bak-mixui-'));
  assert.equal(backups.length, 1);
  assert.ok(output.logs.some(line => line.includes('已备份原渠道库')));
});

test('无效条目或非法目标库:中止且旧库保持原样', t => {
  const ws = workspace(t);
  fs.writeFileSync(ws.out, JSON.stringify(existingStore(), null, 2));
  const before = fs.readFileSync(ws.out, 'utf8');

  const bad = collector();
  const badRows = [{ app_type: 'claude', name: '坏渠道', settings_config: JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: 'ftp://bad.example', ANTHROPIC_AUTH_TOKEN: 'bad-key',
  } }) }];
  const code = main(['fixture.db', ws.out, '--apply'], bad.io(() => JSON.stringify(badRows)));
  assert.equal(code, 1);
  assert.ok(bad.errors.some(line => /无效/.test(line)));
  assert.equal(fs.readFileSync(ws.out, 'utf8'), before);

  fs.writeFileSync(ws.out, '{not json');
  const corrupt = collector();
  assert.equal(main(['fixture.db', ws.out, '--apply'], corrupt.io()), 1);
  assert.equal(fs.readFileSync(ws.out, 'utf8'), '{not json');
  assert.ok(corrupt.errors.some(line => /不是合法 JSON/.test(line)));
});

test('数据库读取失败时返回非 0 且不创建目标文件', t => {
  const ws = workspace(t);
  const output = collector();
  const code = main(['missing.db', ws.out, '--apply'], output.io(() => {
    const error = new Error('spawn sqlite3 ENOENT');
    error.code = 'ENOENT';
    throw error;
  }));
  assert.equal(code, 1);
  assert.equal(fs.existsSync(ws.out), false);
  assert.ok(output.errors.some(line => /sqlite3/.test(line)));
});

test('脚本不再内置个人渠道或"已知失效"判据', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(source, /anyrouter\.top/);
  assert.doesNotMatch(source, /api\.deepseek\.com/);
  assert.doesNotMatch(source, /knownDead/);
});

test('参数解析与已有渠道库读取', t => {
  const args = parseArgs(['cc-switch.db', 'out.json', '--apply']);
  assert.equal(args.db, 'cc-switch.db');
  assert.equal(args.out, 'out.json');
  assert.equal(args.apply, true);
  assert.throws(() => parseArgs(['--nope']), /未知参数/);
  assert.throws(() => parseArgs(['a', 'b', 'c']), /参数过多/);

  const ws = workspace(t);
  assert.deepEqual(loadStore(ws.out), { version: 2, current: { claude: null, codex: null }, claude: [], codex: [] });
  fs.writeFileSync(ws.out, JSON.stringify({ claude: [], codex: [] }, null, 2));
  assert.deepEqual(loadStore(ws.out), { claude: [], codex: [] });
  fs.writeFileSync(ws.out, JSON.stringify({ claude: {} }));
  assert.throws(() => loadStore(ws.out), /格式无效/);
});
