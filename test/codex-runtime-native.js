'use strict';
// Optional installed-client check. All model requests go to a local fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { connectCodex } = require('../lib/clients/codex-runtime');
const { createApplication } = require('../lib/application');

async function main() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'mixr-native-')));
  const socket = path.join(home, 'app-server-control', 'app-server-control.sock');
  fs.mkdirSync(path.dirname(socket));
  const hits = [];
  let releaseResponse, holdNext = false;
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (!req.url.endsWith('/responses')) { res.writeHead(404).end(); return; }
    const body = JSON.parse(raw);
    hits.push(body);
    if (holdNext) {
      holdNext = false;
      await new Promise(resolve => { releaseResponse = resolve; });
    }
    const message = { id: 'msg_' + hits.length, type: 'message', role: 'assistant',
      status: 'completed', content: [{ type: 'output_text', text: 'LOCAL_OK', annotations: [] }] };
    const response = { id: 'resp_' + hits.length, object: 'response', status: 'completed',
      model: body.model, output: [message], usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    event('response.created', { response: { ...response, status: 'in_progress', output: [] } });
    event('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
    event('response.output_text.delta', { output_index: 0, content_index: 0, item_id: message.id, delta: 'LOCAL_OK' });
    event('response.output_item.done', { output_index: 0, item: message });
    event('response.completed', { response });
    res.end();
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const configFile = path.join(home, 'config.toml');
  fs.writeFileSync(configFile, `model = "gpt-5.4"\nmodel_provider = "fixture"\nmodel_reasoning_effort = "low"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.fixture]\nname = "Local test"\nbase_url = "http://127.0.0.1:${upstream.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nexperimental_bearer_token = "fixture"\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
  const child = spawn('codex', ['--no-daemon', 'app-server', '--listen', 'unix://' + socket], {
    cwd: home, env: { ...process.env, CODEX_HOME: home, HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '', client, consoleServer;
  child.stderr.on('data', data => { stderr += data; });
  const closed = once(child, 'close');
  const timeout = setTimeout(() => child.kill('SIGTERM'), 40000);
  try {
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(socket)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('Codex startup failed: ' + stderr.slice(-1500));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const notifications = [];
    client = await connectCodex(socket, { onNotification: message => notifications.push(message) });
    const application = createApplication({ root: path.resolve(__dirname, '..'), version: 'test', home,
      env: { MIXR_DATA_DIR: path.join(home, 'router'), MIXR_CODEX_CONFIG: configFile,
        MIXROUTER_PORT: '0', MIXUI_PORT: '0' } });
    consoleServer = await application.listen(0, application.apiHandler);
    const changeModel = async model => {
      const response = await fetch(`http://127.0.0.1:${consoleServer.address().port}/api/codex/config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'direct_models', model, revision: application.liveState().codex.revision }),
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.codex.model, model);
      return result.runtime;
    };
    const started = await client.request('thread/start', { cwd: home, model: 'gpt-5.4', modelProvider: 'fixture',
      approvalPolicy: 'never', sandbox: 'read-only' });
    const threadId = started.thread.id;
    const waitTurn = async turnId => {
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        const latest = notifications.find(message => message.method === 'turn/completed'
          && message.params?.turn?.id === turnId)?.params.turn;
        if (latest?.status === 'completed') return latest;
        if (latest?.status === 'failed') throw new Error(JSON.stringify(latest.error));
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Local model turn timed out: ' + stderr.slice(-1000));
    };
    const turn = async text => {
      const result = await client.request('turn/start', { threadId, input: [{ type: 'text', text }] });
      return waitTurn(result.turn.id);
    };
    await turn('Remember MIXR_HOT_7319. Reply LOCAL_OK. Do not use tools.');
    assert.equal(hits.at(-1).model, 'gpt-5.4');
    const result = await changeModel('gpt-5.3-codex');
    assert.equal(result.status, 'applied', JSON.stringify(result));
    await turn('Reply LOCAL_OK again. Do not use tools.');
    assert.ok(notifications.some(message => message.method === 'thread/settings/updated'
      && message.params?.threadId === threadId
      && message.params.threadSettings?.model === 'gpt-5.3-codex'),
    'the original client connection must receive the new model settings');
    assert.equal(hits.at(-1).model, 'gpt-5.3-codex');
    assert.match(JSON.stringify(hits.at(-1).input), /MIXR_HOT_7319/, 'same thread must retain its earlier input');
    assert.equal(hits.at(-1).reasoning.effort, hits[0].reasoning.effort);
    holdNext = true;
    const active = await client.request('turn/start', { threadId, input: [{ type: 'text', text: 'HOLD_FOR_SWITCH. Reply LOCAL_OK.' }] });
    const holdDeadline = Date.now() + 10000;
    while (!releaseResponse) {
      if (Date.now() > holdDeadline) throw new Error('Active turn did not reach local upstream');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const second = await changeModel('gpt-5.4');
    assert.equal(second.status, 'applied');
    releaseResponse();
    await waitTurn(active.turn.id);
    releaseResponse = null;
    await turn('Final LOCAL_OK. Do not use tools.');
    assert.equal(hits.at(-1).model, 'gpt-5.4');
    console.log(JSON.stringify({ ok: true, fixture: 'installed Codex / local upstream',
      models: hits.map(hit => hit.model), sameThread: true, contextRetained: true,
      activeTurnPreserved: true, effortPreserved: true, clientNotified: true }));
  } catch (error) {
    error.message += '\n' + stderr.slice(-2000);
    throw error;
  } finally {
    clearTimeout(timeout);
    releaseResponse?.();
    client?.close();
    if (consoleServer) {
      consoleServer.closeAllConnections();
      await new Promise(resolve => consoleServer.close(resolve));
    }
    child.kill('SIGTERM');
    await closed;
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
