'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = path.join(__dirname, '..', 'scripts', 'import-ccswitch.js');

test('cc-switch import omits the retired slot without removing a selected Fable model', () => {
  const rows = [{ app_type: 'claude', name: 'fixture', notes: '', settings_config: JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: 'https://fixture.invalid/', ANTHROPIC_AUTH_TOKEN: 'fixture-only',
    ANTHROPIC_MODEL: 'claude-fable-5-1', ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-target',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-target', ANTHROPIC_DEFAULT_FABLE_MODEL: 'retired-only',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-target', CLAUDE_CODE_SUBAGENT_MODEL: 'sub-target',
  } }) }];
  const output = path.join(__dirname, 'virtual-providers.json');
  let saved, mode, queries = 0;
  vm.runInNewContext(fs.readFileSync(script, 'utf8'), {
    __dirname: path.dirname(script), process: { argv: ['node', script, 'fixture.db', output] },
    console: { log() {} },
    require(name) {
      if (name === 'path') return path;
      if (name === 'os') return { homedir() { throw new Error('must use the explicit database'); } };
      if (name === 'fs') return {
        writeFileSync(file, data, options) {
          assert.equal(file, output); assert.equal(options.mode, 0o600); saved = JSON.parse(data);
        },
        chmodSync(file, value) { assert.equal(file, output); mode = value; },
      };
      if (name === 'child_process') return { execFileSync(command, args) {
        assert.equal(command, 'sqlite3'); assert.equal(args[1], 'fixture.db');
        return JSON.stringify(++queries === 1 ? rows : []);
      } };
      throw new Error('unexpected dependency: ' + name);
    },
  });
  assert.equal(queries, 2);
  assert.equal(mode, 0o600);
  assert.equal(saved.claude.length, 1);
  assert.deepEqual(saved.claude[0].slots, {
    opus: 'opus-target', sonnet: 'sonnet-target', haiku: 'haiku-target', subagent: 'sub-target',
  });
  assert.deepEqual(saved.claude[0].models, [
    'claude-fable-5-1', 'opus-target', 'sonnet-target', 'haiku-target', 'sub-target',
  ]);
});
