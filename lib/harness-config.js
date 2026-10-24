'use strict';
// Scoped literal YAML edits. Expressions remain opaque; whole config expressions cannot be merged.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeFileAtomic, uniqueSuffix } = require('./atomic-write');

const PROVIDER = 'mixrouter-harness';
const KEY_REF = 'MIXROUTER_HARNESS_API_KEY';
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const fingerprint = text => crypto.createHash('sha256').update(String(text)).digest('hex');
const quote = value => JSON.stringify(value);

function readPrivateFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024)
      throw fail(403, 'Harness configuration must be a bounded regular file, not a symlink');
    const text = fs.readFileSync(file, 'utf8');
    return { exists: true, text, revision: fingerprint(text), mode: stat.mode & 0o777 };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, text: '', revision: fingerprint('missing'), mode: 0o600 };
    if (error.statusCode) throw error;
    throw fail(403, 'Cannot read Harness configuration; no changes made');
  }
}

function stripComment(text) {
  let quoted = '', escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted === '"' && c === '\\' && !escaped) { escaped = true; continue; }
    if (quoted && c === quoted && !escaped) {
      if (quoted === "'" && text[i + 1] === "'") { i++; continue; }
      quoted = '';
    } else if (!quoted && (c === '"' || c === "'")) quoted = c;
    else if (!quoted && c === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
    escaped = false;
  }
  if (quoted) throw fail(409, 'Multiline or malformed quoted YAML is not safely mergeable');
  return text.trimEnd();
}
function scalar(text) {
  if (text.startsWith('"')) {
    try { return JSON.parse(text); } catch { throw fail(409, 'Malformed YAML scalar; no changes made'); }
  }
  if (text.startsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}
function mapping(text) {
  const match = /^("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[A-Za-z0-9_./@-]+):(?:\s+(.*)|$)/.exec(text);
  if (!match) throw fail(409, 'YAML structure is outside the safe literal merge subset');
  return { key: scalar(match[1]), value: match[2] || '' };
}

// Tokenize block scalars as one opaque range, so text inside !!js/| cannot masquerade as a row.
function parseLiteral(text) {
  const lines = text.split(/\r?\n/), tokens = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], start = offset;
    offset += line.length + (text.includes('\r\n') ? 2 : 1);
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\s*\t/.test(line)) throw fail(409, 'Tab-indented YAML cannot be safely merged');
    const indent = /^ */.exec(line)[0].length, content = stripComment(line.slice(indent));
    if (/^(---|\.\.\.)$/.test(content)) throw fail(409, 'Multi-document YAML cannot be safely merged');
    let end = Math.min(offset, text.length);
    if (/(?:^|:\s|!!js\s)[|>][+-]?[0-9]?$/.test(content)) {
      while (i + 1 < lines.length && (!lines[i + 1].trim() || /^ */.exec(lines[i + 1])[0].length > indent)) {
        i++; offset += lines[i].length + (text.includes('\r\n') ? 2 : 1); end = Math.min(offset, text.length);
      }
    }
    tokens.push({ indent, content, start, end });
  }
  let cursor = 0;
  const valueNode = (value, token, parentIndent) => {
    if (!value && tokens[cursor] && tokens[cursor].indent > parentIndent) return parseNode(tokens[cursor].indent);
    if (/^[\[{]/.test(value) && !['{}', '[]'].includes(value)) {
      try { JSON.parse(value); } catch { throw fail(409, 'Non-JSON flow YAML is outside the safe merge subset'); }
    }
    return { type: value === '{}' ? 'empty-map' : 'scalar', value, start: token.start, end: token.end, indent: parentIndent };
  };
  const parseMap = (indent, inline) => {
    const node = { type: 'map', fields: new Map(), start: inline ? inline.start : tokens[cursor].start, end: 0, indent };
    const add = (content, token) => {
      const { key, value } = mapping(content);
      if (node.fields.has(key) || ['__proto__', 'constructor', 'prototype', '<<'].includes(key))
        throw fail(409, 'Duplicate or unsafe YAML key; no changes made');
      const inner = valueNode(value, token, indent);
      node.fields.set(key, { ...inner, entryStart: token.start, entryIndent: indent });
      node.end = inner.end;
    };
    if (inline) add(inline.content, inline);
    while (tokens[cursor] && tokens[cursor].indent === indent && !tokens[cursor].content.startsWith('- ')) {
      const token = tokens[cursor++]; add(token.content, token);
    }
    return node;
  };
  const parseNode = indent => {
    if (!tokens[cursor].content.startsWith('- ')) return parseMap(indent);
    const node = { type: 'seq', items: [], start: tokens[cursor].start, end: 0, indent };
    while (tokens[cursor] && tokens[cursor].indent === indent && tokens[cursor].content.startsWith('- ')) {
      const token = tokens[cursor++], content = token.content.slice(2);
      let inner;
      if (/^(?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[A-Za-z0-9_./@-]+):(?:\s|$)/.test(content))
        inner = parseMap(indent + 2, { ...token, content });
      else inner = valueNode(content, token, indent);
      node.items.push(inner); node.end = inner.end;
    }
    return node;
  };
  if (!tokens.length || (tokens.length === 1 && tokens[0].content === '[]'))
    return { type: 'seq', items: [], start: 0, end: text.length, indent: 0 };
  const root = parseNode(tokens[0].indent);
  if (cursor !== tokens.length || root.indent !== 0) throw fail(409, 'Ambiguous YAML indentation; no changes made');
  return root;
}
const literalValue = node => node?.type === 'scalar' ? scalar(node.value) : undefined;
function findRow(root, id) {
  if (root.type !== 'seq') throw fail(409, 'Harness profile must be a literal patch list');
  const candidates = root.items.flatMap(row => {
    const insert = row.type === 'map' ? row.fields.get('insert') : null;
    return [row, ...(insert?.type === 'seq' ? insert.items : [])];
  });
  const rows = candidates.filter(row => row.type === 'map' && literalValue(row.fields.get('id')) === id);
  if (rows.length > 1) throw fail(409, 'Duplicate Harness profile row; no changes made');
  return rows[0] || null;
}
function renderField(key, value, indent, eol) {
  const padding = ' '.repeat(indent);
  if (Array.isArray(value)) return `${padding}${key}:${eol}` + value.map(item => {
    if (typeof item === 'string') return `${padding}  - ${quote(item)}${eol}`;
    return Object.entries(item).map(([name, field], index) => `${padding}  ${index ? '  ' : '- '}${name}: ${typeof field === 'string' ? quote(field) : JSON.stringify(field)}${eol}`).join('');
  }).join('');
  return `${padding}${key}: ${typeof value === 'string' ? quote(value) : JSON.stringify(value)}${eol}`;
}
function patchField(text, id, parts, value) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n', root = parseLiteral(text);
  let row = findRow(root, id);
  if (!row) {
    if (!root.items.length) text = text.replace(/^\s*\[\][ \t]*(?:#[^\r\n]*)?$/m, '');
    text += (text.endsWith(eol) || !text ? '' : eol) + `- id: ${id}${eol}`;
    row = findRow(parseLiteral(text), id);
  }
  let node = row;
  for (let i = 0; i < parts.length; i++) {
    if (node.type !== 'map' || node.fields.has('__jsExpr')) throw fail(409, 'Harness config expressions or flow mappings cannot be safely merged');
    const key = parts[i], next = node.fields.get(key), last = i === parts.length - 1;
    if (last) {
      const rendered = renderField(key, value, node.indent, eol);
      if (next) return text.slice(0, next.entryStart) + rendered + text.slice(next.end);
      return text.slice(0, node.end) + (text.slice(0, node.end).endsWith(eol) ? '' : eol) + rendered + text.slice(node.end);
    }
    if (!next || next.type === 'empty-map') {
      let rendered = ' '.repeat(node.indent) + key + ':' + eol;
      let indent = node.indent + 2;
      for (const inner of parts.slice(i + 1, -1)) { rendered += ' '.repeat(indent) + inner + ':' + eol; indent += 2; }
      rendered += renderField(parts.at(-1), value, indent, eol);
      if (next) return text.slice(0, next.entryStart) + rendered + text.slice(next.end);
      return text.slice(0, node.end) + (text.slice(0, node.end).endsWith(eol) ? '' : eol) + rendered + text.slice(node.end);
    }
    if (next.type !== 'map') throw fail(409, 'Harness config expressions or flow mappings cannot be safely merged');
    node = next;
  }
  return text;
}
function defaultCredentialPath(profilePath) {
  const parent = path.dirname(profilePath), profileRoot = path.dirname(parent);
  return path.join(path.basename(profileRoot) === 'profiles' ? path.dirname(profileRoot) : parent, '.credentials.yaml');
}
function credentialPath(profileText, profilePath) {
  const row = findRow(parseLiteral(profileText), 'credentials');
  const config = row?.fields.get('config');
  if (config && ((config.type !== 'map' && config.type !== 'empty-map') || config.fields?.has('__jsExpr')))
    throw fail(409, 'Credential store config expression cannot be safely resolved');
  const configured = config?.fields?.get('path');
  if (!configured) {
    if (config?.fields?.has('dshHome')) throw fail(409, 'Custom credential dshHome requires an explicit literal path');
    return defaultCredentialPath(profilePath);
  }
  const file = literalValue(configured);
  if (typeof file !== 'string' || !path.isAbsolute(file) || /^[!&*]/.test(file))
    throw fail(409, 'Credential path must be a literal absolute path');
  return file;
}
function patchCredentials(text, key) {
  if (!text.trim()) return `version: 1\nrefs:\n  ${KEY_REF}: ${quote(key)}\nrecords: {}\n`;
  const root = parseLiteral(text);
  if (root.type !== 'map' || root.fields.get('version')?.type !== 'scalar' || root.fields.get('version').value !== '1')
    throw fail(409, 'Credential store must use version 1; no migration or overwrite performed');
  const refs = root.fields.get('refs'), eol = text.includes('\r\n') ? '\r\n' : '\n';
  const rendered = renderField(KEY_REF, key, 2, eol);
  if (!refs || refs.type === 'empty-map') {
    const addition = 'refs:' + eol + rendered;
    return refs ? text.slice(0, refs.entryStart) + addition + text.slice(refs.end)
      : text + (text.endsWith(eol) ? '' : eol) + addition;
  }
  if (refs.type !== 'map') throw fail(409, 'Credential refs must be a literal mapping');
  const old = refs.fields.get(KEY_REF);
  if (old) return text.slice(0, old.entryStart) + renderField(KEY_REF, key, refs.indent, eol) + text.slice(old.end);
  return text.slice(0, refs.end) + (text.slice(0, refs.end).endsWith(eol) ? '' : eol) + renderField(KEY_REF, key, refs.indent, eol) + text.slice(refs.end);
}

function publicLiteral(node, hint = '', depth = 0) {
  if (!node) return null;
  if (depth > 6) return '(bounded value)';
  if (/(?:api.?key|token|secret|password|authorization|headers)/i.test(hint) && hint !== 'apiKeyEnv') return '(redacted)';
  if (node.type === 'empty-map') return {};
  if (node.type === 'map') {
    if (node.fields.has('__jsExpr')) return '(expression; not evaluated)';
    return Object.fromEntries([...node.fields].slice(0, 128).map(([key, value]) => [key, publicLiteral(value, key, depth + 1)]));
  }
  if (node.type === 'seq') return node.items.slice(0, 128).map(value => publicLiteral(value, hint, depth + 1));
  if (typeof node.value !== 'string' || /^!|^[|>]/.test(node.value)) return '(complex literal; not evaluated)';
  if (hint === 'apiKeyEnv') {
    const value = literalValue(node);
    return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(value) ? value : '(redacted reference)';
  }
  let value;
  try { value = JSON.parse(node.value); } catch { value = literalValue(node); }
  if (typeof value === 'string') {
    if (/^https?:\/\//.test(value)) {
      try { const url = new URL(value); return (url.origin + url.pathname).slice(0, 512); } catch { return '(invalid URL)'; }
    }
    return value.slice(0, 512);
  }
  if (value === null || ['boolean', 'number'].includes(typeof value)) return value;
  // Flow values are opaque in this parser. Do not reflect their nested source fields.
  return '(flow literal; preserved)';
}

function createHarnessConfig({ profilePath, routerURL, routerToken }) {
  function plan(state, aliases) {
    const source = readPrivateFile(profilePath), file = credentialPath(source.text, profilePath), credential = readPrivateFile(file);
    if (credential.exists && (credential.mode & 0o077)) throw fail(403, 'Harness credential file must be private (chmod 600)');
    if (typeof routerToken !== 'string' || !routerToken || /[\u0000-\u001f\u007f]/.test(routerToken))
      throw fail(400, 'A private router credential is required to connect Harness');
    if (file === profilePath) throw fail(409, 'Profile and credential paths must be different files');
    const root = parseLiteral(source.text);
    for (const [id, name] of [['llm-pi-ai', '@deepseek-ai/dsh-llm-pi-ai'],
      ['agent-default-model', '@deepseek-ai/dsh-agent-default-model'],
      ['subagent-model-selection-settings', '@deepseek-ai/dsh-tool-subagent/model-selection-settings'],
      ['credentials', '@deepseek-ai/dsh-credentials-local']]) {
      const row = findRow(root, id), moduleName = row?.fields.get('name');
      if (!row && id !== 'credentials')
        throw fail(409, `Harness profile is missing the ${id} row; verify the native composition and its existing overrides before connecting`);
      if (moduleName && literalValue(moduleName) !== name)
        throw fail(409, 'Managed Harness row belongs to an unexpected plugin; no changes made');
      if (row?.fields.has('disabled') && !['false', false].includes(literalValue(row.fields.get('disabled'))))
        throw fail(409, 'Managed Harness row is disabled or conditional; no changes made');
    }
    const existing = findRow(root, 'llm-pi-ai')?.fields.get('config')?.fields?.get('providers')?.fields?.get(PROVIDER);
    if (existing) {
      if (existing.type !== 'map' || literalValue(existing.fields.get('apiKeyEnv')) !== KEY_REF)
        throw fail(409, 'Harness provider key is already used by another configuration');
      const expectedKeys = ['displayName', 'api', 'baseURL', 'apiKeyEnv', 'models'];
      if ([...existing.fields.keys()].some(key => !expectedKeys.includes(key)))
        throw fail(409, 'Harness provider contains foreign fields; refusing to override their behavior');
    }
    const modelIds = [aliases.main, ...aliases.pool.map(p => p.alias)];
    const values = [
      ['llm-pi-ai', ['config', 'providers', PROVIDER, 'displayName'], 'Mixrouter Harness'],
      ['llm-pi-ai', ['config', 'providers', PROVIDER, 'api'], 'anthropic-messages'],
      ['llm-pi-ai', ['config', 'providers', PROVIDER, 'baseURL'], routerURL + '/harness'],
      ['llm-pi-ai', ['config', 'providers', PROVIDER, 'apiKeyEnv'], KEY_REF],
      // Alias branding is not capability evidence. Unverified routes declare text input only.
      ['llm-pi-ai', ['config', 'providers', PROVIDER, 'models'], modelIds.map(id => ({ id, name: id, input: ['text'] }))],
      ['agent-default-model', ['config', 'provider'], PROVIDER],
      ['agent-default-model', ['config', 'model'], aliases.main],
      ['subagent-model-selection-settings', ['config', 'enabled'], true],
      ['subagent-model-selection-settings', ['config', 'allowedModels'], aliases.pool.map(p => ({ provider: PROVIDER, model: p.alias }))],
    ];
    let text = source.text;
    for (const [id, parts, value] of values) text = patchField(text, id, parts, value);
    parseLiteral(text);
    const credentialText = patchCredentials(credential.text, routerToken);
    return { source, credential, file, text, credentialText,
      revision: fingerprint(JSON.stringify([source.revision, file, credential.revision])),
      changes: values.map(([id, parts, value]) => {
        let node = findRow(root, id);
        for (const part of parts) node = node?.type === 'map' ? node.fields.get(part) : undefined;
        return { field: id + '.' + parts.join('.'), before: publicLiteral(node, parts.at(-1)), after: value };
      }),
    };
  }
  function inspect(state, aliases) {
    const client = { status: 'not-connected', profile_path: profilePath,
      coverage: 'ordinary-subagent-explicit-selection', pool_updates: 'new-sessions', verification: 'configuration-only' };
    try {
      const source = readPrivateFile(profilePath);
      if (!source.exists) return { ...client, status: 'missing' };
      if (!state.main) { parseLiteral(source.text); return client; }
      const current = plan(state, aliases);
      return { ...client, status: current.text === source.text && current.credentialText === current.credential.text ? 'connected' : 'needs-connect' };
    } catch (error) { return { ...client, status: 'conflict', message: error.statusCode ? error.message : 'Cannot safely inspect Harness profile' }; }
  }
  function preview(state, aliases) {
    const current = plan(state, aliases);
    return { profile_revision: current.revision, changes: current.changes,
      client: inspect(state, aliases), credential: { configured: true, storage: 'private-reference' },
      warnings: ['Only ordinary subagents choosing an explicit model are covered; fork/team defaults inherit the main route and workflows may use explicit routes.',
        'Pool policy updates apply to new sessions. No restart is performed.',
        'Connection status checks configuration files only; it does not verify plugin loading or higher-priority native patch layers.'] };
  }
  function connect(state, aliases, expected) {
    const current = plan(state, aliases);
    if (typeof expected !== 'string' || expected !== current.revision)
      throw fail(409, 'Harness profile or credentials changed after preview; preview again');
    // Match the native credential writer's lock spelling, refusing contention instead of stealing locks.
    const files = [profilePath, current.file].sort(), locks = [], backups = {};
    try {
      for (const file of files) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try {
          const lock = file + '.lock', fd = fs.openSync(lock, 'wx', 0o600);
          fs.writeFileSync(fd, process.pid + '\n'); fs.closeSync(fd); locks.push(lock);
        } catch { throw fail(409, 'Harness configuration is being written by another process; retry after preview'); }
      }
      if (plan(state, aliases).revision !== expected) throw fail(409, 'Harness configuration changed during connection; no changes made');
      for (const [file, source] of [[profilePath, current.source], [current.file, current.credential]]) {
        if (!source.exists) continue;
        const backup = file + '.bak-mixrouter-' + uniqueSuffix();
        const fd = fs.openSync(backup, 'wx', 0o600);
        try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, source.text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        backups[file === profilePath ? 'profile' : 'credentials'] = backup;
      }
      try {
        writeFileAtomic(current.file, current.credentialText, { mode: 0o600 });
        writeFileAtomic(profilePath, current.text, { mode: 0o600 });
      } catch {
        // Credential may already be committed. Roll it back only if it is still our exact write.
        const now = readPrivateFile(current.file);
        if (now.text === current.credentialText) {
          if (current.credential.exists) writeFileAtomic(current.file, current.credential.text, { mode: 0o600 });
          else fs.unlinkSync(current.file);
        }
        throw fail(500, 'Harness connection write failed; check the private backups before retrying');
      }
      return { backup: backups, changes: current.changes };
    } finally { for (const lock of locks.reverse()) { try { fs.unlinkSync(lock); } catch {} } }
  }
  return { inspect, preview, connect };
}

module.exports = { createHarnessConfig, readPrivateFile, fingerprint, parseLiteral, patchField, patchCredentials, PROVIDER, KEY_REF };
